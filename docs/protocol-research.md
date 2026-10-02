# Protocol research

Everything in this document was derived by reading source, not memory or blog posts.

| Item | Pinned value | How it was obtained |
| --- | --- | --- |
| Uptime Kuma | **2.5.5** | `git clone --branch 2.5.5 https://github.com/louislam/uptime-kuma` |
| OpenStatus SDK | **@openstatus/sdk-node 0.2.0** | `npm pack @openstatus/sdk-node` |
| OpenStatus backend | monorepo HEAD `14f54a06` | `git clone --depth 1 https://github.com/openstatusHQ/openstatus` |

`docs/protocol-research.md` is the ground truth for the implementation. If a Kuma
behaviour is not listed here, it is not implemented.

> **Warning from Uptime Kuma itself:** the internal Socket.IO API is not covered by any
> compatibility guarantee. We pin to a release and verify against its source.

---

## 1. Uptime Kuma connection lifecycle (2.5.5)

Exact order, from `server/server.js` `io.on("connection")` (line 389) and
`afterLogin()` (line 1834):

```text
connect
  ├─ emit "info"            ← client.js sendInfo(socket, /* hideVersion */ true)
  │                          no version/latestVersion/runtime here
  ├─ (register all handlers)
  └─ emit "loginRequired"   ← server.js:1762 (or afterLogin + "autoLogin" if disableAuth)

client emits "login" {username,password,token} | "loginByToken" token
  → ack { ok: true, token }
  → afterLogin():
      1. socket.join(user.id)
      2. emit "monitorList"            (object keyed by numeric id)
      3. Promise.allSettled → emits, in this registration order but NOT guaranteed order:
           "info"                     ← second one, WITH version + runtime + dbType
           "maintenanceList"           (object)
           "notificationList"          (array)
           "proxyList"                 (array)
           "dockerHostList"            (array)
           "apiKeyList"                (array)
           "remoteBrowserList"         (array)
           "monitorTypeList"           (object)
      4. emit "statusPageList"
      5. for each monitor (Promise.all):
           "heartbeatList"  (monitorID, beats[<=100 oldest→newest], overwrite=false)
           then Monitor.sendStats():
             "avgPing"  (monitorID, number|null)
             "uptime"   (monitorID, 24,     number)
             "uptime"   (monitorID, 720,    number)
             "uptime"   (monitorID, "1y",   number)
             "certInfo" (monitorID, jsonString)
             "domainInfo"(monitorID, daysRemaining, expiresOn)
      6. maybe emit "initServerTimezone" (once, if setting unset)
```

Consequences for the bridge:

* **The first `info` has no `version`.** A naive client reading `info.version` on connect
  sees `undefined`. The official frontend reads it after login. We emit the *full* info
  object on both pushes — extra fields are ignored by the frontend (`src/mixins/socket.js:850`
  even tolerates a missing `version`), so this is strictly safer.
* **Clients wipe all heartbeat state on reconnect** (`src/mixins/socket.js:281-283`
  → `clearData()` → `heartbeatList = {}`). A bridge that only pushes deltas renders an
  empty dashboard after every background/foreground cycle. **We replay `heartbeatList`
  per monitor on every authentication.**
* Uptime period keys are the numbers `24` and `720` and the string `"1y"` — **not**
  `"24h"`/`"30d"` (`server/model/monitor.js:1331-1339`, consumed at
  `src/components/Uptime.vue:33`, `MonitorListItem.vue:28`, `Details.vue:238,247,256`).

### Transport / origin

`server/uptime-kuma-server.js:148-199`. `path` is the socket.io default `/socket.io/`.
`cors` is only set in dev. `allowRequest`: polling always allowed; websocket allowed when
`Origin === Host`, when `Origin` is absent (native clients), or when
`UPTIME_KUMA_WS_ORIGIN_CHECK=bypass`. Socket.IO auth is **not** used for authentication —
`src/mixins/socket.js:120` is literally `io(url)`, so every client is anonymous until the
`login` / `loginByToken` event.

---

## 2. Event table (implemented surface)

### Client → server

