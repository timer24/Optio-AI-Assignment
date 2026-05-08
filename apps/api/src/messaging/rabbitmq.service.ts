import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { Exchanges, Queues, RoutingKeys } from './topology';

// Owns the AMQP connection and declares topology on startup. Other services
// (outbox publisher, consumers) borrow channels from this service.
//
// Topology is declared via `assertExchange` / `assertQueue` / `bindQueue`,
// all of which are idempotent — calling them on every boot is safe and
// guarantees the broker matches what the code expects, even after a
// `docker compose down -v` wipes the RabbitMQ data volume.
@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);

  private connection!: ChannelModel;
  // A long-lived channel used for publishing and for declaring topology.
  // Consumers create their own channels via `createChannel()` so they can
  // have independent prefetch settings and fail in isolation.
  private publishChannel!: Channel;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('RABBITMQ_URL');
    this.logger.log(`connecting to RabbitMQ at ${url}`);

    this.connection = await amqp.connect(url);
    this.connection.on('error', (err) =>
      this.logger.error(`AMQP connection error: ${err.message}`),
    );
    this.connection.on('close', () =>
      this.logger.warn('AMQP connection closed'),
    );

    this.publishChannel = await this.connection.createChannel();

    // Declare exchange. `durable: true` so it survives broker restarts.
    await this.publishChannel.assertExchange(Exchanges.Events, 'topic', {
      durable: true,
    });

    // Declare each queue and bind it to the exchange with the routing key
    // its consumer cares about. We bind every consumer queue to the same
    // routing key today (segment.delta), but binding is per-queue so each
    // consumer could subscribe to a different subset of events later.
    for (const queue of Object.values(Queues)) {
      await this.publishChannel.assertQueue(queue, { durable: true });
      await this.publishChannel.bindQueue(
        queue,
        Exchanges.Events,
        RoutingKeys.SegmentDelta,
      );
    }

    this.logger.log(
      `topology ready: exchange="${Exchanges.Events}", queues=[${Object.values(Queues).join(', ')}]`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Close in reverse order: channel first, then connection.
    try {
      await this.publishChannel?.close();
    } catch {
      // Channel may already be closed if the connection died — swallow.
    }
    try {
      await this.connection?.close();
    } catch {
      // Same — connection may already be gone.
    }
  }

  /**
   * Publish a JSON-serialized payload to the events exchange. `persistent`
   * tells RabbitMQ to write the message to disk so it survives a broker
   * restart — pairs with the durable queue declaration above.
   */
  publish(routingKey: string, payload: unknown): boolean {
    return this.publishChannel.publish(
      Exchanges.Events,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' },
    );
  }

  /**
   * Create a fresh channel for a consumer. Each consumer gets its own so it
   * can set independent prefetch values and so a consumer-side error doesn't
   * tear down the publisher's channel.
   */
  async createChannel(): Promise<Channel> {
    return this.connection.createChannel();
  }
}
