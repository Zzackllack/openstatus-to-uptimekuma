# openstatus-kuma-bridge

Makes a self-hosted **OpenStatus** instance answer as though it were an **Uptime Kuma**
server, so that native Uptime Kuma iOS clients (KumaAlert, KumaWatch, Uptime Kuma
Manager, …) can be used while OpenStatus stays the actual monitoring backend.

There is no Uptime Kuma server anywhere in this stack. There is no second monitoring
system. The bridge performs no HTTP, TCP or DNS checks of its own — it translates
OpenStatus' data into the wire format those clients expect.

```text
┌───────────────────────────────────────┐
│  Native iOS Uptime Kuma client        │
│  KumaAlert / KumaWatch / …            │
└──────────────────┬────────────────────┘
                   │ Socket.IO (Kuma internal protocol)
                   ▼
┌───────────────────────────────────────┐
│  openstatus-kuma-bridge               │
│                                      │
│    kuma/     protocol facade          │
│       ↕                              │
│    model/    normalized domain model  │
│       ↕                              │
│    openstatus/  adapter               │
└──────────────────┬───────────────────┘
                   │ Connect-RPC (official SDK)
                   ▼
┌───────────────────────────────────────┐
│  OpenStatus (self-hosted)             │
│  real monitors · real probes · real   │
│  regions · real history · real status │
└───────────────────────────────────────┘
```

---

## Why this exists

Uptime Kuma has an excellent native-client ecosystem. OpenStatus has better
distributed monitoring: multiple probe regions, private locations, and an outage model
based on a 50 % quorum rather than a single vantage point. Those two things are hard
to have at once, so this project translates one into the other instead of asking you
to choose.

It is an **API/protocol compatibility facade**, not a reimplementation. It reproduces
what a client can observe, not how Uptime Kuma is built internally. No Kuma database
schema, no monitor scheduler, no copied classes.

> **This project implements an unofficial compatibility layer against Uptime Kuma's
> internal client protocol. Uptime Kuma does not guarantee backwards compatibility for
> this interface.** Uptime Kuma and OpenStatus do not endorse, support or verify this
> project. Compatibility is pinned to **Uptime Kuma 2.5.5** — see
> [COMPATIBILITY.md](./COMPATIBILITY.md).

---

## Architecture

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
| `src/http` | `/healthz`, `/bridge/info`, `/metrics`, `/webhooks/openstatus` |
| `src/webhook` | OpenStatus webhook authentication and parsing |

### Stable monitor IDs

OpenStatus monitor ids are strings like `mon_abc123`; Kuma clients expect small
integers. The mapping lives in SQLite with `AUTOINCREMENT`, so:

- ids survive restarts and reordering — never derived from array position
- a deleted monitor's id is **tombstoned, never reused**
- a monitor that disappears and returns keeps the id it always had

Losing `bridge.sqlite` is survivable but every phone will see ids change, which looks
like monitors being swapped for other monitors. Back it up.

---

## Installation

Requires **Node.js 22.4+** and pnpm.

```bash
pnpm install
cp .env.example .env
```

Generate the two secrets:

```bash
pnpm bridge password hash    # -> BRIDGE_PASSWORD_HASH
pnpm bridge secret           # -> JWT_SECRET (48 random bytes)
```

Then set your OpenStatus API key and public URL in `.env`:

```env
OPENSTATUS_API_URL=https://openstatus.example.com/rpc
OPENSTATUS_API_KEY=os_api_xxx
PUBLIC_BASE_URL=https://kuma.example.com
```

```bash
pnpm build
pnpm start
```

Verify:

```bash
curl -s https://kuma.example.com/bridge/info | jq
```

### OpenStatus API key

Create it in the OpenStatus dashboard. A `read` scope key is enough unless you use
pause/resume, which needs `write`. Scope is immutable — revoke and reissue to change
it. The key is used **only** server-side and is never sent to a client, never logged,
and never returned by any endpoint.

```bash
# confirm the key works
curl -s -H "x-openstatus-key: $OPENSTATUS_API_KEY" \
  https://openstatus.example.com/v1/whoami | jq '.actor.scopes'
```

---

## Docker

```bash
docker compose -f docker-compose.example.yml up -d --build
```

The container runs as a non-user `node`, has a read-only root filesystem, and keeps
only `/app/data` writable (that is where the id map lives). Graceful shutdown on
`SIGTERM`; a healthcheck polls `/healthz`.

> **`read_only: true` + the id map.** If you remove the `./data:/app/data` volume,
> the SQLite file disappears with the container and every monitor gets a new id on
> the next start. Keep the volume.

---

## Reverse proxy

One upstream serves `/healthz`, `/bridge/info`, `/metrics`, `/webhooks/openstatus`
and the Socket.IO transport (default path `/socket.io/`).

**Caddy** — WebSocket support is automatic:

