import { Injectable } from '@nestjs/common';
import type { CompareNode, ComparisonOp, SegmentRule } from '@drift/shared';
import { CustomerMetrics } from './metrics.service';

// Pure function service: takes a rule + one customer's metrics + the current
// memberships of any parent segments referenced by `in_segment` predicates,
// returns "is this customer in the segment". No DB access, no async, no
// side effects — every input is explicit, output depends only on inputs.
//
// All I/O (loading metrics, loading parent memberships, persisting deltas)
// lives in the orchestrator that calls this. Keeping the evaluator pure
// means it's trivially unit-testable and fast to call in a tight loop.
@Injectable()
export class EvaluatorService {
  /**
   * @param rule              the segment's rule tree (from Segment.rule JSONB)
   * @param metrics           this customer's pre-computed metrics
   * @param parentMemberships map keyed by segmentId → Set<customerId> for every
   *                          segment referenced by an `in_segment` node anywhere
   *                          in `rule`. The orchestrator must pre-load these.
   * @param customerId        the customer being evaluated (used for in_segment lookup)
   */
  evaluate(
    rule: SegmentRule,
    metrics: CustomerMetrics,
    parentMemberships: Map<string, Set<string>>,
    customerId: string,
  ): boolean {
    switch (rule.kind) {
      case 'compare':
        return this.evaluateCompare(rule, metrics);

      case 'in_segment': {
        const members = parentMemberships.get(rule.segmentId);
        if (!members) {
          // The orchestrator failed to pre-load a parent segment that this
          // rule references. That's a programming error, not a runtime case
          // worth recovering from — fail loudly so we notice in development.
          throw new Error(
            `evaluator: in_segment references ${rule.segmentId} but no membership was loaded`,
          );
        }
        return members.has(customerId);
      }

      case 'and':
        // every() short-circuits on the first false, matching AND semantics.
        return rule.children.every((child) =>
          this.evaluate(child, metrics, parentMemberships, customerId),
        );

      default: {
        // Exhaustiveness: if a new node kind is added to SegmentRule, the
        // type narrowing here breaks and the compiler refuses this file
        // until the new case is handled above.
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  }

  private evaluateCompare(node: CompareNode, metrics: CustomerMetrics): boolean {
    const left = metrics[node.metric];
    return this.applyOp(left, node.op, node.value);
  }

  private applyOp(left: number, op: ComparisonOp, right: number): boolean {
    switch (op) {
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      default: {
        const _exhaustive: never = op;
        return _exhaustive;
      }
    }
  }
}
