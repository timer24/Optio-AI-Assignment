import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Owns the Redis connection. Other services (the debouncer today; cache /
// distributed-lock callers later) inject this and use `client` directly.
//
// Single shared connection is fine for our scale: ioredis multiplexes
// commands over one TCP connection internally and queues anything sent
// before the handshake completes — no `ready` promise needed here, unlike
// our amqplib wrapper.
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private _client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.logger.log(`connecting to Redis at ${url}`);
    this._client = new Redis(url, {
      // Fail fast on a misconfigured URL instead of retrying forever — the
      // dev-time signal is more useful than silent backoff.
      maxRetriesPerRequest: 3,
    });
    this._client.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.quit();
  }

  get client(): Redis {
    return this._client;
  }
}
