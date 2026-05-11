import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma, SegmentType } from '@prisma/client';
import type {
  ComparisonOp,
  CustomerMetric,
  SegmentRule,
} from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DependencyService } from './dependency.service';
import { MetricsService } from './metrics.service';
import { SegmentEvaluationService } from './segment-evaluation.service';

interface EvaluateBody {
  // Required only for STATIC segments — guards against accidental refresh.
  force?: boolean;
}

interface CreateSegmentBody {
  name: string;
  description?: string | null;
  type: SegmentType;
  rule: unknown;
  // Only meaningful for STATIC segments — pre-populates membership at create
  // time. Ignored for DYNAMIC (the orchestrator computes membership from
  // the rule).
  initialMemberIds?: string[];
}

interface UpdateSegmentBody {
  name?: string;
  description?: string | null;
  rule?: unknown;
}

// Allowed metric values — kept in sync with the @drift/shared union via the
// `satisfies` check below. If a new metric is added to the shared type, this
// array MUST be updated or the satisfies clause will refuse to compile.
const VALID_METRICS = [
  'tx_count_30d',
  'tx_count_total',
  'sum_amount_60d',
  'last_tx_age_days',
] as const satisfies readonly CustomerMetric[];

const VALID_OPS = [
  '>',
  '>=',
  '<',
  '<=',
  '==',
  '!=',
] as const satisfies readonly ComparisonOp[];

