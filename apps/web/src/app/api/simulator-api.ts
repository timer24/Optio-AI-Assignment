import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE } from './api-config';

export interface SimulateTransactionInput {
  customerId: string;
  amount: number;
}

export interface SimulateProfileInput {
  customerId: string;
  profile: Record<string, unknown>;
}

export interface BulkResponse {
  inserted: number;
  durationMs: number;
  chunkSize: number;
  chunks: number;
  uniqueCustomers: number;
}

// Wraps the simulator endpoints. The SimulatorPanel uses these to poke
// the backend, then watches the segment list / detail update via the
// realtime stream.
@Injectable({ providedIn: 'root' })
export class SimulatorApi {
  private readonly http = inject(HttpClient);

  simulateTransaction(input: SimulateTransactionInput): Observable<unknown> {
    return this.http.post(`${API_BASE}/simulate/transaction`, input);
  }

  simulateProfile(input: SimulateProfileInput): Observable<unknown> {
    return this.http.post(`${API_BASE}/simulate/profile-update`, input);
  }

  bulkChanges(count: number): Observable<BulkResponse> {
    return this.http.post<BulkResponse>(`${API_BASE}/simulate/bulk-changes`, {
      count,
    });
  }
}
