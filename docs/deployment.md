# Deployment

## Docker Compose (recommended)

```bash
cp .env.example .env      # then fill in PUBLIC_BASE_URL, the OpenStatus key, and the secrets
docker compose up -d --build
docker compose logs -f
```

Configuration lives in `.env` (loaded via `env_file`), not in the compose file, so
there is exactly one place to look.

The container runs as a non-user `node`, has a read-only root filesystem, and keeps
only `/app/data` writable (that is where the id map lives). Graceful shutdown on
`SIGTERM`; a healthcheck polls `/healthz`.

Port 3000 is published on **loopback only** — put a reverse proxy in front of it.

### The id map is the one thing you must persist

`./data:/app/data` holds `bridge.sqlite`, the OpenStatus↔Kuma monitor id map. Losing it
is survivable, but every phone will see ids change, which looks like monitors being
swapped for other monitors. Back it up:

```bash
docker cp bridge:/app/data/bridge.sqlite ./bridge-backup.sqlite
```

A nightly cron `docker cp` is enough; only one process ever writes the file.

## Bare Node.js

Requires **Node.js 22.4+** and pnpm.

```bash
pnpm install
cp .env.example .env
# fill in .env, see configuration.md
pnpm build
pnpm start
```

## Reverse proxy

One upstream serves `/healthz`, `/readyz`, `/bridge/info`, `/metrics`,
`/webhooks/openstatus` and the Socket.IO transport (default path `/socket.io/`).

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
`info.primaryBaseURL` and build links from it, so `localhost` will produce broken links
in the app.

## Adding the server to an iPhone client

```text
Server:   https://kuma.example.com
Username: <BRIDGE_USERNAME>
Password: <what you typed into `pnpm bridge password hash`>
```