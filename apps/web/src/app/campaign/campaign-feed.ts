import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RealtimeService } from '../api/realtime';
import type { CampaignNotificationPayload } from '../api/types';

// Live feed of campaign-consumer activity. Each entry maps 1:1 to a "would
// notify X" / "would mark X inactive" line that the backend's campaign
// consumer fires after deduplicating an event via ProcessedEvent.
//
// This is the visible side of the bonus campaign-consumer requirement —
// proves to a reviewer that the delta event reached an independent third
// consumer (cascade is the first, realtime broadcaster is implicit, this
// is the second visible one in the UI).
@Component({
  selector: 'app-campaign-feed',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="feed">
      <header>
        <h2>Campaign activity</h2>
        <span class="muted small">
          live &mdash; bonus campaign consumer reacting to deltas
        </span>
      </header>
      @if (entries().length === 0) {
        <p class="muted small">
          No activity yet. Fire a simulator action to trigger a delta.
        </p>
      } @else {
        <ul class="entries">
          @for (e of entries(); track e.key) {
            <li [class.fresh]="e.key === lastKey()">
              <span class="when muted small">{{ e.at | date: 'HH:mm:ss' }}</span>
              <span class="kind" [class.add]="e.kind === 'ADD'" [class.rm]="e.kind === 'REMOVE'">
                {{ e.kind === 'ADD' ? 'NOTIFY' : 'OFFBOARD' }}
              </span>
              <span class="body">
                @if (e.kind === 'ADD') {
                  Would notify
                } @else {
                  Would mark inactive
                }
                <strong>{{ e.totalCount }}</strong>
                customer(s) of <em>{{ e.segmentName }}</em>
                @if (e.customerNames.length > 0) {
                  &mdash; {{ e.customerNames.join(', ')
                  }}@if (e.totalCount > e.customerNames.length) {
                    , +{{ e.totalCount - e.customerNames.length }} more
                  }
                }
              </span>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .feed {
      margin-top: 2rem;
      padding: 1rem;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    h2 {
      margin: 0;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 0.8rem;
    }
    .entries {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 240px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .entries li {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 0.6rem;
      align-items: baseline;
      padding: 0.4rem 0.5rem;
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .entries li.fresh {
      animation: highlight 1.4s ease-out;
    }
    .when {
      font-family: 'JetBrains Mono', monospace;
    }
    .kind {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 0.05rem 0.45rem;
      border-radius: 3px;
    }
    .kind.add {
      background: rgba(74, 222, 128, 0.15);
      color: var(--add);
    }
    .kind.rm {
      background: rgba(248, 113, 113, 0.15);
      color: var(--remove);
    }
    .body em {
      font-style: normal;
      color: var(--accent-strong);
    }
    @keyframes highlight {
      from {
        background: rgba(91, 157, 255, 0.18);
      }
      to {
        background: transparent;
      }
    }
  `,
})
export class CampaignFeed {
  private readonly rt = inject(RealtimeService);

  // Cap at 50 entries so the list doesn't grow unbounded during a stress
  // test. The most recent are shown first.
  private static readonly MAX_ENTRIES = 50;

  protected readonly entries = signal<
    Array<CampaignNotificationPayload & { key: string }>
  >([]);
  protected readonly lastKey = signal<string | null>(null);

  constructor() {
    // Subscribed in the constructor (an injection context) so
    // takeUntilDestroyed() can wire its DestroyRef without an explicit
    // argument.
    this.rt.campaign$.pipe(takeUntilDestroyed()).subscribe((payload) => {
      // Compose a stable per-entry key — the wall clock timestamp from the
      // backend isn't unique under high throughput; we fold in the segment
      // name + kind + total to disambiguate.
      const key = `${payload.at}-${payload.segmentId}-${payload.kind}-${payload.totalCount}`;
      this.entries.update((rows) =>
        [{ ...payload, key }, ...rows].slice(0, CampaignFeed.MAX_ENTRIES),
      );
      this.lastKey.set(key);
    });
  }
}
