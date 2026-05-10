// RabbitMQ topology — one source of truth for exchange/queue/routing-key
// names. Imported by both the producer (outbox publisher) and the consumers
// so a typo can't make a publisher and consumer talk past each other.
//
// Convention: dot-notation, lowercase, prefix with "drift." for namespace.

export const Exchanges = {
  // Topic exchange. All segment-related events flow through here. Topic
  // (rather than direct/fanout) gives us flexible routing if we add more
  // event types later: a queue could bind to "segment.*" instead of just
  // "segment.delta".
  Events: 'drift.events',
} as const;

export const Queues = {
  // Cascade consumer: reads segment.delta, looks up SegmentDependency,
  // re-evaluates dependent segments. Naturally idempotent (Day 2's diff
  // step makes re-evaluation a no-op when nothing changed).
  Cascade: 'drift.cascade',
  // Campaign consumer: reads segment.delta, takes business action for new
  // members (logs / would-send-email). Needs explicit dedup via
  // ProcessedEvent because side effects are non-idempotent.
  Campaign: 'drift.campaign',
  // Realtime consumer: reads segment.delta and broadcasts to all connected
  // WebSocket clients. No dedup table — UI updates are idempotent (the
  // client just re-applies state) and missing an event due to a race in a
  // dedup check is worse than receiving it twice.
  Realtime: 'drift.realtime',
} as const;

// Routing keys used when publishing to the exchange. Match @drift/shared's
// EventTypes by convention so producer / consumer stay aligned.
export const RoutingKeys = {
  SegmentDelta: 'segment.delta',
} as const;
