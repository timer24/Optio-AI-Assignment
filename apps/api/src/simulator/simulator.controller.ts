import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChangeBufferService } from '../messaging/change-buffer.service';
import { PrismaService } from '../prisma/prisma.service';

interface SimulateTransactionBody {
  customerId: string;
  amount: number;
  // ISO string. Defaults to now.
  occurredAt?: string;
}

interface SimulateProfileBody {
  customerId: string;
  // Partial profile patch — merged with existing JSONB via spread.
  profile: Record<string, unknown>;
}

interface SimulateBulkBody {
  // How many synthetic transactions to fan out across the existing customers.
  // Default 50,000 — the number stated in the assignment.
  count?: number;
  // How many rows go into one DB INSERT and one Redis SADD round-trip.
  // 1000 keeps a single statement under any reasonable parameter limit
  // while still amortizing per-call overhead.
  chunkSize?: number;
}

interface AdvanceTimeBody {
  // How many days to fast-forward. Shifting transactions back by N days is
  // mathematically identical to advancing wall-clock time by N days as far
  // as our metrics (tx_count_30d, sum_amount_60d, last_tx_age_days) are
  // concerned — and it doesn't require plumbing a virtual "now" through
  // MetricsService.
  days: number;
}

// HTTP entry points the UI (and the curl/manual tester) uses to trigger
// data changes. Every mutation here funnels into ChangeBufferService —
// that's how a single customer update ends up triggering segment
// recomputation through the same code path as a 50K-row stress test.
@Controller('simulate')
export class SimulatorController {
  private readonly logger = new Logger(SimulatorController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly buffer: ChangeBufferService,
  ) {}

  /**
   * Insert one transaction and signal the buffer. Use this from the UI to
   * watch a single customer flip in/out of segments in near-real-time.
   */
  @Post('transaction')
  @HttpCode(201)
  async simulateTransaction(@Body() body: SimulateTransactionBody) {
    if (!body.customerId || typeof body.amount !== 'number') {
      throw new BadRequestException('customerId and amount are required');
    }
    const tx = await this.prisma.transaction.create({
      data: {
        customerId: body.customerId,
        amount: new Prisma.Decimal(body.amount),
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      },
    });
    await this.buffer.markChanged(body.customerId);
    return { transactionId: tx.id, queued: true };
  }

  /**
   * Patch a customer's profile JSONB. Fetches first to merge — we don't
   * want a small {country:'GE'} update to wipe the rest of the blob.
   */
  @Post('profile-update')
  @HttpCode(200)
  async simulateProfile(@Body() body: SimulateProfileBody) {
    if (!body.customerId || !body.profile) {
      throw new BadRequestException('customerId and profile are required');
    }
    const existing = await this.prisma.customer.findUniqueOrThrow({
      where: { id: body.customerId },
      select: { profile: true },
    });
    const merged = {
      ...((existing.profile as Record<string, unknown>) ?? {}),
      ...body.profile,
    };
    await this.prisma.customer.update({
      where: { id: body.customerId },
      data: { profile: merged as Prisma.InputJsonValue },
    });
    await this.buffer.markChanged(body.customerId);
    return { queued: true };
  }

