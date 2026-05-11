// Event-type constants and payload shapes shared between the producer
// (the segment evaluation orchestrator) and the consumers (cascade,
// campaign, UI gateway). Putting these in @drift/shared keeps producer and
// consumer in sync — one edit propagates to everyone.

// Dot-notation matching the RabbitMQ routing-key convention. Frozen with
// `as const` so TypeScript treats the values as literal types, not `string`.
export const EventTypes = {
  SegmentDelta: 'segment.delta',
  // UI-only event. Not a routing key — emitted directly by the campaign
  // consumer over socket.io to drive the campaign-activity feed in the UI.
  CampaignNotification: 'campaign.notification',
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

// UI-side payload pushed by the campaign consumer over socket.io. Each
// notification corresponds to one bonus-campaign side-effect that would
// happen in production (sending an email, pinging a CRM, etc.).
export interface CampaignNotificationPayload {
  // Wall-clock ISO timestamp when the campaign consumer fired.
  at: string;
  segmentId: string;
  segmentName: string;
  // 'ADD' = new members getting onboarded; 'REMOVE' = departed members
  // being marked inactive in the simulated downstream system.
  kind: 'ADD' | 'REMOVE';
  // Up to a handful of human-readable customer names for the feed line.
  customerNames: string[];
  // Total count for "+N more" UX when names overflow the preview slice.
  totalCount: number;
}
