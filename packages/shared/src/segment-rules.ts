// Segment rule schema — a tree of predicate nodes that, evaluated against a
// customer, returns true (member) or false (not a member). Stored in
// Postgres as JSONB on Segment.rule, read back here so the evaluator (Day 2)
// and the UI (Day 4) speak the same shape.

// Customer-level metrics the evaluator knows how to compute. Add a new entry
// only when a segment actually needs it — premature additions are dead code.
export type CustomerMetric =
  | 'tx_count_30d'      // number of transactions in last 30 days
  | 'tx_count_total'    // total transactions ever
  | 'sum_amount_60d'    // sum of transaction amounts in last 60 days
  | 'last_tx_age_days'; // days since most recent transaction (Infinity if none)

export type ComparisonOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

// Leaf: compare a metric against a number.
// Example: { kind: 'compare', metric: 'sum_amount_60d', op: '>', value: 5000 }
export interface CompareNode {
  kind: 'compare';
  metric: CustomerMetric;
  op: ComparisonOp;
  value: number;
}

// Leaf: customer is currently a member of another segment.
// This is the predicate that produces a SegmentDependency edge at save time.
export interface InSegmentNode {
  kind: 'in_segment';
  segmentId: string;
}

// Composite: all children must be true.
export interface AndNode {
  kind: 'and';
  children: SegmentRule[];
}

// Discriminated union over every node kind. Adding a new node type:
//   1. define its interface above
//   2. add it to this union
// TypeScript then flags every visitor (evaluator, UI renderer, dependency
// parser) that doesn't handle the new case — refactor leverage by design.
export type SegmentRule = CompareNode | InSegmentNode | AndNode;