| Event | Arguments | Ack | Bridge support |
| --- | --- | --- | --- |
| `login` | `({username, password, token?}, cb)` | `{ok:true, token}` / `{ok:false,msg,msgi18n}` | ✅ |
| `loginByToken` | `(token, cb)` | `{ok:true}` / `{ok:false,msg,msgi18n}` | ✅ |
| `logout` | `(cb)` | `{ok:true}` | ✅ |
| `getMonitor` | `(monitorID, cb)` | `{ok:true, monitor}` / `{ok:false,msg}` | ✅ |
| `getMonitorBeats` | `(monitorID, periodHours, cb)` | `{ok:true, data:[beat]}` / `{ok:false,msg}` | ✅ |
| `getMonitorChartData` | `(monitorID, periodHours, cb)` | `{ok:true, data:[point]}` / `{ok:false,msg}` | ✅ |
| `getMonitorList` | `(cb)` | `{ok:true, monitorList}` | ✅ |
| `pauseMonitor` | `(monitorID, cb)` | `{ok:true}` | ✅ (Phase 2) |
| `resumeMonitor` | `(monitorID, cb)` | `{ok:true}` | ✅ (Phase 2) |
| `getSettings` | `(cb)` | `{ok:true, data:{...}}` | ✅ (minimal) |
| `getTags` | `(cb)` | `{ok:true, tags:[]}` | ✅ (empty) |
| `clearEvents` | `(monitorID, cb)` | `{ok:true}` | ✅ (ack, no-op) |
| `addNotification` / `deleteNotification` / `testNotification` | | | ❌ `{ok:false,msg}` |
| `add` / `editMonitor` / `deleteMonitor` | | | ❌ `{ok:false,msg}` |
| `checkDomain`, `twoFAStatus`, `prepare2FA`, `save2FA`, `disable2FA`, `verifyToken`, `getGameList`, `getPM2ProcessList`, `checkApprise`, `getWebpushVapidPublicKey`, `needSetup`, `setup`, `changePassword`, `setSettings`, docker/proxy/remote-browser/status-page/maintenance/API-key/backup events | | | ❌ `{ok:false,msg}` |

`msgi18n: true` means "translate `msg` as an i18n key" (`Login.vue:65` does `$t(res.msg)`).
Kuma uses keys `authIncorrectCreds`, `authInvalidToken`, `authUserInactiveOrDeleted`. We reuse
those keys verbatim so translated clients render proper text; the raw string is still
meaningful for clients that do not translate.

### Server → client

| Event | Payload | Bridge |
| --- | --- | --- |
| `info` | `{primaryBaseURL, serverTimezone, serverTimezoneOffset, version, latestVersion, isContainer, dbType, runtime:{platform,arch}}` | ✅ |
| `loginRequired` | *(none)* | ✅ |
| `monitorList` | **object keyed by id**, value = full monitor JSON | ✅ |
| `updateMonitorIntoList` | object keyed by id (1 entry) | ✅ |
| `deleteMonitorFromList` | bare numeric id | ✅ |
| `heartbeatList` | `(monitorID, beats[], overwrite)` | ✅ |
| `heartbeat` | single beat object | ✅ |
| `avgPing` | `(monitorID, number\|null)` | ✅ |
| `uptime` | `(monitorID, 24\|720\|"1y", fraction0to1)` | ✅ |
| `notificationList` | array | ✅ (empty) |
| `maintenanceList` | object | ✅ (empty) |
| `proxyList` | array | ✅ (empty) |
| `dockerHostList` | array | ✅ (empty) |
| `apiKeyList` | array | ✅ (empty) |
| `remoteBrowserList` | array | ✅ (empty) |
| `monitorTypeList` | object | ✅ (only http/port/dns) |
| `certInfo` | `(monitorID, JSON **string**)` | 🚫 deliberately not sent |
| `domainInfo` | `(monitorID, daysRemaining, expiresOn)` | 🚫 not sent |
| `statusPageList` | array | ✅ (empty) |
| `refresh` | *(none)* — client does `location.reload()` | 🚫 not sent |

`statusPageList` is emitted by `StatusPage.sendStatusPageList`. We emit `[]` because the
official frontend flips `statusPageListLoaded` on it and a missing event leaves pages in a
loading state.

---

## 3. Minimum viable monitor object

`Monitor.toJSON()` (`server/model/monitor.js:1020+`) returns ~90 fields. The frontend only
*requires* these to render a row (`src/pages/MonitorList.vue`, `MonitorListItem.vue`):

