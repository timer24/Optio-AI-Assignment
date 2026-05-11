import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Channel, ConsumeMessage } from 'amqplib';
import { Server } from 'socket.io';
import type {
  CampaignNotificationPayload,
  EventEnvelope,
  SegmentDeltaPayload,
} from '@drift/shared';
import { EventTypes } from '@drift/shared';
import { RabbitMQService } from './rabbitmq.service';
import { Queues } from './topology';

// The third consumer of segment.delta events. Combines two roles:
//   1. WebSocket gateway   — accepts socket.io client connections.
//   2. RabbitMQ consumer    — drains drift.realtime and pushes events to
//                             every connected client.
//
// Why combine them? The class has one job: "broadcast deltas to UI". The
// channel-in / sockets-out pieces are inseparable for that job, so splitting
// would invent a useless seam. Cascade and campaign consumers stay in their
// own files because their downstream targets (DB rows, future email API)
// are different concerns.
//
// Why no ProcessedEvent dedup? Pushing a delta to a UI is idempotent — the
// client just re-renders the same state. A dedup table here would risk
// silently dropping an event for a freshly-connected client that wasn't
// around when the dedup row was first written.
@Injectable()
@WebSocketGateway({
  // CORS for the Angular dev server. Same setting as the HTTP layer.
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private static readonly PREFETCH = 50;

  // Populated by NestJS once socket.io is wired up. Used to broadcast to
  // every connected client.
  @WebSocketServer()
  private server!: Server;

  private channel: Channel | null = null;

  constructor(private readonly rmq: RabbitMQService) {}

  async onModuleInit(): Promise<void> {
    this.channel = await this.rmq.createChannel();
    await this.channel.prefetch(RealtimeGateway.PREFETCH);

    await this.channel.consume(Queues.Realtime, (msg) => {
      if (!msg) return;
      void this.process(msg);
    });

    this.logger.log(
      `realtime gateway subscribed to "${Queues.Realtime}" (prefetch=${RealtimeGateway.PREFETCH})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // Channel may already be closed via the connection — swallow.
    }
  }

  private async process(msg: ConsumeMessage): Promise<void> {
    try {
      this.handle(msg);
      this.channel!.ack(msg);
    } catch (err) {
      this.logger.error(
        `realtime handler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Requeue once. A persistent failure here would only affect UI
      // freshness — the data is already in Postgres, so a DLQ isn't
      // critical for production-readiness here.
      this.channel!.nack(msg, false, true);
    }
  }

  private handle(msg: ConsumeMessage): void {
    const envelope = JSON.parse(
      msg.content.toString(),
    ) as EventEnvelope<SegmentDeltaPayload>;

    if (envelope.eventType !== EventTypes.SegmentDelta) return;

    // Broadcast to every connected client. The event name matches the
    // EventType so the frontend's listener mirrors the backend's contract.
    this.server.emit(EventTypes.SegmentDelta, envelope.payload);

    this.logger.debug(
      `broadcast segment.delta for "${envelope.payload.segmentName}" to all sockets`,
    );
  }

  /**
   * Public surface for other consumers (specifically the campaign consumer)
   * to push UI-only notifications. We don't go through RabbitMQ for this
   * channel because:
   *   - There's no persistence / replay need: a UI notification is a fleeting
   *     side-effect; if no clients are connected, dropping it is fine.
   *   - It's already inside the same process; an extra exchange/queue would
   *     be ceremony with no payoff at this scale.
   * The trade-off is a direct in-process dependency between two consumers
   * in the same module, which is documented in CampaignConsumerService.
   */
  broadcastCampaign(payload: CampaignNotificationPayload): void {
    if (!this.server) {
      // socket.io server hasn't been wired by NestJS yet — happens if a
      // delta event fires in the narrow window between gateway construction
      // and platform init. Log so we don't silently drop UI updates.
      this.logger.warn(
        `dropping campaign.notification for "${payload.segmentName}" — server not ready`,
      );
      return;
    }
    this.server.emit(EventTypes.CampaignNotification, payload);
    this.logger.debug(
      `broadcast campaign.notification (${payload.kind}, ${payload.totalCount}) for "${payload.segmentName}"`,
    );
  }
}
