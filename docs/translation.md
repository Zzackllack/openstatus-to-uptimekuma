# Translation semantics

How OpenStatus data becomes something a Uptime Kuma client believes. The
corresponding protocol-level details live in [compatibility.md](./compatibility.md);
this page is the operational view: which knob changes which behaviour.

## Multi-region aggregation

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

## History sources

```env
HISTORY_SOURCE=auto        # default: OpenStatus logs for HTTP, bridge observations for TCP/DNS
MAX_HISTORY_HOURS=720      # hard cap on any client request, regardless of what it asks for
```

OpenStatus exposes response logs for **HTTP monitors only**, so TCP/DNS history starts
accumulating only once the bridge has been running. That is stated plainly rather than
papered over: history depth for TCP/DNS is bounded by bridge uptime, not by OpenStatus
retention.

## Unsupported operations

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
The bridge never pretends a mutation succeeded. The full per-event table is in
[compatibility.md](./compatibility.md#explicitly-unsupported).