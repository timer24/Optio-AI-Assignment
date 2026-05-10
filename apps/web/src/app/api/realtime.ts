import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subject, type Observable } from 'rxjs';
import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api-config';
import { EventTypes, type SegmentDeltaPayload } from './types';

// Wraps the socket.io connection and re-publishes segment.delta events as
// a typed Observable. Components subscribe to `deltas$` (or read the
// `connected` signal for the "live" badge in the topbar).
//
// One singleton instance per app — providedIn 'root'. The connection lives
// for the entire app session; routing between pages doesn't tear it down.
@Injectable({ providedIn: 'root' })
export class RealtimeService implements OnDestroy {
  /** Last `segment.delta` payload received. Components can subscribe. */
  private readonly deltaSubject = new Subject<SegmentDeltaPayload>();
  readonly deltas$: Observable<SegmentDeltaPayload> =
    this.deltaSubject.asObservable();

  /** Signal mirroring the underlying socket's connection state. */
  readonly connected = signal(false);

  private readonly socket: Socket;

  constructor() {
    this.socket = io(API_BASE, {
      // Force websocket transport — long-polling fallback isn't needed
      // for a localhost dev setup and adds latency on the first event.
      transports: ['websocket'],
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on(EventTypes.SegmentDelta, (payload: SegmentDeltaPayload) => {
      this.deltaSubject.next(payload);
    });
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
    this.deltaSubject.complete();
  }
}
