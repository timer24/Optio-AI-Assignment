import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// The numbers a SegmentRule's `compare` predicates can be evaluated against.
// One record per customer; populated by computeAll() in a single SQL pass.
//
// Keep this shape aligned with the CustomerMetric union in @drift/shared —
// every metric the rule schema references must have a field here.
export interface CustomerMetrics {
  tx_count_30d: number;
  tx_count_total: number;
  sum_amount_60d: number;
  // Days since most recent transaction. `Infinity` for customers with no
  // transactions — comparisons against numeric thresholds (e.g., > 90) work
  // naturally without null-handling in the rule evaluator.
  last_tx_age_days: number;
}

// Internal: shape returned by the raw SQL query. Decimal/bigint columns come
// back as bigint or string from pg — we coerce to number in TS.
interface MetricsRow {
  id: string;
  tx_count_30d: bigint;
  tx_count_total: bigint;
  sum_amount_60d: string | null;
  last_tx_age_days: string | null;
}

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute all rule-relevant metrics for every customer in one query.
   *
   * Postgres's FILTER (WHERE ...) clause does conditional aggregation within
   * a single GROUP BY — much faster than four separate aggregate queries or
   * N+1 per-customer computation. LEFT JOIN ensures customers with zero
   * transactions still appear (with zeros for counts/sums and Infinity for
   * last_tx_age_days).
   */
  async computeAll(): Promise<Map<string, CustomerMetrics>> {
    const rows = await this.prisma.$queryRaw<MetricsRow[]>`
      SELECT
        c.id,
        COUNT(t.id) FILTER (WHERE t."occurredAt" >= NOW() - INTERVAL '30 days')::bigint
          AS tx_count_30d,
        COUNT(t.id)::bigint
          AS tx_count_total,
        COALESCE(SUM(t.amount) FILTER (WHERE t."occurredAt" >= NOW() - INTERVAL '60 days'), 0)::text
          AS sum_amount_60d,
        CASE
          WHEN MAX(t."occurredAt") IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM (NOW() - MAX(t."occurredAt"))) / 86400)::text
        END
          AS last_tx_age_days
      FROM "Customer" c
      LEFT JOIN "Transaction" t ON t."customerId" = c.id
      GROUP BY c.id
    `;

    const result = new Map<string, CustomerMetrics>();
    for (const row of rows) {
      result.set(row.id, {
        tx_count_30d: Number(row.tx_count_30d),
        tx_count_total: Number(row.tx_count_total),
        sum_amount_60d: row.sum_amount_60d === null ? 0 : Number(row.sum_amount_60d),
        last_tx_age_days:
          row.last_tx_age_days === null ? Infinity : Number(row.last_tx_age_days),
      });
    }
    return result;
  }
}
