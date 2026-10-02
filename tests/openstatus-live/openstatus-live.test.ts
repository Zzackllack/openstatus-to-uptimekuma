import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startBridge, type Bridge } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { hashPassword } from "../../src/kuma/auth.js";
import { createLogger } from "../../src/observability/logger.js";
import { OpenStatusSdkBackend } from "../../src/openstatus/sdk-backend.js";
import { toKumaMonitor } from "../../src/kuma/mapper/monitor.js";
import { createStatusMapper } from "../../src/kuma/mapper/status.js";
import { KUMA_COMPATIBILITY_VERSION } from "../../src/kuma/protocol/version.js";

/**
 * Read-only smoke tests against a REAL OpenStatus backend.
 *
 *   OPENSTATUS_INTEGRATION_TEST=1 \
 *   OPENSTATUS_API_URL=https://openstatus.example.com/rpc \
 *   OPENSTATUS_API_KEY=... \
 *   pnpm test:integration:openstatus
 *
 * Nothing here creates, updates or deletes anything upstream. Point it at a
 * workspace you are willing to have read; there is no guard against pointing it
 * at production, only a deliberate opt-in.
 */
const enabled = process.env["OPENSTATUS_INTEGRATION_TEST"] === "1";
const describeLive = enabled ? describe : describe.skip;

describeLive("live OpenStatus", () => {
  let dir: string;
  let bridge: Bridge;
  let backend: OpenStatusSdkBackend;

  beforeAll(async () => {
    const passwordHash = await hashPassword("live-integration-password");
    dir = mkdtempSync(join(tmpdir(), "kuma-bridge-live-"));

    const env = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      HOST: "127.0.0.1",
      PORT: "3250",
      PUBLIC_BASE_URL: "https://kuma.test",
      OPENSTATUS_API_URL: process.env["OPENSTATUS_API_URL"] ?? "https://api.openstatus.dev/rpc",
      OPENSTATUS_API_KEY: process.env["OPENSTATUS_API_KEY"] ?? "",
      BRIDGE_USERNAME: "cedric",
      BRIDGE_PASSWORD_HASH: passwordHash,
      JWT_SECRET: "l".repeat(48),
      DATABASE_PATH: join(dir, "bridge.sqlite"),
    });

    bridge = await startBridge(env, { logger: createLogger({ LOG_LEVEL: "warn", NODE_ENV: "test" }) });
    backend = new OpenStatusSdkBackend(env, createLogger({ LOG_LEVEL: "warn", NODE_ENV: "test" }));
  }, 60_000);

  afterAll(async () => {
    await bridge?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the backend as reachable", async () => {
    expect(await backend.checkHealth()).toBe(true);
  });

  it("lists monitors and maps every supported kind into a valid Kuma monitor", async () => {
    const monitors = await backend.listMonitors();
    expect(Array.isArray(monitors)).toBe(true);

    for (const monitor of monitors) {
      expect(["http", "tcp", "dns"]).toContain(monitor.kind);
      expect(monitor.openStatusId).toBeTruthy();
      expect(monitor.intervalSeconds).toBeGreaterThanOrEqual(30);

      const kuma = toKumaMonitor(monitor);
      // The fields the official frontend dereferences without a guard.
      expect(typeof kuma.name).toBe("string");
      expect(Array.isArray(kuma.tags)).toBe(true);
      expect(Array.isArray(kuma.childrenIDs)).toBe(true);
      expect(kuma.parent).toBeNull();
      expect(["http", "port", "dns"]).toContain(kuma.type);
    }
  }, 60_000);

  it("paginates past the first page of 100 monitors when there are more", async () => {
    const monitors = await backend.listMonitors();
    // The adapter loops until totalSize; a workspace with >100 monitors exercises
    // that path, and a small one must still return everything exactly once.
    expect(new Set(monitors.map((m) => m.openStatusId)).size).toBe(monitors.length);
  }, 60_000);

  it("reads per-region status and a summary for each monitor", async () => {
    const monitors = await backend.listMonitors();
    const sample = monitors.slice(0, 3);
    if (sample.length === 0) return;

    for (const monitor of sample) {
      const regions = await backend.getMonitorStatus(monitor.openStatusId);
      expect(Array.isArray(regions)).toBe(true);
      for (const region of regions) {
        expect(typeof region.region).toBe("string");
        expect(["up", "down", "degraded", "unknown"]).toContain(region.status);
      }

      const summary = await backend.getMonitorSummary(monitor.openStatusId, 24);
      if (summary) {
        expect(summary.totalSuccessful).toBeGreaterThanOrEqual(0);
        expect(summary.p50 === null || summary.p50 >= 0).toBe(true);
      }
    }
  }, 60_000);

  it("returns response logs for HTTP monitors and an empty list for others", async () => {
    const monitors = await backend.listMonitors();
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 3_600_000);

    const http = monitors.find((m) => m.kind === "http");
    if (http) {
      const logs = await backend.getMonitorHistory(http.openStatusId, from, to, 25);
      for (const log of logs) {
        expect(Number.isFinite(log.cronTimestamp)).toBe(true);
        expect(typeof log.region).toBe("string");
        expect(["up", "down", "degraded", "unknown"]).toContain(log.requestStatus);
      }
    }

    const nonHttp = monitors.find((m) => m.kind !== "http");
    if (nonHttp) {
      // Must degrade to "no history", not throw and abort the poll cycle.
      const logs = await backend.getMonitorHistory(nonHttp.openStatusId, from, to, 25);
      expect(Array.isArray(logs)).toBe(true);
    }
  }, 60_000);

  it("resolves a monitor that is known to exist back through getMonitor", async () => {
    const monitors = await backend.listMonitors();
    const monitor = monitors[0];
    if (!monitor) return;
    const fetched = await backend.getMonitor(monitor.openStatusId);
    expect(fetched?.openStatusId).toBe(monitor.openStatusId);
    expect(await backend.getMonitor("definitely-not-a-real-id")).toBeNull();
  }, 60_000);

  it("maps OpenStatus statuses onto Kuma codes end to end", () => {
    const mapper = createStatusMapper("pending");
    expect(mapper.toKuma("up")).toBe(1);
    expect(mapper.toKuma("down")).toBe(0);
    expect(mapper.toKuma("degraded")).toBe(2);
    expect(KUMA_COMPATIBILITY_VERSION).toBe("2.5.5");
  });
});