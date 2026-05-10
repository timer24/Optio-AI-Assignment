import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';

// Debounces high-frequency customer-change events into a single segment
// re-evaluation pass.
//
// Producers (HTTP simulator endpoints, future ingestion paths) call
// `markChanged(customerId)`, which SADDs the ID to a Redis set. Every
// FLUSH_INTERVAL_MS this service flushes the buffer and triggers ONE
// rebuild of all dynamic segments. So 50,000 transactions arriving in a
// 500ms burst collapse to one evaluation pass instead of 50,000.
//
// Why Redis (not in-memory)?
//   - Multi-instance correctness: if we ever run more than one API node,
//     in-memory state would only see writes from its own process. Redis is
//     the shared queue.
//   - It's in the stack — using it answers the assignment's "why Redis?"
//     question with something real instead of "for caching, eventually."
//
// Why RENAME for flush (not SMEMBERS + DEL)?
//   - SMEMBERS + DEL is two commands with a window between them. Anything
//     that lands in the buffer in that window would be deleted before being
//     read. RENAME is atomic — the active key becomes empty in the same
//     instant the snapshot key materializes, so no event is lost.
@Injectable()
export class ChangeBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChangeBufferService.name);

  // Single shared key for the buffer set. Namespaced with `drift:` so it
  // doesn't collide with anything else sharing this Redis instance.
  private static readonly BUFFER_KEY = 'drift:changes:buffer';

  // 500ms is the assignment's stated debounce window. Short enough for
  // perceived real-time feel; long enough that a 50K bulk insert lands
  // entirely within one window.
  private static readonly FLUSH_INTERVAL_MS = 500;

  private interval: NodeJS.Timeout | null = null;
  // Reentrancy guard. If a flush takes longer than FLUSH_INTERVAL_MS
  // (rebuilding 4 segments over 200 customers takes ~50ms today, but a
  // 50K rebuild could exceed it), the next tick is a no-op rather than
  // running a parallel rebuild.
  private inFlight = false;

  constructor(
    private readonly redis: RedisService,
    private readonly evaluation: SegmentEvaluationService,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(
      () => void this.tick(),
      ChangeBufferService.FLUSH_INTERVAL_MS,
    );
    this.logger.log(
      `change buffer started (flush interval=${ChangeBufferService.FLUSH_INTERVAL_MS}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Mark a single customer as changed. Adds to the Redis set; no-op if the
   * customer is already buffered for this window — that's the dedup.
   */
  async markChanged(customerId: string): Promise<void> {
    await this.redis.client.sadd(ChangeBufferService.BUFFER_KEY, customerId);
  }

  /**
   * Bulk variant for the simulator's high-volume endpoint. One round-trip
   * to Redis instead of N — material at 50K scale.
   */
  async markChangedMany(customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) return;
    await this.redis.client.sadd(
      ChangeBufferService.BUFFER_KEY,
      ...customerIds,
    );
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.flush();
    } catch (err) {
      this.logger.error(
        `flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async flush(): Promise<void> {
    // Atomically swap the buffer with an empty set by renaming it to a
    // unique snapshot key. New writes in the next instant land in a fresh
    // (auto-created) buffer key.
    const snapshotKey = `drift:changes:flush:${randomUUID()}`;

    try {
      await this.redis.client.rename(
        ChangeBufferService.BUFFER_KEY,
        snapshotKey,
      );
    } catch (err) {
      // ioredis surfaces the Redis "ERR no such key" when the buffer is
      // empty. That's the common case (most ticks have nothing to flush)
      // — bail silently rather than logging.
      if (err instanceof Error && err.message.includes('no such key')) {
        return;
      }
      throw err;
    }

    const changedCustomerIds = await this.redis.client.smembers(snapshotKey);
    await this.redis.client.del(snapshotKey);

    this.logger.log(
      `debouncer flush: ${changedCustomerIds.length} customer(s) changed → re-evaluating all dynamic segments`,
    );

    // Trigger one global re-evaluation. The orchestrator already deduplicates
    // work (its diff step makes "no change" a no-op) so it's safe to over-
    // recompute. We could narrow this to only segments whose rules touch
    // metrics affected by these customers, but the marginal complexity
    // isn't worth it at this scale.
    await this.evaluation.rebuildAllDynamic();
  }
}