```caddy
kuma.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx:**

```nginx
server {
    listen 443 ssl http2;
    server_name kuma.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Socket.IO long-polling fallback needs a long read timeout.
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
```

Set `TRUST_PROXY=true` so client IPs used for login rate limiting come from
`X-Forwarded-For` rather than the proxy's own address.

`PUBLIC_BASE_URL` must be the **externally reachable** origin. Clients receive it as
`info.primaryBaseURL` and build links from it, so `localhost` will produce broken
links in the app.

---

## Adding the server to an iPhone client

```text
Server:   https://kuma.example.com
Username: cedric
Password: <what you typed into `pnpm bridge password hash`>
```

These are **bridge** credentials. They are never forwarded to OpenStatus. The bridge
authenticates you locally and talks to OpenStatus with its own API key, so a leaked
phone credential cannot escalate into an OpenStatus session.

Remembered login uses a JWT signed with `JWT_SECRET`, which also carries a hash of
the stored password — changing `BRIDGE_PASSWORD_HASH` invalidates every remembered
login.

---

## Supported features

```text
✅ connect, authenticate, remembered login
✅ monitor list (HTTP / TCP / DNS) with stable synthetic ids
✅ current UP / DOWN / DEGRADED / PAUSED state
✅ response time (median across regions)
✅ average latency (true mean, never a mislabelled percentile)
✅ uptime for 24 h / 30 d / 1 y
✅ heartbeat history, one entry per logical check
✅ response-time and uptime charts
✅ live updates via polling and OpenStatus webhooks
✅ pause / resume (mutates OpenStatus)
✅ reconnect after backgrounding, restarting or switching networks
```

## Unsupported

```text
❌ monitor creation, editing, deletion
❌ notification providers and native push (next milestone)
❌ maintenance windows (OpenStatus scopes them to status pages, not monitors)
❌ tags (not exposed by OpenStatus's RPC API)
❌ certificate / domain expiry info
❌ status pages and incidents
❌ Docker hosts, proxies, remote browsers, database management, backups, 2FA
```

Every unsupported event returns
`{ok: false, msg: "Not supported by OpenStatus compatibility bridge"}` and is logged.
The bridge never pretends a mutation succeeded.

---

## Multi-region aggregation semantics

One OpenStatus monitor, however many probe locations, is **one** Kuma monitor. The
bridge never creates one fake monitor per region.

OpenStatus decides monitor-wide health server-side with a **50 % quorum**: an outage
requires `affected * 2 >= total` over the monitor's configured regions. That is what
the bridge uses by default, because re-deriving it locally would use a different
denominator — `getMonitorStatus` omits private locations entirely.

```env
STATUS_AGGREGATION_STRATEGY=openstatus   # default; trust OpenStatus
#                          =majority    # recompute the quorum locally
#                          =worst       # any failing region ⇒ down
#                          =all         # every region must be up
#                          =any         # at least one region must be up
```

Representative latency is the **median** of the successful regions, because one
geographically distant probe should not represent the fleet:

```env
LATENCY_AGGREGATION=median   # default; also mean | min | max | p50
```

## Degraded-status mapping

OpenStatus has `DEGRADED`; Kuma has no equivalent. `PENDING` renders yellow — "not
healthy" without claiming an outage — which is why it is the default:

```env
DEGRADED_STATUS_MAPPING=pending   # default
#                        =up      # degraded counts as uptime
#                        =down    # degraded counts as downtime
```

The compromise is real and is not hidden: Kuma counts `PENDING` as **downtime** for
uptime, and never marks a transition into PENDING as important. So every synthesized
heartbeat `msg` states the OpenStatus reason outright, for example:

```text
Degraded — latency above configured threshold (threshold 500 ms) · 3/4 locations healthy
```

---

## Real-time updates

Two mechanisms, one derived state:

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

---

## Failure behaviour

**An unreachable OpenStatus never turns your monitors red.** It would be a
catastrophic false alarm.

The bridge keeps last-known state, marks it internally stale after
`STALE_AFTER_SECONDS`, and reports the failure on `/healthz`:

```json
{ "status": "degraded", "openstatus": "unavailable", "monitors": 12 }
```

Liveness and readiness are deliberately separate endpoints:

| Endpoint | Meaning | During an OpenStatus outage |
| --- | --- | --- |
| `GET /healthz` | is this process alive? | `200` — it is still serving last-known state |
| `GET /readyz` | can it refresh state right now? | `503` |

Conflating them would be a trap: an orchestrator that restarts the container on an
unhealthy liveness probe would turn a temporary OpenStatus blip into a total loss of
visibility. The Docker `HEALTHCHECK` uses `/healthz` for exactly this reason.

No heartbeat is emitted with a fresh timestamp for data the bridge did not just
observe.

---

## Configuration

Every variable is documented in [`.env.example`](./.env.example). Invalid
configuration fails at startup, and secrets are never printed in the error.

Frequently changed:

| Variable | Default | Notes |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | — | Required, https. Sent to clients as `primaryBaseURL`. |
| `OPENSTATUS_API_URL` | managed API | Point at your self-hosted `/rpc`. |
| `MAX_OPENSTATUS_CONCURRENCY` | `5` | OpenStatus allows 600 req/min per key. |
| `HISTORY_SOURCE` | `auto` | `openstatus` for HTTP logs, bridge observations for TCP/DNS. |
| `MAX_HISTORY_HOURS` | `720` | Hard cap on any client request. |
| `ALLOWED_ORIGINS` | *(empty)* | Restrict browser clients. Native clients send no `Origin`. |

---

## Observability

```bash
curl -s https://kuma.example.com/healthz   | jq   # liveness
curl -s https://kuma.example.com/readyz    | jq   # readiness
curl -s https://kuma.example.com/bridge/info | jq # bridge diagnostics
curl -s https://kuma.example.com/metrics
```

`/bridge/info` is the bridge's own diagnostics and is deliberately **separate** from
the Kuma protocol, so no custom keys ever have to be smuggled into a `monitorList`
payload where a strict client might reject them.

Structured logs, never containing passwords, tokens, API keys, notification
credentials or `Authorization` headers:

```json
{"level":"info","event":"socket.auth.success","clientId":"…","user":"cedric"}
{"level":"info","event":"monitor.transition","monitorKumaId":1,"from":"up","to":"down","important":true}
{"level":"warn","event":"kuma.event.unsupported","event":"addNotification","hasCallback":true}
```

Useful knobs:

```env
LOG_LEVEL=debug        # verbose
LOG_PROTOCOL=true      # log every inbound Kuma event name (development only)
```

---

## Troubleshooting

**Client says "server unreachable"**
Check `PUBLIC_BASE_URL` is the external origin, and that the proxy forwards
WebSocket upgrades. Test with
`curl -i 'https://kuma.example.com/socket.io/?EIO=4&transport=polling'` — you should
get a 200 with an Engine.IO open packet.

**Monitor list is empty**
`curl -s https://kuma.example.com/bridge/info | jq '.monitors'`. If `openstatusConnected`
is `false`, the API key or URL is wrong; `/healthz` gives detail. Note `listMonitors`
paginates 100 at a time.

**Charts or uptime are empty for a TCP/DNS monitor**
Expected, and documented in [COMPATIBILITY.md](./COMPATIBILITY.md): OpenStatus exposes
response logs for HTTP monitors only. TCP/DNS history starts accumulating once the
bridge has been running.

**Everything shows PENDING**
Check whether the monitors are actually degraded in OpenStatus, and what
`DEGRADED_STATUS_MAPPING` is set to.

**Push notifications do not arrive**
Not implemented yet. See Milestone 6 in the roadmap below.

**Ids changed / monitors look swapped**
`data/bridge.sqlite` was lost or replaced. Restore the volume.

---

## Development

```bash
pnpm dev            # watch mode
pnpm build          # compile to dist/
pnpm start          # run the build

pnpm lint
pnpm typecheck
pnpm test           # everything
pnpm test:unit
pnpm test:integration
pnpm test:contract  # real Socket.IO server + real client

pnpm smoke          # boot the built artifact and drive it end to end
pnpm protocol:capture -- --url http://localhost:3000 --user cedric
```

`pnpm smoke` exists because the test runner's module transform hides real ESM/CJS and
native-module problems. It boots `dist/` and exercises the protocol for real.

Opt-in tests against a real OpenStatus (read-only by default):

```bash
OPENSTATUS_INTEGRATION_TEST=1 \
OPENSTATUS_API_URL=https://openstatus.example.com/rpc \
OPENSTATUS_API_KEY=... \
pnpm test:integration:openstatus
```

### Manual test matrix

The real measure of compatibility is a real device. See
[COMPATIBILITY.md](./COMPATIBILITY.md#manual-test-matrix).

---

## Roadmap

```text
✅ Milestone 0  protocol research, pinned to Kuma 2.5.5
✅ Milestone 1  connection + authentication
✅ Milestone 2  monitor list with persistent id translation
✅ Milestone 3  current status, regional aggregation, latency, uptime
✅ Milestone 4  history, logical-check grouping, charts
✅ Milestone 5  polling reconciliation + webhook ingestion
⬜ Milestone 6  native push for one target client
✅ Milestone 7  pause / resume (part of the current build)
```

---

## Contributing protocol captures

Only against servers you own. `scripts/protocol-probe.ts` is an ordinary Socket.IO
**client** — it connects, authenticates and records. It does not intercept, patch or
proxy traffic, and it makes no attempt to defeat certificate pinning or extract
secrets from third-party services.

```bash
docker run -d --name kuma -p 3001:3001 louislam/uptime-kuma:2.5.5
pnpm protocol:capture -- --url http://localhost:3001 --user admin --password admin \
  --out tests/fixtures/kuma/2.5.5/session.json
```

Passwords, tokens, notification configs, API keys and (by default) hostnames are
redacted before anything is written. Never commit production credentials or real
monitor data. Details in
[COMPATIBILITY.md](./COMPATIBILITY.md#contributing-protocol-captures).

---

## License

MIT — see [LICENSE](./LICENSE).

Uptime Kuma is licensed under MIT and OpenStatus under Apache-2.0; this project studies
both and reproduces protocol *behaviour*, not their code. Protocol shapes derived from
reading their source are facts about an interface, and are attributed in
`docs/protocol-research.md` with file and line references.