# Configuration

Every variable is documented in [`.env.example`](../.env.example), including the ones
that only matter in edge cases. Invalid configuration fails at startup, and secrets are
never printed in the error.

Frequently changed:

| Variable | Default | Notes |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | — | Required, https. Sent to clients as `primaryBaseURL`. |
| `OPENSTATUS_API_URL` | managed API | Point at your self-hosted `/rpc`. |
| `OPENSTATUS_API_KEY` | — | Server-side only; never sent to a client, logged, or returned. |
| `MAX_OPENSTATUS_CONCURRENCY` | `5` | OpenStatus allows 600 req/min per key. |
| `HISTORY_SOURCE` | `auto` | `openstatus` for HTTP logs, bridge observations for TCP/DNS. |
| `MAX_HISTORY_HOURS` | `720` | Hard cap on any client request. |
| `ALLOWED_ORIGINS` | *(empty)* | Restrict browser clients. Native clients send no `Origin`. |

Status and latency semantics (`STATUS_AGGREGATION_STRATEGY`, `LATENCY_AGGREGATION`,
`DEGRADED_STATUS_MAPPING`, `HISTORY_SOURCE`) are explained in
[translation.md](./translation.md).

## The OpenStatus API key

Create it in the OpenStatus dashboard. A `read` scope key is enough unless you use
pause/resume, which needs `write`. Scope is immutable — revoke and reissue to change
it.

```bash
# confirm the key works
curl -s -H "x-openstatus-key: $OPENSTATUS_API_KEY" \
  https://openstatus.example.com/v1/whoami | jq '.actor.scopes'
```

## Bridge credentials

`BRIDGE_USERNAME` / `BRIDGE_PASSWORD_HASH` are the credentials your iOS client logs in
with. They are **bridge** credentials and are never forwarded to OpenStatus: the bridge
authenticates you locally and talks to OpenStatus with its own API key, so a leaked
phone credential cannot escalate into an OpenStatus session.

```bash
pnpm bridge password hash    # -> BRIDGE_PASSWORD_HASH
pnpm bridge secret           # -> JWT_SECRET (48 random bytes)
```

With the container (no local checkout needed — it runs the CLI from the image):

```bash
docker compose run --rm bridge node dist/cli.js password hash
docker compose run --rm bridge node dist/cli.js secret
```

Remembered login uses a JWT signed with `JWT_SECRET`, which also carries a hash of the
stored password — changing `BRIDGE_PASSWORD_HASH` invalidates every remembered login.

## Webhooks

`OPENSTATUS_WEBHOOK_SECRET` + `OPENSTATUS_WEBHOOK_SECRET_HEADER` authenticate
`POST /webhooks/openstatus`, which is how state changes reach clients faster than the
poller. OpenStatus webhooks carry **no HMAC or signature**, so that shared-secret header
is the entire authentication mechanism; the endpoint is disabled when no secret is set.
Setup instructions: [architecture.md](./architecture.md#two-update-paths-one-derived-state).