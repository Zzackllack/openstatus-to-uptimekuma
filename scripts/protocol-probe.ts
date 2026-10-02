/**
 * Protocol probe.
 *
 * Connects to any Uptime-Kuma-protocol server as an ordinary Socket.IO client
 * and records the event flow, sanitized.
 *
 * It is deliberately a *client*, not a proxy: there is no interception, no
 * patching and no traffic capture. Point it at an instance you own.
 *
 *   # Against our own bridge
 *   pnpm protocol:capture -- --url http://localhost:3000 --user cedric
 *
 *   # Against a disposable local Uptime Kuma
 *   docker run -d -p 3001:3001 louislam/uptime-kuma:2.5.5
 *   pnpm protocol:capture -- --url http://localhost:3001 --user admin --password admin
 *
 * Sanitization always removes: passwords, tokens, Authorization/cookie headers,
 * notification configs and API keys. Hostnames/URLs are redacted unless
 * --keep-hosts is passed, so a captured fixture can be committed safely.
 */
import { io, type Socket } from "socket.io-client";

interface Options {
  url: string;
  user?: string;
  password?: string;
  token?: string;
  out?: string;
  keepHosts: boolean;
  durationSeconds: number;
}

const REDACTED = "[redacted]";
const SECRET_KEYS = new Set([
  "password",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "authorization",
  "cookie",
  "basic_auth_pass",
  "basic_auth_user",
  "oauth_client_secret",
  "oauth_token_url",
  "headers",
  "body",
  "config",
]);

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  return {
    url: get("url") ?? "http://localhost:3000",
    user: get("user"),
    password: get("password"),
    token: get("token"),
    out: get("out"),
    keepHosts: argv.includes("--keep-hosts"),
    durationSeconds: Number.parseInt(get("seconds") ?? "30", 10),
  };
}

function sanitize(value: unknown, options: Options, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return options.keepHosts ? value : redactHosts(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, options, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : sanitize(inner, options, depth + 1);
  }
  return result;
}

function redactHosts(text: string): string {
  return text.replace(/https?:\/\/[^/\s"']+/gi, (match) => `${match.split("://")[0]}://[host]`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const captured: { at: string; direction: "in" | "out"; event: string; args: unknown[] }[] = [];

  const socket: Socket = io(options.url, {
    transports: ["websocket", "polling"],
    reconnection: false,
  });

  const record = (direction: "in" | "out", event: string, args: unknown[]): void => {
    captured.push({
      at: new Date().toISOString(),
      direction,
      event,
      args: args.map((arg) => sanitize(arg, options)),
    });
    process.stdout.write(`${direction === "in" ? "→" : "←"} ${event}\n`);
  };

  socket.onAny((event, ...args) => record("in", event, args));

  const emit = (event: string, ...args: unknown[]): void => {
    record("out", event, args);
    socket.emit(event, ...args, (response: unknown) => record("in", `${event}#ack`, [response]));
  };

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connection timed out")), 10_000);
  });

  if (options.token) {
    emit("loginByToken", options.token);
  } else if (options.user) {
    emit("login", { username: options.user, password: options.password ?? "" });
  } else {
    // No credentials: just record the unauthenticated handshake, which is still
    // useful for diffing against expectations.
    process.stdout.write("no credentials supplied; recording handshake only\n");
  }

  await new Promise((resolve) => setTimeout(resolve, options.durationSeconds * 1000));
  socket.disconnect();

  const output = {
    capturedAt: new Date().toISOString(),
    url: options.keepHosts ? options.url : "[host]",
    sanitized: !options.keepHosts,
    events: captured,
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.out, json, "utf8");
    process.stdout.write(`\nwrote ${captured.length} events to ${options.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});