import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SegmentsApi } from '../api/segments-api';
import { RealtimeService } from '../api/realtime';
import type { SegmentSummary, SegmentDeltaPayload } from '../api/types';
import { SimulatorPanel } from '../simulator/simulator-panel';
import { CampaignFeed } from '../campaign/campaign-feed';

// Visual hint shown briefly next to a segment when its membership changed
// in response to a realtime delta event. Cleared after a few seconds so
// the UI doesn't accumulate noise.
interface DeltaFlash {
  added: number;
  removed: number;
  // Wall-clock ms at which the badge should disappear.
  expiresAt: number;
}

@Component({
  selector: 'app-segments-list',
  imports: [RouterLink, DatePipe, SimulatorPanel, CampaignFeed],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="header">
      <h1>Segments</h1>
      <div class="status">
        <span class="dot" [class.live]="rt.connected()"></span>
        <span>{{ rt.connected() ? 'live' : 'disconnected' }}</span>
      </div>
    </section>

    @if (loading()) {
      <p class="muted">Loading segments&hellip;</p>
    } @else if (error()) {
      <p class="error">Failed to load segments: {{ error() }}</p>
    } @else {
      <table class="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th class="num">Members</th>
            <th class="num">Last change</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          @for (s of segments(); track s.id) {
            <tr>
              <td>
                <a [routerLink]="['/segments', s.id]">{{ s.name }}</a>
                @if (s.description) {
                  <div class="muted small">{{ s.description }}</div>
                }
              </td>
              <td>
                <span class="tag" [class.static]="s.type === 'STATIC'">{{ s.type }}</span>
              </td>
              <td class="num strong">{{ s.memberCount }}</td>
              <td class="num">
                @if (flashes()[s.id]; as f) {
                  <span class="flash">
                    @if (f.added > 0) { <span class="add">+{{ f.added }}</span> }
                    @if (f.removed > 0) { <span class="rm">&minus;{{ f.removed }}</span> }
                  </span>
                } @else {
                  <span class="muted">&mdash;</span>
                }
              </td>
              <td class="muted small">{{ s.updatedAt | date: 'medium' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }

    <app-campaign-feed />

    <app-simulator-panel (actionTriggered)="refreshList()" />
  `,
  styles: `
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    h1 {
      margin: 0;
      font-size: 1.4rem;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--muted);
      font-size: 0.85rem;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--remove);
    }
    .dot.live {
      background: var(--add);
      box-shadow: 0 0 6px var(--add);
    }
    .grid {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    .grid th,
    .grid td {
      padding: 0.6rem 0.9rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .grid th {
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      background: var(--panel-2);
    }
    .grid tr:last-child td {
      border-bottom: 0;
    }
    .grid .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .strong {
      font-weight: 600;
    }
    .small {
      font-size: 0.8rem;
    }
    .muted {
      color: var(--muted);
    }
    .error {
      color: var(--remove);
    }
    .tag {
      display: inline-block;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      background: rgba(91, 157, 255, 0.15);
      color: var(--accent-strong);
      font-size: 0.75rem;
      font-weight: 600;
    }
    .tag.static {
      background: rgba(251, 191, 36, 0.18);
      color: var(--warn);
    }
    .flash {
      display: inline-flex;
      gap: 0.4rem;
      animation: pulse 0.4s ease-out;
    }
    .add {
      color: var(--add);
      font-weight: 600;
    }
    .rm {
      color: var(--remove);
      font-weight: 600;
    }
    @keyframes pulse {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  `,
})
export class SegmentsListPage implements OnInit, OnDestroy {
  private readonly api = inject(SegmentsApi);
  protected readonly rt = inject(RealtimeService);

  protected readonly segments = signal<SegmentSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  // Map of segmentId → recent flash badge. Cleared by a periodic sweeper.
  protected readonly flashes = signal<Record<string, DeltaFlash>>({});

  private flashGcInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // takeUntilDestroyed must be called in an injection context (the
    // constructor) — calling it from ngOnInit throws at runtime.
    this.rt.deltas$
      .pipe(takeUntilDestroyed())
      .subscribe((payload) => this.applyDelta(payload));
  }

  ngOnInit(): void {
    this.refreshList();
    // Expire stale flash badges every second. Tracked so we can clear it
    // on destroy — otherwise routing back and forth piles up timers.
    this.flashGcInterval = setInterval(() => this.gcFlashes(), 1000);
  }

  ngOnDestroy(): void {
    if (this.flashGcInterval) clearInterval(this.flashGcInterval);
  }

  refreshList(): void {
    // Only show the spinner on the very first load. Refetches triggered
    // after a simulator action (or after deltas land) must not swap the
    // table out for a "Loading..." line — that hides the flash badges
    // we just set on incoming deltas.
    const isFirstLoad = this.segments().length === 0;
    if (isFirstLoad) this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (rows) => {
        this.segments.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'unknown error');
        this.loading.set(false);
      },
    });
  }

  private applyDelta(payload: SegmentDeltaPayload): void {
    // Update the membership count for the matching segment in place. We
    // don't refetch the whole list — the count delta is right there.
    this.segments.update((rows) =>
      rows.map((r) =>
        r.id === payload.segmentId
          ? {
              ...r,
              memberCount:
                r.memberCount + payload.added.length - payload.removed.length,
              updatedAt: new Date().toISOString(),
            }
          : r,
      ),
    );

    // Record / merge a flash entry. If multiple deltas land in quick
    // succession we sum them so the user sees the net effect.
    this.flashes.update((m) => {
      const existing = m[payload.segmentId];
      return {
        ...m,
        [payload.segmentId]: {
          added: (existing?.added ?? 0) + payload.added.length,
          removed: (existing?.removed ?? 0) + payload.removed.length,
          expiresAt: Date.now() + 4000,
        },
      };
    });
  }

  private gcFlashes(): void {
    const now = Date.now();
    this.flashes.update((m) => {
      const next: Record<string, DeltaFlash> = {};
      for (const [id, flash] of Object.entries(m)) {
        if (flash.expiresAt > now) next[id] = flash;
      }
      return next;
    });
  }
}
