import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Segment, SegmentType } from '@prisma/client';
import type { SegmentDeltaPayload, SegmentRule } from '@drift/shared';
import { EventTypes } from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DependencyService } from './dependency.service';
import { EvaluatorService } from './evaluator.service';
import { MetricsService } from './metrics.service';

// Public result of one evaluation pass.
export interface EvaluationResult {
  segmentId: string;
  segmentName: string;
  batchId: string;
  added: string[];
  removed: string[];
  totalMembers: number;
}

export interface EvaluateOptions {
  // Static segments only re-evaluate if force=true (manual refresh).
  force?: boolean;
}

// Orchestrates one or more segment evaluation passes. Coordinates the
// dependency extractor, metric computation, rule evaluator, and persistence
// so callers (HTTP endpoint, RabbitMQ consumer on Day 3, initial population)
// share one consistent code path.
@Injectable()
export class SegmentEvaluationService {
  private readonly logger = new Logger(SegmentEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly evaluator: EvaluatorService,
    private readonly dependency: DependencyService,
  ) {}

  /**
   * Recompute one segment's membership end-to-end:
   *   1. Persist its dependency edges (idempotent).
   *   2. Pre-load metrics + parent memberships.
   *   3. Evaluate the rule for every customer.
   *   4. Diff against current SegmentMember → added / removed.
   *   5. Apply the change atomically and write SegmentDelta rows.
   */
  async evaluateSegment(
    segmentId: string,
    options: EvaluateOptions = {},
  ): Promise<EvaluationResult> {
    const segment = await this.prisma.segment.findUniqueOrThrow({
      where: { id: segmentId },
    });

    if (segment.type === SegmentType.STATIC && !options.force) {
      throw new Error(
        `evaluation: segment ${segment.name} is STATIC; pass force=true to refresh manually`,
      );
    }

    const rule = segment.rule as unknown as SegmentRule;

    // 1. Persist dependency edges.
    await this.dependency.replaceDependencies(segment.id, rule);

    // 2. Metrics for all customers (one SQL aggregate).
    const allMetrics = await this.metrics.computeAll();

    // 3. Pre-load parent memberships referenced by `in_segment` predicates.
    const parentIds = [...this.dependency.collectParentIds(rule)];
    const parentMemberships = await this.loadParentMemberships(parentIds);

    // 4. Evaluate the rule per customer.
    const newMembers = new Set<string>();
    for (const [customerId, metrics] of allMetrics) {
      if (this.evaluator.evaluate(rule, metrics, parentMemberships, customerId)) {
        newMembers.add(customerId);
      }
    }

    // 5. Diff against current membership.
    const current = await this.prisma.segmentMember.findMany({
      where: { segmentId: segment.id },
      select: { customerId: true },
    });
    const currentSet = new Set(current.map((m) => m.customerId));

    const added = [...newMembers].filter((id) => !currentSet.has(id));
    const removed = [...currentSet].filter((id) => !newMembers.has(id));

    const batchId = randomUUID();

    // 6. Persist changes atomically. The OutboxEvent insert lives inside the
    //    same transaction as the membership and delta writes so the system
    //    can never end up in a state where the DB has the change but no event
    //    will be produced (or vice versa) — the outbox pattern.
    await this.prisma.$transaction(async (tx) => {
      if (added.length > 0) {
        await tx.segmentMember.createMany({
          data: added.map((customerId) => ({ segmentId: segment.id, customerId })),
        });
      }
      if (removed.length > 0) {
        await tx.segmentMember.deleteMany({
          where: { segmentId: segment.id, customerId: { in: removed } },
        });
      }
      if (added.length + removed.length > 0) {
        await tx.segmentDelta.createMany({
          data: [
            ...added.map((customerId) => ({
              segmentId: segment.id,
              customerId,
              change: 'ADD' as const,
              batchId,
            })),
            ...removed.map((customerId) => ({
              segmentId: segment.id,
              customerId,
              change: 'REMOVE' as const,
              batchId,
            })),
          ],
        });

        // Emit the event only when there's a real change — empty deltas
        // would create unnecessary cascades and UI noise downstream.
        const payload: SegmentDeltaPayload = {
          segmentId: segment.id,
          segmentName: segment.name,
          batchId,
          added,
          removed,
        };
        await tx.outboxEvent.create({
          data: {
            eventType: EventTypes.SegmentDelta,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });

    this.logger.log(
      `evaluated ${segment.name}: +${added.length} / -${removed.length} (total ${newMembers.size})`,
    );

    return {
      segmentId: segment.id,
      segmentName: segment.name,
      batchId,
      added,
      removed,
      totalMembers: newMembers.size,
    };
  }

  /**
   * Populate every dynamic segment in topological order so parents are
   * evaluated before any segment that references them via `in_segment`.
   * Used for the initial bootstrap right after seed.
   */
  async rebuildAllDynamic(): Promise<EvaluationResult[]> {
    const segments = await this.prisma.segment.findMany({
      where: { type: SegmentType.DYNAMIC },
    });

    const ordered = this.topoSort(segments);
    const results: EvaluationResult[] = [];
    for (const segment of ordered) {
      results.push(await this.evaluateSegment(segment.id));
    }
    return results;
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async loadParentMemberships(
    parentIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    if (parentIds.length === 0) return map;

    // Single query for all parents, then bucket by segmentId in memory.
    const rows = await this.prisma.segmentMember.findMany({
      where: { segmentId: { in: parentIds } },
      select: { segmentId: true, customerId: true },
    });
    for (const id of parentIds) map.set(id, new Set());
    for (const row of rows) map.get(row.segmentId)!.add(row.customerId);
    return map;
  }

  /**
   * Kahn-ish topological sort: keep picking segments whose parents (extracted
   * from their rule) are already in the result. Any cycle surfaces as an
   * inability to make progress and we throw. For our 4 dynamic segments no
   * cycles are possible — Active VIPs depends on leaves only.
   */
  private topoSort(segments: Segment[]): Segment[] {
    const byId = new Map(segments.map((s) => [s.id, s]));
    const parentsOf = new Map<string, Set<string>>();
    for (const s of segments) {
      const rule = s.rule as unknown as SegmentRule;
      // Restrict to parents that are in this batch — external parents (e.g.,
      // a STATIC segment referenced by a dynamic one) are already populated.
      const refs = [...this.dependency.collectParentIds(rule)].filter((id) =>
        byId.has(id),
      );
      parentsOf.set(s.id, new Set(refs));
    }

    const result: Segment[] = [];
    const done = new Set<string>();

    while (result.length < segments.length) {
      const next = segments.find(
        (s) => !done.has(s.id) && [...parentsOf.get(s.id)!].every((p) => done.has(p)),
      );
      if (!next) {
        const remaining = segments.filter((s) => !done.has(s.id)).map((s) => s.name);
        throw new Error(
          `evaluation: dependency cycle or unresolvable order among segments: ${remaining.join(', ')}`,
        );
      }
      result.push(next);
      done.add(next.id);
    }

    return result;
  }
}
