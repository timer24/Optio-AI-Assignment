# Drift Happens — Architecture diagrams

Five Mermaid diagrams covering the three spec-mandated views (component
connections, signal path, batch logic) plus two extras (cascade flow, data
model). Every diagram is inline so GitHub renders it automatically — no
external tooling required.

---

## 1. System Architecture — who talks to whom

What each container is and how the moving parts connect. Each subgraph is a
single Docker container; the internal services inside the API container are
NestJS providers that share a process.

```mermaid
flowchart LR
    Browser([User browser])

    subgraph WebContainer["web (nginx)"]
        SPA[Angular SPA static assets]
    end

    subgraph APIContainer["api (NestJS)"]
        SimCtrl[Simulator Controller]
        SegCtrl[Segments Controller]
        Orch[Segment Orchestrator]
        Buf[Change Buffer]
        Pub[Outbox Publisher]
        CascC[Cascade Consumer]
        CampC[Campaign Consumer]
        RT[Realtime Gateway]
    end

    subgraph PG["postgres"]
        TXTable[(Customer / Transaction / Segment /<br/>SegmentMember / SegmentDelta /<br/>SegmentDependency / OutboxEvent /<br/>ProcessedEvent)]
    end

    subgraph RD["redis"]
        Set[(drift:changes:buffer SET)]
    end

    subgraph MQ["rabbitmq — topic exchange drift.events"]
        QCasc[/drift.cascade/]
        QCamp[/drift.campaign/]
        QRT[/drift.realtime/]
    end

    Browser -- HTTP GET / --> SPA
    Browser -- HTTP API + WebSocket --> APIContainer

    SimCtrl --> TXTable
    SimCtrl --> Buf
    SegCtrl --> Orch
    Orch --> TXTable
    Buf -- SADD / RENAME --> Set
    Buf -- 500ms tick --> Orch
    Pub -- drain PENDING --> TXTable
    Pub -- publish segment.delta --> MQ
    QCasc --> CascC
    QCamp --> CampC
    QRT --> RT
    CascC --> Orch
    CampC --> RT
    RT -. websocket broadcast .-> Browser
```

---

## 2. Signal Path — one change event end-to-end

What happens between a single simulator action and the UI flash. Time flows
top-to-bottom. The `loop` blocks make the 500ms debouncer and 1s outbox
publisher visible as their own steady cadence.

```mermaid
sequenceDiagram
    autonumber
    actor User as Browser
    participant API as Simulator API
    participant DB as Postgres
    participant Buf as ChangeBuffer
    participant Orch as Orchestrator
    participant Pub as OutboxPublisher
    participant MQ as RabbitMQ
    participant Casc as CascadeConsumer
    participant Camp as CampaignConsumer
    participant RT as RealtimeGateway

    User->>API: POST /simulate/bulk-changes
    API->>DB: INSERT 50,000 transactions (chunked 1000 per request)
    API->>Buf: SADD changed customer IDs
    API-->>User: 202 Accepted

    loop every 500ms
        Buf->>Buf: RENAME buffer to snapshot key (atomic)
        Buf->>Orch: rebuildAllDynamic
        Orch->>DB: read metrics and current memberships
        Orch->>DB: diff then write Member + Delta + OutboxEvent in one tx
    end

    loop every 1s
        Pub->>DB: SELECT status PENDING LIMIT 100
        Pub->>MQ: publish segment.delta
        Pub->>DB: UPDATE status PUBLISHED
    end

    par fan-out to 3 independent consumers
        MQ->>Casc: deliver to drift.cascade
        Casc->>DB: SELECT childId FROM SegmentDependency WHERE parentId
        Casc->>Orch: evaluateSegment(childId)
    and
        MQ->>Camp: deliver to drift.campaign
        Camp->>DB: INSERT ProcessedEvent ON CONFLICT skip
        Camp->>RT: broadcastCampaign(notification)
    and
        MQ->>RT: deliver to drift.realtime
        RT->>User: socket.io emit segment.delta
        RT->>User: socket.io emit campaign.notification
    end
```

---

## 3. Backpressure & Debouncing — where 50K events collapse

Why a 50K-event burst doesn't translate to 50K segment evaluations. The
Redis SET deduplicates by customer ID; the 500ms timer further coalesces;
the orchestrator's diff suppresses empty events; consumer prefetch limits
in-flight work.

