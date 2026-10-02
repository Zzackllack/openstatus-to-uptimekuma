# Compatibility

## Uptime Kuma protocol

| Item | Value |
| --- | --- |
| Pinned release | **2.5.5** (`louislam/uptime-kuma`, tag `2.5.5`) |
| Exposed as | `KUMA_COMPATIBILITY_VERSION` in `src/kuma/protocol/version.ts` |
| Verified against | server handlers, `Monitor.toJSON()`, `UptimeCalculator`, and the official Vue frontend consumers |
| Last verified | 2026-10-02 |

This project implements an **unofficial compatibility layer** against Uptime Kuma's
internal client protocol. Uptime Kuma does not guarantee backwards compatibility for
that interface, and does not endorse or support this project. A Uptime Kuma upgrade
may break it; see `docs/protocol-research.md` for exactly which release and which
files each behaviour was derived from.

There is no claim of universal compatibility. Only the surface below is implemented.

---

## Server → client events

| Event | Status | Notes |
| --- | --- | --- |
| `info` | ✅ | Sent twice, as Kuma does: once on connect, once after login. Always includes `version`. |
| `loginRequired` | ✅ | Emitted after handlers are registered. |
| `monitorList` | ✅ | Object keyed by synthetic numeric id. |
| `updateMonitorIntoList` | ✅ | Single-entry keyed object, after pause/resume. |
| `deleteMonitorFromList` | ✅ | Bare numeric id. |
| `heartbeatList` | ✅ | `(monitorID, beats[], overwrite=true)`, oldest-first, up to `INITIAL_HEARTBEAT_COUNT`. |
| `heartbeat` | ✅ | Only on real status transitions. |
| `avgPing` | ✅ | True mean over UP beats, or `null`. |
| `uptime` | ✅ | Period keys `24`, `720`, `"1y"`; value is a fraction 0..1. |
| `notificationList` | ✅ (empty) | No notifications are implemented yet. |
| `maintenanceList` | ✅ (empty) | See "Maintenance" below. |
| `proxyList` | ✅ (empty) | |
| `dockerHostList` | ✅ (empty) | |
| `apiKeyList` | ✅ (empty) | |
| `remoteBrowserList` | ✅ (empty) | |
| `statusPageList` | ✅ (empty) | |
| `monitorTypeList` | ✅ | Only `http`, `port`, `dns`. |
| `certInfo` | ❌ | OpenStatus exposes no equivalent certificate data. |
| `domainInfo` | ❌ | Same. |
| `refresh` | ❌ | Would force clients to reload; never needed. |
| `importantHeartbeatList` | ❌ | Kuma 2.5.5 pushes it and the official frontend ignores it. |

## Client → server events

| Event | Status | Notes |
| --- | --- | --- |
| `login` | ✅ | Object argument, as Kuma expects. |
| `loginByToken` | ✅ | Bare string argument. |
| `logout` | ✅ | |
| `getMonitor` | ✅ | Accepts numeric **and** string ids. |
| `getMonitorList` | ✅ | |
| `getMonitorBeats` | ✅ | Period capped at 720 h. |
| `getMonitorChartData` | ✅ | Kuma bucket shapes (`avgPing`/`minPing`/`maxPing`). |
| `pauseMonitor` | ✅ | → `update*HTTPMonitor.active = false`. |
| `resumeMonitor` | ✅ | → `update*HTTPMonitor.active = true`. |
| `getSettings` | ✅ | Minimal honest settings; feature toggles report `false`. |
| `getTags` | ✅ | Always empty — see "Tags". |
| `clearEvents` | ✅ | Acks after resolving the monitor. Does **not** delete history: history comes from OpenStatus, so there is nothing local to clear. |
| `login`/`loginByToken` rate limiting | ✅ | Per-socket token bucket. |

### Explicitly unsupported

Every one of these returns `{ok: false, msg: "Not supported by OpenStatus compatibility bridge"}`
and is logged as `kuma.event.unsupported`. None of them silently succeeds.

