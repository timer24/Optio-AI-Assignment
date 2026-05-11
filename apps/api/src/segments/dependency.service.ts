import { Injectable } from '@nestjs/common';
import type { SegmentRule } from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';

// Materializes the cascade graph. When a segment's rule is saved (or seeded),
// we walk the rule tree, collect every `in_segment.segmentId`, and write one
// SegmentDependency row per parent. Subsequent rule changes replace the
// previous edges atomically.
//
// Keeping this materialized — rather than parsing every segment's rule at
// cascade time — means the cascade lookup ("who depends on me?") becomes a
// single indexed query against SegmentDependency.parentId.
@Injectable()
export class DependencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Walks a rule tree and returns the set of segment IDs it references via
   * `in_segment` predicates anywhere in the tree (deduplicated). Pure
   * function — exposed for tests and for the orchestrator to reason about
   * a rule's parents without committing to the DB.
   */
  collectParentIds(rule: SegmentRule, acc: Set<string> = new Set()): Set<string> {
    switch (rule.kind) {
      case 'compare':
        return acc;
      case 'in_segment':
        acc.add(rule.segmentId);
        return acc;
      case 'and':
        for (const child of rule.children) {
          this.collectParentIds(child, acc);
        }
        return acc;
      default: {
        // Same exhaustiveness guard as the evaluator: adding a new node kind
        // forces this file to handle it.
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  }

  /**
   * Replace this segment's incoming dependency edges to match the new rule.
   * Idempotent: calling twice with the same rule produces the same edges.
   * Atomic: delete + insert run in one transaction so a partial failure can't
   * leave the segment with no edges when it should have some.
   */
  async replaceDependencies(segmentId: string, rule: SegmentRule): Promise<void> {
    const parentIds = [...this.collectParentIds(rule)];

    if (parentIds.includes(segmentId)) {
      // A self-reference would cascade infinitely on every change. The rule
      // schema doesn't prevent it structurally, so we guard here.
      throw new Error(
        `dependency: segment ${segmentId} has a self-referential in_segment rule`,
      );
    }

    // Compute the desired set of edges OUTSIDE the transaction. Then inside
    // the transaction, only delete edges no longer needed and insert the
    // newly-needed ones — both operations tolerate concurrent writes.
    //
    // This used to be a blunt deleteMany + createMany, which raced under
    // concurrent cascade re-evaluations of the same child segment: T1 and
    // T2 both delete (no-op for T2 because T1's commit isn't visible yet),
    // both insert, second insert hits the (parentId, childId) PK conflict.
    // `skipDuplicates: true` makes the insert idempotent under that race.
    await this.prisma.$transaction(async (tx) => {
      // Drop edges that are no longer referenced by the current rule.
      if (parentIds.length === 0) {
        await tx.segmentDependency.deleteMany({
          where: { childId: segmentId },
        });
      } else {
        await tx.segmentDependency.deleteMany({
          where: { childId: segmentId, parentId: { notIn: parentIds } },
        });
        // Idempotent insert: a concurrent transaction that already wrote
        // (parentId, segmentId) won't make us crash.
        await tx.segmentDependency.createMany({
          data: parentIds.map((parentId) => ({ parentId, childId: segmentId })),
          skipDuplicates: true,
        });
      }
    });
  }
}
