/**
 * Post-build smoke test.
 *
 * Boots the *compiled* bridge against a fake OpenStatus and drives it with a real
 * Socket.IO client. Its job is to catch the class of problem that unit tests
 * cannot: ESM/CJS interop, native-module loading, and anything that only breaks
 * outside the test runner's module transform.
 *
 *   pnpm build && pnpm smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io } from "socket.io-client";

import { startBridge } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashPassword } from "../src/kuma/auth.js";
import { FakeBackend, makeMonitor, region } from "../tests/helpers/fake-openstatus.js";

const PASSWORD = "smoke-test-password";

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
    return;
  }
  process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kuma-bridge-smoke-"));
  const backend = new FakeBackend();
  backend.setMonitor(
    makeMonitor({
      openStatusId: "mon_a",
      name: "Mini-PC",
      kind: "tcp",
      target: { hostname: "nas.example.com", port: 443 },
      intervalSeconds: 60,
      status: "up",
    }),
  );
  backend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);

  const env = loadConfig({
    NODE_ENV: "production",
    LOG_LEVEL: "error",
    HOST: "127.0.0.1",
    PORT: "3199",
    PUBLIC_BASE_URL: "https://kuma.example.com",
    SERVER_TIMEZONE: "Europe/Berlin",
    OPENSTATUS_API_URL: "https://openstatus.example.com/rpc",
    OPENSTATUS_API_KEY: "smoke-secret-key",
    BRIDGE_USERNAME: "cedric",
    BRIDGE_PASSWORD_HASH: await hashPassword(PASSWORD),
    JWT_SECRET: "s".repeat(48),
    DATABASE_PATH: join(dir, "bridge.sqlite"),
    OPENSTATUS_WEBHOOK_SECRET: "smoke-webhook-secret-value",
  });

  process.stdout.write("openstatus-kuma-bridge smoke test\n\n");

  const bridge = await startBridge(env, { backend });
  check("bridge starts", true);

  const socket = io("http://127.0.0.1:3199", { transports: ["websocket"], reconnection: false });
  const seen: string[] = [];
  socket.onAny((name) => seen.push(name));

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 10_000);
  });
  check("socket connects", socket.connected);

  await new Promise((resolve) => setTimeout(resolve, 300));
  check("sends info then loginRequired", seen.includes("info") && seen.includes("loginRequired"));

  const emit = <T>(event: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 8000);
      socket.emit(event, ...args, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

  const badLogin = await emit<{ ok: boolean; msg: string }>("login", { username: "cedric", password: "wrong" });
  check("rejects a bad password", badLogin.ok === false && badLogin.msg === "authIncorrectCreds");

  const login = await emit<{ ok: boolean; token?: string }>("login", { username: "cedric", password: PASSWORD });
  check("accepts good credentials", login.ok === true && typeof login.token === "string");

  await new Promise((resolve) => setTimeout(resolve, 600));
  for (const required of ["monitorList", "heartbeatList", "avgPing", "uptime", "notificationList", "maintenanceList"]) {
    check(`pushes ${required}`, seen.includes(required));
  }

  const list = await emit<{ ok: boolean; monitor: { type: string; hostname: string; port: string } }>("getMonitor", 1);
  check(
    "translates a TCP monitor",
    list.ok && list.monitor.type === "port" && list.monitor.hostname === "nas.example.com" && list.monitor.port === "443",
  );

  const health = await fetch("http://127.0.0.1:3199/healthz");
  const healthBody = (await health.json()) as Record<string, unknown>;
  check("healthz reports the backend as connected", health.status === 200 && healthBody["openstatus"] === "connected");

  const infoResponse = await fetch("http://127.0.0.1:3199/bridge/info");
  const infoBody = await infoResponse.text();
  check("bridge/info never exposes the OpenStatus API key", !infoBody.includes("smoke-secret-key"));

  const unauthorized = await emit<{ ok: boolean }>("addNotification", {}, 0);
  check("never pretends an unsupported mutation succeeded", unauthorized.ok === false);

  socket.disconnect();
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });

  process.stdout.write(process.exitCode ? "\nsmoke test FAILED\n" : "\nsmoke test passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke test errored: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});