Monitor authoring (`add`, `editMonitor`, `deleteMonitor`, `checkDomain`),
notifications (`addNotification`, `deleteNotification`, `testNotification`,
`getWebpushVapidPublicKey`), 2FA (`prepare2FA`, `save2FA`, `disable2FA`,
`verifyToken`, `twoFAStatus`), API keys, maintenance CRUD, settings writes,
`clearStatistics` / `clearHeartbeats`, backups, Docker hosts, proxies, remote
browsers, status pages and incidents, database management, `needSetup` / `setup`.

An unrecognised event from a newer client is logged as `kuma.event.unhandled`
rather than being guessed at.

---

## Feature matrix by monitor kind

| | HTTP | TCP | DNS |
| --- | --- | --- | --- |
| Monitor list / detail | ✅ | ✅ `type: "port"` | ✅ `type: "dns"` |
| Current status | ✅ | ✅ | ✅ |
| Current latency | ✅ per-region median | ⚠️ `p50` from summary | ⚠️ `p50` from summary |
| Real response-log history | ✅ | ❌ | ❌ |
| Bridge-observed history | ✅ | ✅ | ✅ |
| Charts / uptime | ✅ | ✅ | ✅ |
| Pause / resume | ✅ | ✅ | ✅ |
| Regions shown in message | ✅ | ✅ | ✅ |

**Why TCP/DNS latency is a percentile, not a measurement.** OpenStatus' only
per-check log API is `listMonitorHTTPResponseLogs`, and the service explicitly
rejects any non-HTTP job type (`packages/services/src/monitor/list-response-logs.ts:51-55`).
The per-region latency data exists in OpenStatus' Tinybird schemas but is not
exposed over RPC. For those monitors the bridge falls back to the `p50` from
`getMonitorSummary` and the heartbeat `msg` still names the real reason. No
percentile is ever labelled an average.

**Why TCP/DNS history exists at all.** The bridge records every state it reads
out of OpenStatus into its own SQLite log. That is not a second monitoring
system — no probe is ever run by the bridge — but without it those monitors
would have no history, no uptime and no chart. Consequence, stated plainly:
*history depth for TCP/DNS is bounded by how long the bridge has been running*,
not by OpenStatus retention. HTTP monitors use real response logs instead
(`HISTORY_SOURCE=auto`).

---

## Multi-region aggregation

One OpenStatus monitor with four probe locations appears as **one** Kuma monitor.
The bridge never fabricates one Kuma monitor per region.

Default: `STATUS_AGGREGATION_STRATEGY=openstatus`. OpenStatus computes the
monitor-wide status server-side with a 50 % quorum — `affected * 2 >= total`,
over the monitor's *configured* regions (`apps/workflows/src/checker/quorum.ts:16`).
The bridge reads `monitor.status` and trusts it.

| Strategy | Behaviour |
| --- | --- |
| `openstatus` | Trust OpenStatus' quorum-gated `monitor.status`. Falls back to a local quorum only when OpenStatus has no verdict. **Default.** |
| `majority` | Recompute the 50 % quorum locally from `getMonitorStatus`. |
| `worst` | Any failing region ⇒ down. |
| `all` | Every region must be up. |
| `any` | At least one region must be up. |

Recomputing locally is *not* equivalent to `openstatus`: `getMonitorStatus` omits
private-location regions entirely, so a local quorum uses a different denominator
than OpenStatus did. That is why `openstatus` is the default.

Representative latency: `LATENCY_AGGREGATION=median` over the successful regions of
the current check. `mean`, `min`, `max` and `p50` are also available.

---

## Degraded → PENDING

`DEGRADED_STATUS_MAPPING` decides which Kuma status an OpenStatus `degraded` monitor
becomes:

| Value | Kuma status | Renders as | Uptime effect |
| --- | --- | --- | --- |
| `pending` *(default)* | `2` PENDING | yellow warning | counted as **downtime** |
| `up` | `1` UP | green | counted as uptime |
| `down` | `0` DOWN | red outage | counted as downtime |

**This is a compromise, not an equivalence.** OpenStatus `DEGRADED` means "the
request succeeded but exceeded `degraded_after`". Kuma `PENDING` means "waiting for a
retry". The default is chosen because PENDING communicates "not healthy" in every
Kuma client without asserting an outage.

Two consequences, both documented rather than hidden:

1. Every synthesized heartbeat `msg` states the OpenStatus reason explicitly
   (`Degraded — latency above configured threshold (threshold 500 ms) · 3/4 locations
   healthy`), never "Pending".
