# Operations

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

## Endpoints

```bash
curl -s https://kuma.example.com/healthz    | jq   # liveness
curl -s https://kuma.example.com/readyz     | jq   # readiness
curl -s https://kuma.example.com/bridge/info | jq   # bridge diagnostics
curl -s https://kuma.example.com/metrics
```

`/bridge/info` is the bridge's own diagnostics and is deliberately **separate** from the
Kuma protocol, so no custom keys ever have to be smuggled into a `monitorList` payload
where a strict client might reject them.

## Logs

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
Expected: OpenStatus exposes response logs for HTTP monitors only. TCP/DNS history
starts accumulating once the bridge has been running. See
[translation.md](./translation.md#history-sources).

**Everything shows PENDING**
Check whether the monitors are actually degraded in OpenStatus, and what
`DEGRADED_STATUS_MAPPING` is set to.

**Push notifications do not arrive**
Not implemented yet — see the roadmap in the [README](../README.md).

**Ids changed / monitors look swapped**
`data/bridge.sqlite` was lost or replaced. Restore the volume.