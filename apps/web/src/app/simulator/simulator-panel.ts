import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SegmentsApi } from '../api/segments-api';
import {
  SimulatorApi,
  type BulkResponse,
} from '../api/simulator-api';
import type { CustomerSummary } from '../api/types';

// Three trigger surfaces:
//   1. Add a transaction for a chosen customer.
//   2. Patch a chosen customer's profile JSON.
//   3. Fire the 50K bulk endpoint to demonstrate the stress path.
//
// After every action the panel emits `actionTriggered` so the parent list
// can refetch — the realtime stream catches the per-segment delta within
// the next 500ms debouncer window, but a refetch keeps the list rock-solid
// even if a websocket reconnect missed an event.
@Component({
  selector: 'app-simulator-panel',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <header>
        <h2>Simulator</h2>
        <p class="muted">Trigger data changes; segments recompute via the debouncer + cascade.</p>
      </header>

      <div class="grid">
        <!-- Add transaction -->
        <form class="card" (submit)="$event.preventDefault(); fireTransaction()">
          <h3>Add transaction</h3>
          <label>
            Customer
            <select [(ngModel)]="txCustomerId" name="txCustomer">
              <option value="" disabled>&mdash; pick a customer &mdash;</option>
              @for (c of customers(); track c.id) {
                <option [value]="c.id">{{ c.name }}</option>
              }
            </select>
          </label>
          <label>
            Amount (GEL)
            <input type="number" min="1" step="0.01" [(ngModel)]="txAmount" name="txAmount" />
          </label>
          <button type="submit" [disabled]="busy() || !txCustomerId || !txAmount">
            Insert transaction
          </button>
        </form>

        <!-- Update profile -->
        <form class="card" (submit)="$event.preventDefault(); fireProfile()">
          <h3>Patch profile</h3>
          <label>
            Customer
            <select [(ngModel)]="profCustomerId" name="profCustomer">
              <option value="" disabled>&mdash; pick a customer &mdash;</option>
              @for (c of customers(); track c.id) {
                <option [value]="c.id">{{ c.name }}</option>
              }
            </select>
          </label>
          <label>
            Profile JSON patch
            <textarea
              rows="3"
              [(ngModel)]="profileJson"
              name="profile"
              placeholder='{"country":"GE"}'
            ></textarea>
          </label>
          <button type="submit" [disabled]="busy() || !profCustomerId || !profileJson">
            Apply patch
          </button>
        </form>

        <!-- Time advance -->
        <form class="card" (submit)="$event.preventDefault(); fireAdvanceTime()">
          <h3>Advance time</h3>
          <label>
            Days to skip forward
            <input type="number" min="1" max="365" step="1" [(ngModel)]="advanceDays" name="advanceDays" />
          </label>
          <p class="muted small">
            Shifts every transaction back by N days. Demonstrates the
            &ldquo;30 days passed &rarr; customer drops out of Active Buyers&rdquo; flow.
          </p>
          <button type="submit" [disabled]="busy() || !advanceDays">
            Skip {{ advanceDays }} day(s)
          </button>
        </form>

        <!-- Bulk -->
        <form class="card" (submit)="$event.preventDefault(); fireBulk()">
          <h3>Stress test</h3>
          <label>
            Bulk count
            <input type="number" min="1" max="200000" step="1000" [(ngModel)]="bulkCount" name="bulkCount" />
          </label>
          <p class="muted small">
            Inserts N synthetic transactions across all seeded customers in 1000-row chunks.
            The debouncer collapses them into one evaluation pass.
          </p>
          <button type="submit" [disabled]="busy()">
            @if (busy()) { Running&hellip; } @else { Fire {{ bulkCount }} changes }
          </button>
        </form>
      </div>

      @if (lastResult(); as r) {
        <pre class="result">{{ r }}</pre>
      }
      @if (errorMsg(); as e) {
        <p class="error">Error: {{ e }}</p>
      }
    </section>
  `,
  styles: `
    .panel {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px dashed var(--border);
    }
    h2 {
      margin: 0 0 0.25rem;
      font-size: 1.1rem;
    }
    h3 {
      margin: 0 0 0.6rem;
      font-size: 0.95rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: var(--muted);
    }
    label > input,
    label > select,
    label > textarea {
      color: var(--text);
    }
    textarea {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }
    button {
      margin-top: auto;
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 0.78rem;
    }
    .result {
      margin-top: 1rem;
    }
    .error {
      color: var(--remove);
    }
  `,
})
export class SimulatorPanel implements OnInit {
  private readonly sim = inject(SimulatorApi);
  private readonly segments = inject(SegmentsApi);

  /** Notify the parent that we just kicked something off. */
  @Output() actionTriggered = new EventEmitter<void>();

  protected readonly customers = signal<CustomerSummary[]>([]);
  protected readonly busy = signal(false);
  protected readonly lastResult = signal<string | null>(null);
  protected readonly errorMsg = signal<string | null>(null);

  // ngModel-bound form fields. Plain properties because they're transient
  // form state, not reactive UI state.
  protected txCustomerId = '';
  protected txAmount = 100;
  protected profCustomerId = '';
  protected profileJson = '{"country":"GE"}';
  protected bulkCount = 50000;
  protected advanceDays = 30;

  ngOnInit(): void {
    this.segments.customers().subscribe((rows) => this.customers.set(rows));
  }

  protected fireTransaction(): void {
    this.run(() =>
      this.sim
        .simulateTransaction({
          customerId: this.txCustomerId,
          amount: Number(this.txAmount),
        })
        .subscribe({
          next: (r) => this.done(r),
          error: (e) => this.failed(e),
        }),
    );
  }

  protected fireProfile(): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(this.profileJson);
    } catch (err) {
      this.errorMsg.set(`invalid JSON: ${(err as Error).message}`);
      return;
    }
    this.run(() =>
      this.sim
        .simulateProfile({
          customerId: this.profCustomerId,
          profile: parsed,
        })
        .subscribe({
          next: (r) => this.done(r),
          error: (e) => this.failed(e),
        }),
    );
  }

  protected fireBulk(): void {
    this.run(() =>
      this.sim.bulkChanges(Number(this.bulkCount)).subscribe({
        next: (r: BulkResponse) => this.done(r),
        error: (e) => this.failed(e),
      }),
    );
  }

  protected fireAdvanceTime(): void {
    this.run(() =>
      this.sim.advanceTime(Number(this.advanceDays)).subscribe({
        next: (r) => this.done(r),
        error: (e) => this.failed(e),
      }),
    );
  }

  private run(fn: () => void): void {
    this.errorMsg.set(null);
    this.lastResult.set(null);
    this.busy.set(true);
    fn();
  }

  private done(result: unknown): void {
    this.lastResult.set(JSON.stringify(result, null, 2));
    this.busy.set(false);
    this.actionTriggered.emit();
  }

  private failed(err: unknown): void {
    this.errorMsg.set(err instanceof Error ? err.message : String(err));
    this.busy.set(false);
  }
}