| Field | Type | Why required |
| --- | --- | --- |
| `id` | number | identity, routing, `uptimeList` keys |
| `name` | string | `.toLowerCase()` / `.localeCompare()` |
| `active` | boolean | `.disabled` class and sort |
| `tags` | **array** | `monitor.tags.length`, `.find()` |
| `childrenIDs` | **array** | `.includes()` unguarded in `beforeMount` |
| `parent` | `null` | root list filters `monitor.parent !== null` |
| `weight` | number | sort |
| `type` | string | detail-page branching, group detection |
| `interval` | number | heartbeat bar tick spacing |

Plus, for the detail page (`Details.vue`) and to avoid client-side crashes: `url`,
`hostname`, `port`, `description`, `path`, `pathName`, `notificationIDList` (object),
`maintenance`, `timeout`, `retryInterval`, `resendInterval`, `maxretries`, `method`,
`keyword`, `dns_resolve_type`, `dns_resolve_server`, `dns_last_result`, `accepted_statuscodes`.

We emit the full required set with safe defaults. `headers`, `body`, `basic_auth_*`,
`oauth_*` are deliberately **omitted** — the bridge never holds OpenStatus monitor secrets,
and the frontend guards those fields (`EditMonitor.vue` optional-chains them).

Monitor type strings the client understands: `http`, `port`, `dns` are all in the official
UI list (`EditMonitor.vue:38-63`) and in the server registry
(`server/uptime-kuma-server.js:113-138`). We use exactly those three.

---

## 4. Heartbeat object

Table columns are the payload of `getMonitorBeats` (`server/server.js:1059`) and the
`heartbeat` push is `bean.toJSON()` of the same row (`server/model/monitor.js:1065`):

```ts
interface KumaHeartbeat {
  monitor_id: number;
  status: 0 | 1 | 2 | 3;   // DOWN | UP | PENDING | MAINTENANCE
  time: string;            // R.isoDateTimeMillis(dayjs.utc()) → "2026-10-01T21:30:00.000Z"
  msg: string;
  ping: number | null;
  duration: number;        // seconds, the interval used for the check
  important: number | 0 | 1;  // integer in DB; frontend truthiness-checkes it
  retries: number;
  down_count: number;
  end_time: string | null;
  local_date_time: string | null;
  timezone: string | null;
  response?: string;       // 2.x addition
}
```

**`monitorID` vs `monitor_id`.** The *pushed* `heartbeat` event is consumed with
`data.monitorID` (`src/mixins/socket.js:204-234`), because `bean.toJSON()` camelCases
`monitor_id`. The `getMonitorBeats` **ack** returns raw rows with snake_case `monitor_id`
and is consumed by `PingChart.vue` keyed by the requested monitor. We emit both spellings on
both paths — harmless extra field for strict JSON parsers, and removes an entire class of
client-version guesswork.

### `important` semantics (must be reproduced exactly)

`Monitor.isImportantBeat` (`server/model/monitor.js:1391`):

```
first beat                          → important
UP   -> PENDING                     → NOT important
PENDING -> UP                       → NOT important
PENDING -> DOWN                     → important
DOWN  -> DOWN                       → NOT important
UP    -> DOWN / DOWN -> UP          → important
*     -> MAINTENANCE / MAINTENANCE -> * → important
```

i.e. **anything involving `PENDING` (2) is not important except `PENDING -> DOWN`.** This
directly affects the degraded mapping: with `DEGRADED_STATUS_MAPPING=pending` (our default),
a degradation produces `important=false`, so the official UI shows no toast. That is Kuma's
own behaviour for pending, and we keep it rather than lying about the semantics. The
heartbeat `msg` always spells out the real OpenStatus reason.

`Monitor.isImportantForNotification` (line 1424) is a strict subset (MAINTENANCE never
notifies). We do not drive native push from this bit — see §7.

### Uptime semantics (must be reproduced exactly)

`server/uptime-calculator.js` `flatStatus()`:

```
UP (1)          -> UP
MAINTENANCE (3) -> UP     ← maintenance counts as uptime!
DOWN (0)        -> DOWN
PENDING (2)     -> DOWN   ← pending counts as downtime!
```

`getData()` then computes:

