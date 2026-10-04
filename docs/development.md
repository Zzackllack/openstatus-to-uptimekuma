# Development

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

## Testing against a real device

The real measure of compatibility is a real device. Run through this before calling the
bridge "working". Record every event an app sends that is not in
[compatibility.md](./compatibility.md) — those are the next compatibility gaps.

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

## Contributing protocol captures

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