```mermaid
flowchart TB
    burst["50K simulator events<br/>over ~3 seconds"]

    subgraph Buffer["Redis SET — drift:changes:buffer"]
        sadd["SADD customerId × 50K<br/>set semantics → ≤200 unique IDs"]
    end

    subgraph FlushTimer["500ms flush timer"]
        tick[setInterval 500ms]
        rename["RENAME buffer → snapshot key<br/>(atomic — no event lost mid-flush)"]
        members[SMEMBERS snapshot → DEL]
    end

    subgraph Rebuild["Orchestrator pass"]
        rebuild[rebuildAllDynamic — topo sort]
        diff{any delta?}
        empty["no event emitted<br/>(quiet cascade termination)"]
        write["one transaction:<br/>SegmentMember<br/>+ SegmentDelta<br/>+ OutboxEvent"]
    end

    subgraph Consumers["Consumer prefetch limits in-flight work"]
        c1["cascade prefetch=1<br/>(serial — would race shared child)"]
        c2["campaign prefetch=10"]
        c3["realtime prefetch=50"]
    end

    burst -->|markChanged / markChangedMany| sadd
    sadd --> tick
    tick --> rename
    rename --> members
    members --> rebuild
    rebuild --> diff
    diff -- no --> empty
    diff -- yes --> write
    write --> c1
    write --> c2
    write --> c3
```

---

## 4. Cascade Flow — segment A used as filter inside segment B

The spec calls cascading the "special case." This zooms into what happens
when segment A's membership changes and segment B depends on A. The
SegmentDependency table makes the lookup O(indexed-query) instead of
re-parsing every rule.

```mermaid
sequenceDiagram
    autonumber
    participant Up as Upstream change
    participant Orch as Orchestrator
    participant DB as Postgres
    participant MQ as RabbitMQ
    participant Casc as CascadeConsumer

    Note over Up,DB: "Active Buyers" gains members
    Up->>Orch: rebuildAllDynamic
    Orch->>DB: evaluate Active Buyers, diff = +37 / -0
    Orch->>DB: INSERT Member + SegmentDelta + OutboxEvent

    Note over DB,MQ: Outbox publisher (next 1s tick)
    DB->>MQ: publish segment.delta for ActiveBuyers
    MQ->>Casc: deliver via drift.cascade queue

    Casc->>DB: SELECT childId FROM SegmentDependency WHERE parentId
    DB-->>Casc: childId = Active VIPs

    Casc->>Orch: evaluateSegment(Active VIPs)
    Orch->>DB: read parent memberships (ActiveBuyers and VIP)
    Orch->>DB: evaluate AND rule for every customer
    Orch->>DB: diff against current membership

    alt diff non-empty
        Orch->>DB: INSERT Member + SegmentDelta + OutboxEvent
        Note over Orch,MQ: chain continues to Active VIPs own dependents, terminating quietly when diff is empty
    else diff empty
        Note over Orch: no-op via natural idempotency from diff
    end
```

---

## 5. Data Model — how the persistence shape supports the design

Five tables earn their keep specifically because of the spec's requirements:

- **SegmentMember** — current membership snapshot (the "who's in?" answer).
- **SegmentDelta** — append-only history of every join/leave with a shared
  `batchId` so a consumer can fetch one logical event coherently.
- **SegmentDependency** — materialized cascade graph, so the cascade
  consumer's lookup is one indexed query instead of reparsing every rule.
- **OutboxEvent** — solves the dual-write problem between DB and broker
  (orchestrator writes outbox row inside the membership transaction; a
  separate publisher drains to RabbitMQ — at-least-once delivery).
- **ProcessedEvent** — consumer-side dedup record with composite PK
  `(eventId, consumerName)` so consumers with non-idempotent side effects
  (campaign) can safely run under at-least-once delivery.

```mermaid
erDiagram
    Customer ||--o{ Transaction : has
    Customer ||--o{ SegmentMember : "appears in"
    Customer ||--o{ SegmentDelta : "appears in"

    Segment ||--o{ SegmentMember : "current snapshot"
    Segment ||--o{ SegmentDelta : "history of joins/leaves"
    Segment ||--o{ SegmentDependency : "is parent of"
    Segment ||--o{ SegmentDependency : "is child of"

    Customer {
        uuid id PK
        string email "unique"
        string name
        jsonb profile "country, tier, joinedYear, ..."
    }

    Transaction {
        uuid id PK
        uuid customerId FK
        decimal amount "Decimal(12,2)"
        timestamp occurredAt "indexed (customerId, occurredAt)"
    }

    Segment {
        uuid id PK
        string name "unique"
        SegmentType type "DYNAMIC | STATIC"
        jsonb rule "compare | in_segment | and (recursive)"
    }

    SegmentMember {
        uuid segmentId PK
        uuid customerId PK
        timestamp joinedAt
    }

    SegmentDelta {
        uuid id PK
        uuid segmentId
        uuid customerId
        DeltaChange change "ADD | REMOVE"
        uuid batchId "shared per evaluation pass"
        timestamp occurredAt "indexed (segmentId, occurredAt)"
    }

    SegmentDependency {
        uuid parentId PK
        uuid childId PK
    }

    OutboxEvent {
        uuid id PK
        string eventType "segment.delta"
        jsonb payload
        OutboxStatus status "PENDING | PUBLISHED"
        timestamp createdAt "indexed (status, createdAt)"
        timestamp publishedAt
    }

    ProcessedEvent {
        uuid eventId PK
        string consumerName PK
        timestamp processedAt
    }
```
