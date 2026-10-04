# Architecture

```text
┌───────────────────────────────────────┐
│  Native iOS Uptime Kuma client        │
│  KumaAlert / KumaWatch / …            │
└──────────────────┬────────────────────┘
                   │ Socket.IO (Kuma internal protocol)
                   ▼
┌──────────────────────────────────────┐
│  openstatus-kuma-bridge              │
│                                     │
│    kuma/     protocol facade         │
│       ↕                             │
│    model/    normalized domain model │
│       ↕                             │
│    openstatus/  adapter              │
└──────────────────┬───────────────────┘
                   │ Connect-RPC (official SDK)
                   ▼
┌───────────────────────────────────────┐
│  OpenStatus (self-hosted)            │
│  real monitors · real probes · real  │
│  regions · real history · real status│
└───────────────────────────────────────┘
```

There is no Uptime Kuma server anywhere in this stack, and the bridge performs no
HTTP, TCP or DNS checks of its own. It translates OpenStatus data into the wire
format clients expect.

## Why this exists

Uptime Kuma has an excellent native-client ecosystem. OpenStatus has better
distributed monitoring: multiple probe regions, private locations, and an outage model
based on a 50 % quorum rather than a single vantage point. Those two things are hard
to have at once, so this project translates one into the other instead of asking you
to choose.

It is an **API/protocol compatibility facade**, not a reimplementation. It reproduces
what a client can observe, not how Uptime Kuma is built internally — no Kuma database
schema, no monitor scheduler, no copied classes.

> **This project implements an unofficial compatibility layer against Uptime Kuma's
> internal client protocol. Uptime Kuma does not guarantee backwards compatibility for
> this interface.** Uptime Kuma and OpenStatus do not endorse, support or verify this
> project. Compatibility is pinned to **Uptime Kuma 2.5.5** — see
> [compatibility.md](./compatibility.md).

## Layers

Three layers, and the dependency direction only ever points downward:

```text
src/kuma/          Uptime Kuma protocol: wire types, mappers, Socket.IO server
       ↓
src/model/         Normalized domain model — knows about neither product
       ↓
src/openstatus/    OpenStatus adapter — the only code that knows the OpenStatus API
```

| Directory | Responsibility |
| --- | --- |
| `src/config` | Zod-validated environment, secrets never printed |
| `src/model` | `NormalizedMonitor`, `NormalizedCheck`, `NormalizedStatus` |
| `src/openstatus` | SDK-backed `OpenStatusBackend` + the interface tests substitute |
| `src/kuma` | Protocol types, mappers, auth, Socket.IO server, handlers |
| `src/service` | Read-side orchestration shared by handlers and the poller |
| `src/poller` | One reconciliation loop over OpenStatus |
| `src/state` | SQLite: id map, observed checks, TTL cache with dedup |
| `src/http` | `/healthz`, `/readyz`, `/bridge/info`, `/metrics`, `/webhooks/openstatus` |
| `src/webhook` | OpenStatus webhook authentication and parsing |

The point of `src/model` is that everything above it stays testable: the poller and
the Socket.IO handlers are written against a domain model, and the tests can swap in
a fake `OpenStatusBackend` without any HTTP at all.

## Stable monitor IDs

OpenStatus monitor ids are strings like `mon_abc123`; Kuma clients expect small
integers. The mapping lives in SQLite with `AUTOINCREMENT`, so:

- ids survive restarts and reordering — never derived from array position
- a deleted monitor's id is **tombstoned, never reused**
- a monitor that disappears and returns keeps the id it always had

Losing `bridge.sqlite` is survivable but every phone will see ids change, which looks
like monitors being swapped for other monitors. Back it up — see
[deployment.md](./deployment.md#the-id-map-is-the-one-thing-you-must-persist).

## Two update paths, one derived state

**Polling** is the source of truth for reconciliation and recovery:

```env
STATUS_POLL_INTERVAL_SECONDS=30
MONITOR_LIST_REFRESH_SECONDS=60
SUMMARY_REFRESH_SECONDS=300
```

One loop, shared by every connected client — five phones do not mean five times the
upstream traffic.

**Webhook** is the fast path. Create an OpenStatus notification with provider
`WEBHOOK`, pointing at `https://kuma.example.com/webhooks/openstatus`, with a custom
header:

```env
OPENSTATUS_WEBHOOK_SECRET=<shared secret>
OPENSTATUS_WEBHOOK_SECRET_HEADER=X-Bridge-Secret
```

OpenStatus fires this **only when its quorum check actually transitioned**, so a
delivered `error` already means at least half the configured regions failed. The bridge
still re-reads the authoritative state rather than trusting the payload fields.

> OpenStatus webhooks carry **no HMAC or signature**. That shared-secret header is the
> entire authentication mechanism. The endpoint is disabled when no secret is set.

Polling and webhook can race; updates are idempotent and ordered by event time, so a
late retry cannot rewind a monitor the user already saw recover.

## Further reading

- [translation.md](./translation.md) — how multi-region results become one Kuma status
- [compatibility.md](./compatibility.md) — exactly which protocol events exist
- [protocol-research.md](./protocol-research.md) — where each behaviour was derived from