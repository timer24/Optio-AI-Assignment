import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { EventEnvelope, SegmentDeltaPayload } from '@drift/shared';
import { EventTypes } from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';
import { RabbitMQService } from './rabbitmq.service';
import { Queues } from './topology';

// Reads segment.delta events and re-evaluates segments that depend on the
// changed parent. This is what makes the "segment B depends on segment A"
// cascade requirement work.
//
// Idempotency is naturally handled by the orchestrator's diff step: if the
// child's membership doesn't actually change, no SegmentMember/SegmentDelta
// rows are written and no OutboxEvent is emitted. The cascade terminates
// quietly when nothing further has to change.
@Injectable()
export class CascadeConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CascadeConsumerService.name);

  // Limits unacked deliveries — without this the broker would push the
  // entire backlog at once on reconnect. 10 gives some pipelining without
  // risking too many in-flight DB transactions.
  private static readonly PREFETCH = 10;

  private channel: Channel | null = null;

  constructor(
    private readonly rmq: RabbitMQService,
    private readonly prisma: PrismaService,
    private readonly evaluation: SegmentEvaluationService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.channel = await this.rmq.createChannel();
    await this.channel.prefetch(CascadeConsumerService.PREFETCH);

    await this.channel.consume(Queues.Cascade, (msg) => {
      // amqplib delivers `null` if the consumer is cancelled by the broker
      // (e.g., queue deleted). Nothing to do in that case.
      if (!msg) return;
      void this.process(msg);
    });

    this.logger.log(
      `cascade consumer subscribed to "${Queues.Cascade}" (prefetch=${CascadeConsumerService.PREFETCH})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // Channel may already be closed if the connection died; ignore.
    }
  }

  private async process(msg: ConsumeMessage): Promise<void> {
    try {
      await this.handle(msg);
      this.channel!.ack(msg);
    } catch (err) {
      this.logger.error(
        `cascade handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // requeue=true so transient failures retry. Persistent poison messages
      // would loop forever — production hardening would route to a DLQ
      // after N failed attempts (x-dead-letter-exchange + x-message-ttl).
      this.channel!.nack(msg, false, true);
    }
  }

  private async handle(msg: ConsumeMessage): Promise<void> {
    const envelope = JSON.parse(
      msg.content.toString(),
    ) as EventEnvelope<SegmentDeltaPayload>;

    // Defensive: if more event types are introduced later, this consumer
    // only cares about segment.delta — silently ignore the rest.
    if (envelope.eventType !== EventTypes.SegmentDelta) return;

    const { segmentId, segmentName } = envelope.payload;

    // Indexed lookup against the materialized cascade graph — the whole
    // reason SegmentDependency exists.
    const dependents = await this.prisma.segmentDependency.findMany({
      where: { parentId: segmentId },
      select: { childId: true },
    });

    if (dependents.length === 0) {
      // Leaf-of-the-cascade — nothing to recompute downstream.
      return;
    }

    this.logger.log(
      `cascade: "${segmentName}" changed, re-evaluating ${dependents.length} dependent segment(s)`,
    );

    // Sequential to keep DB pressure bounded. If cascade fan-out becomes
    // wide, we could parallelize with Promise.allSettled — but each
    // evaluation runs its own metrics aggregate, so unbounded parallelism
    // would hammer the DB.
    for (const { childId } of dependents) {
      await this.evaluation.evaluateSegment(childId);
    }
  }
}