```
uptime  = total.up / (total.up + total.down)     // fraction 0..1
avgPing = Σ(bucket.avgPing * bucket.up) / total.up   // true mean over UP beats
```

and pushes that fraction directly — `Uptime.vue:35-42` does `Math.round(x * 10000) / 100`.
`avgPing` is the **mean**, never a percentile, and `null` when `up === 0`.

Consequences: with our default degraded→pending mapping, degraded time is counted as
downtime in Kuma's uptime formula. OpenStatus counts `degraded` separately from `failed`
in `GetMonitorSummary`. We document the divergence and make it configurable
(`DEGRADED_STATUS_MAPPING=up` makes degraded time count as uptime instead).

### Chart data point shape

`getMonitorChartData` → `UptimeCalculator.getDataArray()` (`chart-socket-handler.js`). Note
this is **not** the `{timestamp, up, down, ping, pingMin, pingMax}` shape commonly quoted in
old blog posts:

```ts
interface KumaChartPoint {
  timestamp: number;   // unix SECONDS of the bucket start
  up: number;
  down: number;
  avgPing: number;
  minPing: number;
  maxPing: number;
  maintenance?: number;
}
```

`src/components/PingChart.vue:295-348` reads exactly `up`, `down`, `avgPing`, `minPing`,
`maxPing`, `maintenance`, `timestamp`. Bucket resolution follows the server:
`period <= 24` → 1-minute buckets, `<= 720` → 1-hour buckets, else 1-day buckets.
Ping buckets are only populated by UP beats (`uptime-calculator.js` `update()`), and
`down` counts DOWN + PENDING via `flatStatus`.

---

## 5. OpenStatus → bridge mapping

### Client

`@openstatus/sdk-node` is Connect-RPC/protobuf over fetch:

```ts
import { createClient } from "@openstatus/sdk-node";
const client = createClient({ baseUrl, apiKey });
```

* default base URL `https://api.openstatus.dev/rpc`
* `baseUrl` option → `OPENSTATUS_API_URL` env → default. **Self-hosted works.**
* auth header `x-openstatus-key: <apiKey>` (`Authorization: Bearer` also accepted server-side)
* no runtime-side fallback to a fixed URL: `OPENSTATUS_API_URL` is bridge config only, never
  client-controllable.

### Monitors

`listMonitors` returns **three separate arrays** (`httpMonitors`, `tcpMonitors`,
`dnsMonitors`) plus `totalSize`, paged with `limit ≤ 100` / `offset`. The bridge must
paginate to support >100 monitors.

`getMonitor` returns a oneof `MonitorConfig` (`{http}|{tcp}|{dns}`).

| Concern | HTTP | TCP | DNS |
| --- | --- | --- | --- |
| id | `id: string` | same | same |
| target | `url: string` | `uri: string` (`tcp://host:port`) | `uri: string` |
| periodicity | `Periodicity` enum | same | same |
| method | `HTTPMethod` enum | — | — |
| timeout | `i64` ms (0–120000) | same | same |
| degraded threshold | `degraded_at?: i64` ms | same | same |
| retry | `i64` 0–10 | same | same |
| regions | `Region[]` (≤28) | same | same |
| private locations | `privateLocationIds: string[]` **(read-only)** | same | same |
| monitor-wide status | `status: MonitorStatus` | same | same |
| active | `active?: bool` (default false) | same | same |

`Periodicity` = `30S | 1M | 5M | 10M | 30M | 1H`. DB value `"other"` is **not
representable** and round-trips as `UNSPECIFIED`.

`MonitorStatus` = `UNSPECIFIED(0) | ACTIVE(1) | DEGRADED(2) | ERROR(3)`.
**There is no PENDING and no MAINTENANCE monitor status.**
Per-check status in response logs is `UNSPECIFIED | SUCCESS | ERROR | DEGRADED`.

### Multi-region semantics — the important part

OpenStatus computes the monitor-wide status **server-side with a 50 % quorum**, in
`apps/workflows/src/checker/quorum.ts:16`:

```ts
export function quorumMetSql(affected: SQL, total: SQL): SQL {
  return sql`${affected} * 2 >= ${total}`;   // affected * 2 >= total
}
```

