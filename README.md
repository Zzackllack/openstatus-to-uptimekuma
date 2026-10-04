# openstatus-kuma-bridge

Makes a self-hosted **[OpenStatus](https://github.com/openstatusHQ/openstatus)**
instance answer as though it were an **Uptime Kuma** server, so native Uptime Kuma iOS
clients (KumaAlert, KumaWatch, Uptime Kuma Manager, …) work while OpenStatus stays the
actual monitoring backend.

No Uptime Kuma server is involved, and the bridge runs no checks of its own — it
translates OpenStatus data into the wire format those clients expect.

> Unofficial compatibility layer against Uptime Kuma's **internal** client protocol,
> pinned to **Uptime Kuma 2.5.5**. Neither project endorses or supports this one. See
> [docs/compatibility.md](./docs/compatibility.md).

## Quick start

```bash
cp .env.example .env
# fill in PUBLIC_BASE_URL, OPENSTATUS_API_KEY, and the two secrets below
docker compose run --rm bridge node dist/cli.js password hash   # -> BRIDGE_PASSWORD_HASH
docker compose run --rm bridge node dist/cli.js secret          # -> JWT_SECRET
docker compose up -d --build
```

Then point your iOS client at the bridge:

```text
Server:   https://kuma.example.com
Username: <BRIDGE_USERNAME>
Password: <the password you just hashed>
```

Prefer running it on bare Node.js? `pnpm install && pnpm build && pnpm start` — see
[docs/deployment.md](./docs/deployment.md).

Two things worth knowing before you start:

- **`PUBLIC_BASE_URL` must be the externally reachable https origin.** Clients build
  every link from it, so `localhost` produces broken links in the app.
- **Keep the `./data` volume.** It holds the monitor id map. Without it every monitor
  gets a new id after a restart, which looks like monitors being swapped for others.

## What works

```text
✅ connect, authenticate, remembered login
✅ monitor list (HTTP / TCP / DNS) with stable synthetic ids
✅ current UP / DOWN / DEGRADED / PAUSED state
✅ response time (median across regions) and true mean latency
✅ uptime for 24 h / 30 d / 1 y
✅ heartbeat history, response-time and uptime charts
✅ live updates via polling and OpenStatus webhooks
✅ pause / resume (mutates OpenStatus)
✅ reconnect after backgrounding, restarting or switching networks

❌ monitor creation/editing/deletion, notifications, maintenance windows, tags,
   status pages, certificate expiry, Docker hosts/proxies/backups, 2FA
```

Unsupported operations return
`{ok: false, msg: "Not supported by OpenStatus compatibility bridge"}` and are logged.
The bridge never pretends a mutation succeeded.

## Documentation

| Page | What it answers |
| --- | --- |
| [docs/deployment.md](./docs/deployment.md) | Compose, bare Node, reverse proxy, adding the server to an iPhone |
| [docs/configuration.md](./docs/configuration.md) | Every env var, the OpenStatus key, bridge credentials, webhooks |
| [docs/architecture.md](./docs/architecture.md) | Layering, stable ids, polling vs. webhook |
| [docs/translation.md](./docs/translation.md) | How multi-region results become one Kuma status, degraded mapping, history |
| [docs/operations.md](./docs/operations.md) | `/healthz` vs `/readyz`, logs, troubleshooting |
| [docs/development.md](./docs/development.md) | Tests, the manual device matrix, protocol captures |
| [docs/compatibility.md](./docs/compatibility.md) | Exactly which protocol events are implemented, per Kuma release |
| [docs/protocol-research.md](./docs/protocol-research.md) | Where each behaviour was derived from, with file/line refs |

## Roadmap

```text
✅ Milestone 0  protocol research, pinned to Kuma 2.5.5
✅ Milestone 1  connection + authentication
✅ Milestone 2  monitor list with persistent id translation
✅ Milestone 3  current status, regional aggregation, latency, uptime
✅ Milestone 4  history, logical-check grouping, charts
✅ Milestone 5  polling reconciliation + webhook ingestion
✅ Milestone 7  pause / resume
⬜ Milestone 6  native push for one target client
```

## License

MIT — see [LICENSE](./LICENSE).

Uptime Kuma is licensed under MIT and OpenStatus under Apache-2.0; this project studies
both and reproduces protocol *behaviour*, not their code. Protocol shapes derived from
reading their source are facts about an interface, and are attributed in
[docs/protocol-research.md](./docs/protocol-research.md) with file and line references.