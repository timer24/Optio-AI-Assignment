import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { EventEnvelope, EventType } from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMQService } from './rabbitmq.service';

// Drains the OutboxEvent table to RabbitMQ on a fixed interval. The
// orchestrator writes OutboxEvent rows inside the membership-change
// transaction; this service makes them visible to the broker after the
// fact. Decoupled, so a broker outage cannot poison the orchestrator's
// transaction — events just queue up in the DB until the broker is back.
//
// Publish first, mark PUBLISHED second. If the publish succeeds but the
// mark fails, the row stays PENDING and we republish next tick — at-least
// -once delivery, which is exactly why consumers must be idempotent.
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);

  // Tick frequency. 1s gives near-real-time perceived latency while keeping
  // the steady-state DB load to one indexed query per second.
  private static readonly POLL_INTERVAL_MS = 1000;

  // Maximum rows handled per tick. Keeps a single tick bounded in time even
  // if the table has accumulated thousands of pending events (e.g., after
  // a broker outage).
  private static readonly BATCH_SIZE = 100;

  private interval: NodeJS.Timeout | null = null;
  // Reentrancy guard — prevents two ticks running in parallel if a previous
  // batch took longer than POLL_INTERVAL_MS to drain.
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rmq: RabbitMQService,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(
      () => void this.tick(),
      OutboxPublisherService.POLL_INTERVAL_MS,
    );
    this.logger.log(
      `outbox publisher started (interval=${OutboxPublisherService.POLL_INTERVAL_MS}ms, batch=${OutboxPublisherService.BATCH_SIZE})`,
    );
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.drainBatch();
    } catch (err) {
      // Don't crash the timer on transient failures — the next tick will
      // retry the same rows. We log to surface persistent problems.
      this.logger.error(
        `outbox tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async drainBatch(): Promise<void> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: OutboxPublisherService.BATCH_SIZE,
    });

    if (pending.length === 0) return;

    let publishedCount = 0;
    for (const row of pending) {
      const envelope: EventEnvelope = {
        eventId: row.id,
        eventType: row.eventType as EventType,
        createdAt: row.createdAt.toISOString(),
        // The payload was stored as JSONB in the orchestrator; Prisma
        // returns it as a plain JS value. We pass it through untouched.
        payload: row.payload,
      };

      // The routing key matches the eventType by convention so consumers
      // can bind their queues by event-type pattern.
      const accepted = this.rmq.publish(row.eventType, envelope);
      if (!accepted) {
        // The channel's internal buffer is full — back off and let the next
        // tick retry. Don't mark as PUBLISHED.
        this.logger.warn(
          'channel buffer full; pausing publisher until next tick',
        );
        break;
      }

      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      publishedCount++;
    }

    if (publishedCount > 0) {
      this.logger.log(`published ${publishedCount} outbox event(s)`);
    }
  }
}