@Controller('segments')
export class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly evaluation: SegmentEvaluationService,
    private readonly dependency: DependencyService,
  ) {}

  // Validates a rule object against the SegmentRule discriminated union.
  // Returns a typed SegmentRule on success; throws BadRequestException with
  // a path-prefixed message on failure so the client can point at the bad
  // node. We don't reach for Zod here — the union is small and recursion
  // is cleaner expressed inline.
  private validateRule(input: unknown, path = 'rule', depth = 0): SegmentRule {
    if (depth > 32) {
      throw new BadRequestException(`${path}: nesting depth exceeds 32 levels`);
    }
    if (!input || typeof input !== 'object') {
      throw new BadRequestException(`${path}: must be an object`);
    }
    const node = input as Record<string, unknown>;
    switch (node.kind) {
      case 'compare': {
        if (!VALID_METRICS.includes(node.metric as CustomerMetric)) {
          throw new BadRequestException(
            `${path}.metric: must be one of ${VALID_METRICS.join(', ')}`,
          );
        }
        if (!VALID_OPS.includes(node.op as ComparisonOp)) {
          throw new BadRequestException(
            `${path}.op: must be one of ${VALID_OPS.join(', ')}`,
          );
        }
        if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
          throw new BadRequestException(`${path}.value: must be a finite number`);
        }
        return {
          kind: 'compare',
          metric: node.metric as CustomerMetric,
          op: node.op as ComparisonOp,
          value: node.value,
        };
      }
      case 'in_segment': {
        if (typeof node.segmentId !== 'string' || !node.segmentId.length) {
          throw new BadRequestException(
            `${path}.segmentId: must be a non-empty string`,
          );
        }
        return { kind: 'in_segment', segmentId: node.segmentId };
      }
      case 'and': {
        if (!Array.isArray(node.children) || node.children.length === 0) {
          throw new BadRequestException(
            `${path}.children: must be a non-empty array`,
          );
        }
        const children = node.children.map((c, i) =>
          this.validateRule(c, `${path}.children[${i}]`, depth + 1),
        );
        return { kind: 'and', children };
      }
      default:
        throw new BadRequestException(
          `${path}.kind: must be 'compare' | 'in_segment' | 'and' (got ${JSON.stringify(node.kind)})`,
        );
    }
  }

  // Verifies that every segment referenced via in_segment actually exists
  // and that the rule doesn't self-reference (which would cause infinite
  // cascade). Called from create and update before persisting the rule.
  private async assertRuleReferences(
    rule: SegmentRule,
    selfId: string | null,
  ): Promise<void> {
    const refs = [...this.dependency.collectParentIds(rule)];
    if (selfId !== null && refs.includes(selfId)) {
      throw new BadRequestException(
        'rule cannot reference itself — would cascade infinitely',
      );
    }
    if (refs.length === 0) return;
    const found = await this.prisma.segment.findMany({
      where: { id: { in: refs } },
      select: { id: true },
    });
    const missing = refs.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `rule references unknown segments: ${missing.join(', ')}`,
      );
    }
  }

  // ── Debug / dev only ───────────────────────────────────────────────────
  // Returns metrics for the 5 named scenario customers so we can sanity-check
  // the SQL aggregate against the deterministic seed values. Will be retired
  // when we no longer need it; harmless until then.
  @Get('metrics/preview')
  async preview() {
    const named = await this.prisma.customer.findMany({
      where: { email: { endsWith: '@drift.test' } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    const all = await this.metrics.computeAll();
    return named.map((c) => ({
      name: c.name,
      email: c.email,
      metrics: all.get(c.id),
    }));
  }

  // ── Real endpoints ─────────────────────────────────────────────────────

  /**
   * Create a new segment.
   *
   * For DYNAMIC segments, the orchestrator runs the initial evaluation
   * immediately after creation: this materializes membership, writes a
   * SegmentDelta history row for every customer who matches, and emits a
   * single OutboxEvent — the same pipeline as every other change.
   *
   * For STATIC segments, the caller may provide `initialMemberIds` to
   * pre-populate membership at creation time. The rule is still stored
   * (used when the user later clicks "Refresh now").
   */
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateSegmentBody) {
    if (!body?.name || typeof body.name !== 'string') {
      throw new BadRequestException('name is required and must be a string');
    }
    if (body.type !== SegmentType.DYNAMIC && body.type !== SegmentType.STATIC) {
      throw new BadRequestException("type must be 'DYNAMIC' or 'STATIC'");
    }
    const rule = this.validateRule(body.rule);
    await this.assertRuleReferences(rule, null);

    const collision = await this.prisma.segment.findUnique({
      where: { name: body.name },
      select: { id: true },
    });
    if (collision) {
      throw new BadRequestException(`segment "${body.name}" already exists`);
    }

    const created = await this.prisma.segment.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        rule: rule as unknown as Prisma.InputJsonValue,
      },
    });

    if (created.type === SegmentType.DYNAMIC) {
      // evaluateSegment also persists SegmentDependency edges, computes
      // initial membership, and emits the outbox event for downstream
      // consumers. Wrapped to surface the orchestrator's known-error
      // shapes (e.g., dependency cycle) as 400s.
      try {
        await this.evaluation.evaluateSegment(created.id);
      } catch (err) {
        // Roll back the create so the failed segment doesn't linger.
        await this.prisma.segment.delete({ where: { id: created.id } });
        throw new BadRequestException(
          err instanceof Error ? err.message : 'evaluation failed',
        );
      }
    } else if (body.initialMemberIds && body.initialMemberIds.length > 0) {
      // Pre-populate STATIC segments with the caller-supplied list. We
      // tolerate duplicates (skipDuplicates) so the caller can retry
      // safely if the request half-failed.
      await this.prisma.segmentMember.createMany({
        data: body.initialMemberIds.map((customerId) => ({
          segmentId: created.id,
          customerId,
        })),
        skipDuplicates: true,
      });
    }

    return this.detail(created.id);
  }

  /**
   * Update an existing segment's name, description, or rule. Changing the
   * `type` is forbidden — that's not a metadata edit, it's a different
   * segment entirely, and supporting it cleanly means migrating
   * membership semantics in non-obvious ways.
   *
   * When the rule changes for a DYNAMIC segment, we re-evaluate
   * immediately so the materialized membership doesn't drift from the
   * new rule's intent.
   */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateSegmentBody) {
    const existing = await this.prisma.segment.findUnique({ where: { id } });
    if (!existing) {
      throw new BadRequestException(`segment ${id} not found`);
    }

    const patch: Prisma.SegmentUpdateInput = {};
    let ruleChanged = false;

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name) {
        throw new BadRequestException('name must be a non-empty string');
      }
      if (body.name !== existing.name) {
        const collision = await this.prisma.segment.findUnique({
          where: { name: body.name },
          select: { id: true },
        });
        if (collision) {
          throw new BadRequestException(
            `segment "${body.name}" already exists`,
          );
        }
      }
      patch.name = body.name;
    }
    if (body.description !== undefined) {
      patch.description = body.description;
    }
    if (body.rule !== undefined) {
      const rule = this.validateRule(body.rule);
      await this.assertRuleReferences(rule, id);
      patch.rule = rule as unknown as Prisma.InputJsonValue;
      ruleChanged = true;
    }

    const updated = await this.prisma.segment.update({
      where: { id },
      data: patch,
    });

    // Rule change on a dynamic segment must trigger re-evaluation so the
    // materialized membership reflects the new intent. STATIC segments
    // intentionally don't auto-recompute — the user must hit refresh.
    if (ruleChanged && updated.type === SegmentType.DYNAMIC) {
      await this.evaluation.evaluateSegment(updated.id);
    }

    return this.detail(updated.id);
  }

  /**
   * Delete a segment.
   *
   * Blocked if any other segment references this one via `in_segment` —
   * deleting a parent under live dependents would silently orphan their
   * cascade graph. The error message names the dependents so the caller
   * can fix the rules first.
   *
   * Schema-level ON DELETE CASCADE handles SegmentMember, SegmentDelta,
   * and SegmentDependency rows where this segment is the *child*.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.segment.findUnique({ where: { id } });
    if (!existing) {
      throw new BadRequestException(`segment ${id} not found`);
    }

    const dependents = await this.prisma.segmentDependency.findMany({
      where: { parentId: id },
      include: { child: { select: { name: true } } },
    });
    if (dependents.length > 0) {
      const names = dependents.map((d) => `"${d.child.name}"`).join(', ');
      throw new BadRequestException(
        `cannot delete "${existing.name}": ${dependents.length} segment(s) depend on it (${names}). Remove or modify those segments first.`,
      );
    }

    await this.prisma.segment.delete({ where: { id } });
  }

  /**
   * List all segments with their current member counts. Used by the UI's
   * segment list page. Member count is materialized via SegmentMember.count
   * — cheap because of the (segmentId, customerId) PK index.
   */
  @Get()
  async list() {
    const segments = await this.prisma.segment.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return segments.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      memberCount: s._count.members,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Single segment detail with the full rule (so the UI can render it) and
   * current member count.
   */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const s = await this.prisma.segment.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      rule: s.rule,
      memberCount: s._count.members,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  /**
   * Current member list for a segment. Paginated because a segment can hold
   * thousands of customers; we don't want to ship the whole list to the UI
   * at once. The list page is read-only — sorted by customer name for a
   * deterministic display.
   */
  @Get(':id/members')
  async members(
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetRaw ?? '0', 10) || 0, 0);

    const [total, rows] = await Promise.all([
      this.prisma.segmentMember.count({ where: { segmentId: id } }),
      this.prisma.segmentMember.findMany({
        where: { segmentId: id },
        orderBy: { customer: { name: 'asc' } },
        skip: offset,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset,
      members: rows.map((r) => ({
        customerId: r.customer.id,
        name: r.customer.name,
        email: r.customer.email,
        joinedAt: r.joinedAt,
      })),
    };
  }

  /**
   * Recent delta history for a segment. Backs the segment-detail "what just
   * changed" feed. Customer name joined for human-readable display.
   */
  @Get(':id/deltas')
  async deltas(
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);
    const rows = await this.prisma.segmentDelta.findMany({
      where: { segmentId: id },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      include: { customer: { select: { name: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: r.customer.name,
      change: r.change,
      batchId: r.batchId,
      occurredAt: r.occurredAt,
    }));
  }

  /**
   * Recompute one segment's membership and emit a delta. The body is
   * optional; pass `{ force: true }` only to refresh a STATIC segment.
   */
  @Post(':id/evaluate')
  @HttpCode(200)
  async evaluate(@Param('id') id: string, @Body() body: EvaluateBody = {}) {
    try {
      return await this.evaluation.evaluateSegment(id, { force: body.force });
    } catch (err) {
      // Map the orchestrator's "STATIC without force" guard to a 400 so it's
      // distinguishable from an unexpected 500.
      if (err instanceof Error && err.message.includes('STATIC')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * Initial population (and disaster-recovery rebuild). Walks every dynamic
   * segment in topological order and evaluates each. Static segments are
   * skipped — their membership is owned by the caller, not the rules.
   */
  @Post('rebuild')
  @HttpCode(200)
  async rebuild() {
    const results = await this.evaluation.rebuildAllDynamic();
    return {
      evaluatedCount: results.length,
      segments: results.map((r) => ({
        name: r.segmentName,
        added: r.added.length,
        removed: r.removed.length,
        totalMembers: r.totalMembers,
      })),
    };
  }
}
