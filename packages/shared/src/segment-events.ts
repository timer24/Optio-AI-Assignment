// Event-type constants and payload shapes shared between the producer
// (the segment evaluation orchestrator) and the consumers (cascade,
// campaign, UI gateway). Putting these in @drift/shared keeps producer and
// consumer in sync — one edit propagates to everyone.

// Dot-notation matching the RabbitMQ routing-key convention. Frozen with
// `as const` so TypeScript treats the values as literal types, not `string`.
export const EventTypes = {
  SegmentDelta: 'segment.delta',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// Body of a segment.delta event. Lives in OutboxEvent.payload as JSONB.
// Wrapped in an EventEnvelope before publishing to RabbitMQ.
export interface SegmentDeltaPayload {
  segmentId: string;
  segmentName: string;
  // UUID stamped on every SegmentDelta row from this evaluation pass —
  // lets a consumer cross-reference the row-level history if needed.
  batchId: string;
  // Customer IDs that just joined the segment.
  added: string[];
  // Customer IDs that just left the segment.
  removed: string[];
}

// Wire-format wrapper for every event published to the broker. The eventId
// matches OutboxEvent.id so consumers can dedup against ProcessedEvent.
// Generic over the payload type so consumers get autocomplete via
// `EventEnvelope<SegmentDeltaPayload>`.
export interface EventEnvelope<T = unknown> {
  eventId: string;
  eventType: EventType;
  // ISO timestamp — when the producer wrote the OutboxEvent row.
  createdAt: string;
  payload: T;
}
