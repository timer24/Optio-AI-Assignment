import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE } from './api-config';
import type {
  CustomerSummary,
  DeltaEntry,
  SegmentDetail,
  SegmentSummary,
} from './types';

// Thin HTTP wrapper around the segments + customers endpoints. Exposes
// Observables so components stay declarative — no manual subscription
// management when paired with the `async` pipe.
@Injectable({ providedIn: 'root' })
export class SegmentsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<SegmentSummary[]> {
    return this.http.get<SegmentSummary[]>(`${API_BASE}/segments`);
  }

  detail(id: string): Observable<SegmentDetail> {
    return this.http.get<SegmentDetail>(`${API_BASE}/segments/${id}`);
  }

  deltas(id: string, limit = 50): Observable<DeltaEntry[]> {
    return this.http.get<DeltaEntry[]>(
      `${API_BASE}/segments/${id}/deltas?limit=${limit}`,
    );
  }

  evaluate(id: string, force = false): Observable<unknown> {
    return this.http.post(`${API_BASE}/segments/${id}/evaluate`, { force });
  }

  rebuildAll(): Observable<unknown> {
    return this.http.post(`${API_BASE}/segments/rebuild`, {});
  }

  customers(): Observable<CustomerSummary[]> {
    return this.http.get<CustomerSummary[]>(`${API_BASE}/customers`);
  }
}
