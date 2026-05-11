import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import type {
  CampaignNotificationPayload,
  EventEnvelope,
  SegmentDeltaPayload,
} from '@drift/shared';
import { EventTypes } from '@drift/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMQService } from './rabbitmq.service';
import { RealtimeGateway } from './realtime.gateway';
import { Queues } from './topology';

// Bonus consumer: receives segment.delta events and simulates a campaign
// reaction (logs "would notify customer X"). Demonstrates the pub/sub
// pattern with a third independent consumer that doesn't share code or
// failure modes with the cascade consumer.
//
// Unlike the cascade consumer, this consumer's "work" is non-idempotent in
// principle (in a real implementation it would call an email API). To stay
// safe under at-least-once delivery, we explicitly dedup via ProcessedEvent
// before doing the work — the composite UNIQUE constraint on (eventId,
// consumerName) is the atomic claim primitive.
@Injectable()
export class CampaignConsumerService implements OnModuleInit, OnModuleDestroy {
  // Stable identifier baked into ProcessedEvent rows. Renaming this would
  // make every previously-handled event look unhandled, so don't.
  private static readonly CONSUMER_NAME = 'campaign-consumer';
  private static readonly PREFETCH = 10;

  private readonly logger = new Logger(CampaignConsumerService.name);
  private channel: Channel | null = null;

  constructor(
    private readonly rmq: RabbitMQService,
    private readonly prisma: PrismaService,
    // Injected so the campaign consumer can push a "would-notify-X" line
    // to the UI's campaign feed. The dependency is intentional: the campaign
    // consumer's simulated side-effect *includes* the UI notification.
    // Both providers live in @Global MessagingModule; NestJS resolves the
    // dependency order automatically.
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    this.channel = await this.rmq.createChannel();
    await this.channel.prefetch(CampaignConsumerService.PREFETCH);

    await this.channel.consume(Queues.Campaign, (msg) => {
      if (!msg) return;
      void this.process(msg);
    });

    this.logger.log(
      `campaign consumer subscribed to "${Queues.Campaign}" (prefetch=${CampaignConsumerService.PREFETCH})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // Channel may already be closed; ignore.
    }
  }

  private async process(msg: ConsumeMessage): Promise<void> {
    try {
      await this.handle(msg);
      this.channel!.ack(msg);
    } catch (err) {
      this.logger.error(
        `campaign handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.channel!.nack(msg, false, true);
    }
  }

  private async handle(msg: ConsumeMessage): Promise<void> {
    const envelope = JSON.parse(
      msg.content.toString(),
    ) as EventEnvelope<SegmentDeltaPayload>;

    if (envelope.eventType !== EventTypes.SegmentDelta) return;

    // Atomic claim. createMany with skipDuplicates returns count=1 if the
    // row was inserted (we own the event) or count=0 if the unique
    // constraint blocked us (another delivery already handled it).
    const claim = await this.prisma.processedEvent.createMany({
      data: [
        {
          eventId: envelope.eventId,
          consumerName: CampaignConsumerService.CONSUMER_NAME,
        },
      ],
      skipDuplicates: true,
    });

    if (claim.count === 0) {
      // Duplicate delivery from RabbitMQ at-least-once. Already handled.
      this.logger.debug(`event ${envelope.eventId} already processed; skipping`);
      return;
    }

    // First (and only) time we see this event — do the simulated work.
    const { segmentId, segmentName, added, removed } = envelope.payload;

    // Look up names for the preview. Capping the lookup at the first 3 IDs
    // bounds the DB cost regardless of batch size — the UI shows up to 3
    // names plus "+N more".
    if (added.length > 0) {
      const names = await this.lookupNames(added.slice(0, 3));
      this.logger.log(
        `[campaign] would notify ${added.length} new member(s) of "${segmentName}": ${this.preview(added)}`,
      );
      this.broadcast({
        at: new Date().toISOString(),
        segmentId,
        segmentName,
        kind: 'ADD',
        customerNames: names,
        totalCount: added.length,
      });
    }
    if (removed.length > 0) {
      const names = await this.lookupNames(removed.slice(0, 3));
      this.logger.log(
        `[campaign] would mark ${removed.length} departed member(s) of "${segmentName}" inactive: ${this.preview(removed)}`,
      );
      this.broadcast({
        at: new Date().toISOString(),
        segmentId,
        segmentName,
        kind: 'REMOVE',
        customerNames: names,
        totalCount: removed.length,
      });
    }
  }

  private broadcast(payload: CampaignNotificationPayload): void {
    this.gateway.broadcastCampaign(payload);
  }

  private async lookupNames(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    // Preserve the original ordering so the names line up with the IDs
    // that were the "first N" in the batch.
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    return ids.map((id) => byId.get(id) ?? id.slice(0, 8));
  }

  // Render the first few customer IDs for log readability — full lists in
  // a 50K-customer batch would drown the log without telling you anything
  // useful. The exact members are queryable from SegmentDelta.
  private preview(ids: string[]): string {
    if (ids.length <= 3) return ids.join(', ');
    return `${ids.slice(0, 3).join(', ')}, +${ids.length - 3} more`;
  }
}
