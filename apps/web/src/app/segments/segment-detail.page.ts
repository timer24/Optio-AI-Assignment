import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SegmentsApi } from '../api/segments-api';
import { RealtimeService } from '../api/realtime';
import type { DeltaEntry, SegmentDetail, SegmentDeltaPayload } from '../api/types';

// Detail page for one segment. Shows metadata + the rule (pretty-printed
// JSON) + a live-updating delta feed.
//
// `id` comes in via withComponentInputBinding() — Angular binds the route
// param to the @Input directly, no need to inject ActivatedRoute.
@Component({
  selector: 'app-segment-detail',
  imports: [RouterLink, DatePipe, JsonPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/segments" class="back">&larr; back to segments</a>

    @if (loading()) {
      <p class="muted">Loading&hellip;</p>
    } @else if (error()) {
      <p class="error">Failed to load segment: {{ error() }}</p>
    } @else if (segment(); as s) {
      <header class="head">
        <div>
          <h1>{{ s.name }}</h1>
          @if (s.description) {
            <p class="muted">{{ s.description }}</p>
          }
        </div>
        <div class="meta">
          <span class="tag" [class.static]="s.type === 'STATIC'">{{ s.type }}</span>
          <span class="count">
            <strong>{{ s.memberCount }}</strong>
            <span class="muted small">members</span>
          </span>
        </div>
      </header>

      <section class="card">
        <h2>Rule</h2>
        <pre>{{ s.rule | json }}</pre>
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Recent deltas</h2>
          <span class="muted small">live &mdash; updates as cascades fire</span>
        </header>
        @if (deltas().length === 0) {
          <p class="muted">No deltas recorded yet.</p>
        } @else {
          <table class="grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Customer</th>
                <th>Change</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              @for (d of deltas(); track d.id) {
                <tr [class.fresh]="d.id === lastDeltaId()">
                  <td class="muted small">{{ d.occurredAt | date: 'mediumTime' }}</td>
                  <td>{{ d.customerName }}</td>
                  <td>
                    <span class="change" [class.add]="d.change === 'ADD'" [class.rm]="d.change === 'REMOVE'">
                      {{ d.change }}
                    </span>
                  </td>
                  <td class="muted small mono">{{ d.batchId.slice(0, 8) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    }
  `,
  styles: `
    .back {
      display: inline-block;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }
    .head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: 1.25rem;
      gap: 1rem;
    }
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.4rem;
    }
    h2 {
      margin: 0 0 0.5rem;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .count {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      line-height: 1;
    }
    .count strong {
      font-size: 1.6rem;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.5rem;
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
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      margin-bottom: 1.25rem;
    }
    .card-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    .card-head h2 {
      margin: 0;
    }
    .grid {
      width: 100%;
      border-collapse: collapse;
    }
    .grid th,
    .grid td {
      padding: 0.45rem 0.6rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .grid th {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--muted);
    }
    .grid tr:last-child td {
      border-bottom: 0;
    }
    .grid tr.fresh td {
      animation: highlight 1.5s ease-out;
    }
    .change {
      font-weight: 600;
      font-size: 0.78rem;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
    }
    .change.add {
      background: rgba(74, 222, 128, 0.15);
      color: var(--add);
    }
    .change.rm {
      background: rgba(248, 113, 113, 0.15);
      color: var(--remove);
    }
    .mono {
      font-family: 'JetBrains Mono', monospace;
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 0.8rem;
    }
    .error {
      color: var(--remove);
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
export class SegmentDetailPage implements OnInit, OnChanges {
  private readonly api = inject(SegmentsApi);
  private readonly rt = inject(RealtimeService);

  // Bound from route param via withComponentInputBinding().
  @Input() id!: string;

  protected readonly segment = signal<SegmentDetail | null>(null);
  protected readonly deltas = signal<DeltaEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  // ID of the most recently received delta — used to flash the row.
  protected readonly lastDeltaId = signal<string | null>(null);

  ngOnInit(): void {
    this.rt.deltas$
      .pipe(takeUntilDestroyed())
      .subscribe((payload) => this.applyRealtimeDelta(payload));
  }

  ngOnChanges(): void {
    // Re-run when navigating between two detail pages.
    this.load();
  }

  private load(): void {
    if (!this.id) return;
    this.loading.set(true);
    this.error.set(null);
    this.api.detail(this.id).subscribe({
      next: (s) => {
        this.segment.set(s);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'unknown error');
        this.loading.set(false);
      },
    });
    this.api.deltas(this.id).subscribe((rows) => this.deltas.set(rows));
  }

  private applyRealtimeDelta(payload: SegmentDeltaPayload): void {
    if (payload.segmentId !== this.id) return;

    // Update header count immediately.
    this.segment.update((s) =>
      s
        ? {
            ...s,
            memberCount:
              s.memberCount + payload.added.length - payload.removed.length,
            updatedAt: new Date().toISOString(),
          }
        : s,
    );

    // Refetch the deltas list — gives us authoritative customer names +
    // the canonical row IDs without us having to mirror them client-side.
    // For a high-throughput dashboard we'd do an in-place merge instead.
    this.api.deltas(this.id).subscribe((rows) => {
      this.deltas.set(rows);
      if (rows.length > 0) this.lastDeltaId.set(rows[0].id);
    });
  }
}