2. Kuma's `isImportantBeat` treats transitions into PENDING as **not** important, so
   a degradation does not raise a toast in clients that follow that rule. This is
   Kuma's own behaviour for PENDING; we reproduce it rather than fake `important`.

Uptime semantics reproduce `UptimeCalculator.flatStatus()` exactly: `MAINTENANCE`
counts as UP, `PENDING` counts as DOWN. With the default mapping, degraded time is
therefore charged as downtime — a real divergence from OpenStatus, which counts
`degraded` separately from `failed`.

---

## Retention and history

| | Value |
| --- | --- |
| OpenStatus response logs | 14 days (`http_response__list_14d`), and a **paid-plan** workspace limit (`response-logs`) |
| Bridge observation log | `ceil(MAX_HISTORY_HOURS / 24)` days, default 30 |
| Client-visible cap | `MAX_HISTORY_HOURS`, default 720 |
| `1y` uptime | Reported from available history, which is ≤ 30 days by default |

**Nothing is fabricated.** If a client asks for 720 h and OpenStatus retains 336 h,
the response contains the 336 h that exist. Gaps stay gaps.

---

## Maintenance

`maintenanceList` is always empty and no heartbeat is ever given Kuma status `3`.

OpenStatus' maintenance windows are scoped to **status pages** (`page_id` +
`page_component_ids`); there is no per-monitor maintenance concept in its API.
Inventing per-monitor maintenance would mean guessing which monitors a status-page
component maps to, so the bridge does not.

## Tags

`tags` is always `[]` and `getTags` always returns an empty list. Monitor tags
exist in OpenStatus' database layer but appear in no `monitor/v1/*.proto` message.
There is nothing truthful to map.

---

## Native apps

Not yet verified against real devices. Everything above is verified against the
Uptime Kuma 2.5.5 source and a real Socket.IO client.

### KumaAlert

| | |
| --- | --- |
| Add server URL / login | ⬜ unverified |
| Remembered login (`loginByToken`) | ✅ implemented |
| Monitor list | ✅ implemented |
| Monitor detail | ✅ implemented |
| Heartbeat history | ✅ implemented |
| Uptime / charts | ✅ implemented |
| Live status updates | ✅ implemented |
| Background → foreground | ✅ (replays `heartbeatList` on every auth) |
| Native push | ❌ not implemented (Milestone 6) |

### KumaWatch

Same as above.

### Uptime Kuma Manager

Same as above.

---

## Manual test matrix

Run through this against a real device before calling the bridge "working". Record
every event the app sends that is not in the table above — those are the next
compatibility gaps.

```text
[ ] add bridge URL to the app
[ ] authentication succeeds with bridge credentials
[ ] remembered login survives an app restart
[ ] monitor list appears and shows real OpenStatus monitors
[ ] monitor names, types and targets are correct
[ ] paused monitors look paused
[ ] current status matches OpenStatus
[ ] response time renders
[ ] monitor detail screen opens
[ ] heartbeat history renders at the right density
[ ] uptime percentage renders
[ ] response-time chart renders
[ ] a status change updates without pulling to refresh
[ ] background → foreground refreshes correctly
[ ] bridge restart reconnects without re-adding the server
[ ] logs contain no secrets
[ ] unsupported operations surface an error instead of lying
```

### Contributing protocol captures

Only against servers you own.

```bash
# Disposable local Uptime Kuma for comparison
docker run -d --name kuma -p 3001:3001 louislam/uptime-kuma:2.5.5

# Record what a real client does, with secrets and hostnames stripped
pnpm protocol:capture -- --url http://localhost:3001 --user admin --password admin \
  --out tests/fixtures/kuma/2.5.5/session.json
```

`scripts/protocol-probe.ts` is a plain Socket.IO **client**: it connects, authenticates
and records events. It does not intercept, patch or proxy traffic, and it does not
attempt to defeat certificate pinning or extract secrets from third-party services.
Passwords, tokens, notification configs, API keys and (by default) hostnames are
redacted before anything is written to disk. Commit only sanitized output, and never
your production credentials.

Diffing a capture against the bridge is the intended workflow:

```bash
pnpm protocol:capture -- --url https://kuma.example.com --user cedric \
  --out /tmp/bridge-session.json
```