  /**
   * The 50K stress-test endpoint. Generates `count` synthetic transactions
   * spread across all existing customers, in chunks. Each chunk is one
   * `createMany` + one bulk `SADD`.
   *
   * The point isn't to write 50K rows quickly (DB throughput is what it is).
   * The point is to demonstrate that 50K change events collapse to ONE
   * segment evaluation pass via the debouncer — the mechanics are the same
   * regardless of count, and cascading still fans out through RabbitMQ.
   */
  @Post('bulk-changes')
  @HttpCode(202)
  async simulateBulk(@Body() body: SimulateBulkBody = {}) {
    const count = body.count ?? 50_000;
    const chunkSize = body.chunkSize ?? 1_000;

    if (count < 1 || count > 200_000) {
      throw new BadRequestException('count must be between 1 and 200000');
    }
    if (chunkSize < 1 || chunkSize > 5_000) {
      throw new BadRequestException('chunkSize must be between 1 and 5000');
    }

    // Pull the customer pool once. With 200 seeded customers this is a
    // ~10KB result we can keep in memory for the duration of the run.
    const customers = await this.prisma.customer.findMany({
      select: { id: true },
    });
    if (customers.length === 0) {
      throw new BadRequestException('no customers in DB — run `prisma db seed`');
    }

    const startedAt = Date.now();
    let inserted = 0;
    const now = Date.now();

    for (let offset = 0; offset < count; offset += chunkSize) {
      const size = Math.min(chunkSize, count - offset);
      const rows: Prisma.TransactionCreateManyInput[] = [];
      const touchedCustomerIds = new Set<string>();

      for (let i = 0; i < size; i++) {
        const customer = customers[Math.floor(Math.random() * customers.length)];
        // Vary amount + occurredAt across the chunk so different segment
        // rules (sum_amount_60d, tx_count_30d, last_tx_age_days) get
        // exercised, not just one of them.
        const amount = +(Math.random() * 800 + 1).toFixed(2);
        const occurredAt = new Date(
          now - Math.floor(Math.random() * 60) * 24 * 60 * 60 * 1000,
        );
        rows.push({
          customerId: customer.id,
          amount: new Prisma.Decimal(amount),
          occurredAt,
        });
        touchedCustomerIds.add(customer.id);
      }

      await this.prisma.transaction.createMany({ data: rows });
      await this.buffer.markChangedMany([...touchedCustomerIds]);
      inserted += size;
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `bulk-changes: inserted ${inserted} tx in ${durationMs}ms across ${customers.length} customers — debouncer will flush within 500ms`,
    );

    // 202 Accepted — the work to insert+buffer is done synchronously, but
    // the segment recomputation triggered by the buffer happens in the
    // background. Caller can poll segments to observe membership shifts.
    return {
      inserted,
      durationMs,
      chunkSize,
      chunks: Math.ceil(count / chunkSize),
      uniqueCustomers: customers.length,
    };
  }

  /**
   * Advance the simulated clock by N days. Implementation: shift every
   * Transaction.occurredAt back by N days, then fan-out a customer-changed
   * signal so the debouncer triggers a global recompute.
   *
   * Why shift the data, not the clock? Three reasons:
   *   1. Metrics already use `now` — shifting transactions reuses that
   *      logic without forking a "virtual now" parameter through it.
   *   2. The DB becomes the single source of truth for elapsed time.
   *   3. Reversing is just calling with negative N (or reseed).
   *
   * Surfaces the "30 days passed → customer drops out of Active Buyers"
   * scenario from the assignment, which is otherwise impossible to
   * demonstrate without waiting 30 actual days.
   */
  @Post('advance-time')
  @HttpCode(202)
  async advanceTime(@Body() body: AdvanceTimeBody) {
    const days = Number(body?.days);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw new BadRequestException('days must be between 1 and 365');
    }

    const intervalLiteral = `${Math.floor(days)} days`;
    // Raw SQL because a Prisma updateMany with a column-relative date update
    // requires Prisma.sql template. We keep the days value safely as a
    // parameterized integer and concatenate the unit as a literal we control.
    const result = await this.prisma.$executeRaw`
      UPDATE "Transaction"
      SET "occurredAt" = "occurredAt" - ${intervalLiteral}::interval
    `;

    // Mark every customer changed so the debouncer triggers one global
    // re-evaluation. We don't try to be surgical — every customer's
    // metrics change when the timeline shifts.
    const customers = await this.prisma.customer.findMany({
      select: { id: true },
    });
    await this.buffer.markChangedMany(customers.map((c) => c.id));

    this.logger.log(
      `advance-time: shifted ${result} transaction row(s) back by ${days} day(s) — debouncer will re-evaluate`,
    );

    return {
      shiftedTransactions: result,
      shiftedDays: days,
      affectedCustomers: customers.length,
    };
  }
}