with `total` = number of the monitor's **configured regions** (`quorumGuardSql` requires
`regionCount > 0`), and the update is a compare-and-swap that only fires on an actual
change (`apps/workflows/src/checker/transition.ts:198-207`).

`getMonitorStatus` returns **raw per-region rows only** — `{regions: [{region, status}]}`,
no aggregate, and it does **not** re-apply quorum (`packages/services/src/monitor/get-monitor-status.ts:41-55`).

Therefore:

> **The authoritative monitor-wide status is `monitor.status` from `listMonitors` /
> `getMonitor`.** The per-region rows are for display and latency, not for state.

Our default `StatusAggregator` (`openstatus`) uses `monitor.status` directly. `worst`,
`majority` (= OpenStatus's quorum), `all`, `minimumHealthy` are available for users who
want a different view. Quorum is reimplemented locally only as a fallback for the case
where `monitor.status` is `UNSPECIFIED` but per-region data exists.

**Known divergence:** private-location checks never appear in `getMonitorStatus.regions`
(they are not in the `Region` enum and `stringsToRegions` drops them), yet a monitor with
private locations still has a quorum denominator. We therefore never recompute state from
per-region rows unless `monitor.status` is `UNSPECIFIED`.

### Latency

Two sources:

* `getMonitorSummary` → `p50, p75, p90, p95, p99` as **`i64`** (BigInt in TS), plus
  `lastPingAt`, `totalSuccessful`, `totalDegraded`, `totalFailed`, `timeRange`, `regions`.
  `TimeRange` = `1D | 7D | 14D` (UNSPECIFIED → `1D`). With no data everything is `0` and
  `lastPingAt` is `""`.
* `listMonitorHTTPResponseLogs` → per-request `latency` (i32 ms), `region`,
  `cronTimestamp` (unix ms), `timestamp` (unix ms), `statusCode?`, `requestStatus`,
  `trigger` (CRON|API), `id?`, `timing?`.

**Gap:** `listResponseLogs` hard-rejects non-HTTP job types
(`packages/services/src/monitor/list-response-logs.ts:51-55`). There are **no TCP/DNS/ICMP
response-log RPCs**, so for TCP and DNS monitors the only latency available is the
percentile aggregate from `getMonitorSummary`. The bridge uses `p50` for those and labels
the source accordingly. Response logs are also plan-gated (`response-logs` workspace limit).

We use response-log latency when available (median of the successful checks in the newest
logical run) and fall back to `p50` from the summary. We never label `p50` as an average.

### Webhooks — the real-time path

OpenStatus' `NotificationProvider.WEBHOOK` posts a flat JSON body
(`packages/notifications/webhook/src/schema.ts:6-17`):

```json
{
  "monitor": { "id": 123, "name": "Mini-PC", "url": "https://example.com" },
  "cronTimestamp": 1744023705307,
  "status": "error" | "recovered" | "degraded",
  "statusCode": 500,
  "latency": 1337,
  "errorMessage": "Internal Server Error"
}
```

Key properties, all verified in source:

* Sent **only when the quorum CAS actually transitioned** (`checker/index.ts:186-196`
  guards on `transition.transitioned`) → a delivered `error` means ≥50 % of configured
  regions failed. **This is the correct outage signal; we use it for state changes and
  never let a single probe trigger a client-visible transition.**
* `status` uses the word **`recovered`**, not `active`.
* **No HMAC / no signature.** Docs state the only verification is a custom header, e.g. a
  shared secret. We require one, compared in constant time.
* `monitor.id` is a **number** here while the RPC layer exposes **string** ids — coerce.
* At-least-once delivery with 3 retries and dedup on
  `(monitorId, notificationId, cronTimestamp)` → **`cronTimestamp` is the idempotency key.**
* Payload carries no regions, no periodicity, no description.

### Maintenance

`MaintenanceService`: `createMaintenance / getMaintenance / listMaintenances /
updateMaintenance / deleteMaintenance`. Timestamps are RFC3339 **strings**.

> **Maintenance in OpenStatus is scoped to status pages** (`page_id` +
> `page_component_ids`), not to monitors. There is no per-monitor maintenance window.
> The bridge therefore emits an **empty `maintenanceList`** and does not synthesize
> `MAINTENANCE` heartbeats. Documented in COMPATIBILITY.md rather than faked.

### Tags

Monitor tags exist in OpenStatus' DB layer but appear in **no** `monitor/v1/*.proto`.
There is nothing to map. `tags: []`, `notificationIDList: {}`.

---

## 6. Status mapping table

| OpenStatus | Normalized | Kuma (default) | Notes |
| --- | --- | --- | --- |
| `ACTIVE` | `up` | `1` UP | |
| `ERROR` | `down` | `0` DOWN | |
| `DEGRADED` | `degraded` | `2` PENDING | configurable: `pending`\|`up`\|`down` |
| monitor `active=false` | `unknown` | `2` PENDING | paused monitors show paused in the UI regardless of beat |
| no data yet | `unknown` | `2` PENDING | |
| maintenance | — | — | not modelled by OpenStatus |
| backend unreachable | *unchanged* | *unchanged* | never turns monitors DOWN |

`DEGRADED → PENDING` is a deliberate compatibility compromise: PENDING renders yellow/warning
in every Kuma client, which communicates "not healthy" without asserting an outage. It is
**not** semantically identical — PENDING in Kuma means "waiting for a retry", degraded in
OpenStatus means "responses succeeded but exceeded `degraded_at`". Every synthesized
heartbeat message states the OpenStatus reason explicitly, and `degraded` is preserved in the
normalized model and the chart data regardless of the Kuma status chosen.

---

## 7. Notification / push stance

OpenStatus' webhook only fires on a quorum transition, so it is a strictly better outage
signal than anything the bridge could infer from polling. Rule adopted:

* **Client-visible state transitions** come from `monitor.status` (polled) and from the
  webhook (immediate).
* **Polling never contradicts the webhook**: an older webhook cannot overwrite newer polled
  state (compare `cronTimestamp` / `updatedAt`, last-write-wins by event time).
* **Push**: Phase 1 emits no push at all. Phase 6 will relay, not re-derive, OpenStatus
  transitions. We will not re-implement alert thresholds.

---

## 8. Confidence

| Kuma concept | Direction | OpenStatus source | Confidence | Notes |
| --- | --- | --- | --- | --- |
| `info` | S→C | — | High | 2.5.5 `client.js:146` |
| `loginRequired` | S→C | — | High | `server.js:1762` |
| `login` / `loginByToken` | C→S | — | High | `server.js:401,450` |
| `monitorList` | S→C | `listMonitors` + `monitor.status` | High | ID map + type/field mapping |
| `updateMonitorIntoList` / `deleteMonitorFromList` | S→C | `listMonitors` diff | High | object / bare id |
| `getMonitor` | C→S | `getMonitor` | High | |
| `heartbeatList` | S→C | `listMonitorHTTPResponseLogs` or derived | Medium | TCP/DNS latency unavailable |
| `heartbeat` | S→C | `monitor.status` + webhook | High | quorum respected |
| `avgPing` | S→C | mean over UP heartbeats (own calc) | High | never reuse p50 |
| `uptime` | S→C | own calc from normalized beats | High | exact `flatStatus` semantics |
| `getMonitorBeats` | C→S | response logs | Medium | HTTP only; TCP/DNS → synthetic-free empty |
| `getMonitorChartData` | C→S | response logs → buckets | Medium | exact Kuma bucket shapes |
| `pauseMonitor` / `resumeMonitor` | C→S | `update*HTTPMonitor.active` | High | partial update |
| retest | C→S | `triggerMonitor` | High | good semantic match |
| `notificationList` | S→C | local store | Low | only if a target client needs it |
| `maintenanceList` | S→C | — | High (empty) | OpenStatus maintenance is page-scoped |
| `tags` | S→C | — | High (empty) | not exposed by OpenStatus RPC |
| `certInfo` / `domainInfo` | S→C | — | High (omit) | no cheap authoritative source |

## 9. Still unknown — needs a real device

These cannot be derived from source and are explicitly **not** implemented until observed:

1. Whether a native client requires `statusPageList`/`monitorTypeList` at all.
2. Which target app implements native push, and via which mechanism (§ Milestone 6).
3. Whether any client sends `getMonitorBeats` with a period larger than 720.
4. Whether any client reads `info.version` on the *first* push (before login).

Method for closing these gaps is in README §"Contributing protocol captures" and
`scripts/protocol-probe.ts`. Observe traffic on our own server only.