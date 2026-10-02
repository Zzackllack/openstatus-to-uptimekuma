import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectClient, startTestBridge, type Harness, type TestClient } from "../helpers/harness.js";
import { FakeBackend, makeMonitor, region } from "../helpers/fake-openstatus.js";

const MINUTE = 60_000;

interface Beat {
  monitorID: number;
  monitor_id: number;
  status: number;
  time: string;
  msg: string;
  ping: number | null;
  important: boolean;
  duration: number;
}

function beatsOf(client: TestClient): Beat[] {
  return (client.all("heartbeatList").at(-1)?.[1] ?? []) as Beat[];
}

async function waitFor(condition: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not met in time");
}

describe("current status, stats and live updates", () => {
  let harness: Harness;
  let client: TestClient;
  let backend: FakeBackend;

  beforeEach(async () => {
    backend = new FakeBackend();
    backend.setMonitor(
      makeMonitor({
        openStatusId: "mon_a",
        name: "Mini-PC",
        kind: "tcp",
        target: { hostname: "nas.example.com", port: 443 },
        intervalSeconds: 30,
        status: "up",
      }),
    );
    backend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    harness = await startTestBridge({}, backend);
  });

  afterEach(async () => {
    client?.disconnect();
    await harness.close();
  });

  it("emits avgPing and uptime with Kuma's numeric period keys", async () => {
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("uptime");

    const periods = client.all("uptime").map((args) => args[1]);
    // 24 and 720 are numbers, "1y" is a string — exactly as Uptime Kuma 2.5.5.
    expect(periods).toEqual([24, 720, "1y"]);

    for (const args of client.all("uptime")) {
      expect(typeof args[2]).toBe("number");
      expect(args[2] as number).toBeGreaterThanOrEqual(0);
      expect(args[2] as number).toBeLessThanOrEqual(1);
    }

    const avgPings = client.all("avgPing");
    expect(avgPings).toHaveLength(1);
    expect(avgPings[0]?.[0]).toBe(1);
  });

  it("pushes a heartbeatList with the fields Kuma clients read", async () => {
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("heartbeatList");

    const beats = beatsOf(client);
    expect(beats.length).toBeGreaterThan(0);

    const latest = beats.at(-1)!;
    expect(latest.monitorID).toBe(1);
    expect(latest.monitor_id).toBe(1);
    expect(latest.status).toBe(1); // UP
    expect(new Date(latest.time).toISOString()).toBe(latest.time);
    expect(latest.duration).toBe(30);
    expect(typeof latest.important).toBe("boolean");
    expect(latest.msg).toContain("locations healthy");
  });

  it("pushes a live heartbeat when the monitor goes down", async () => {
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("heartbeatList");

    backend.setMonitor({ ...backend.monitors.get("mon_a")!, status: "down" });
    backend.setRegions("mon_a", [region("fly_ams", "down"), region("fly_iad", "down")]);

    await waitFor(() => client.all("heartbeat").length > 0);
    const [beat] = client.all("heartbeat")[0] as [Beat];

    expect(beat.status).toBe(0); // DOWN
    expect(beat.important).toBe(true);
    expect(beat.ping).toBeNull();
    expect(beat.msg).toMatch(/^Connection failed/);
  });

  it("does not raise a heartbeat for a latency-only change", async () => {
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("heartbeatList");
    const before = client.all("heartbeat").length;

    // Same status, wildly different latency.
    backend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(client.all("heartbeat").length).toBe(before);
  });

  it("keeps last-known state and does NOT mark monitors down when OpenStatus is unreachable", async () => {
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("heartbeatList");
    expect(beatsOf(client).at(-1)?.status).toBe(1);

    backend.failure = new Error("ECONNREFUSED");
    backend.healthy = false;

    // Force poll cycles to run against the dead backend.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Nothing may be reported as DOWN.
    const downBeats = client
      .all("heartbeat")
      .map((args) => args[0] as Beat)
      .filter((beat) => beat.status === 0);
    expect(downBeats).toEqual([]);

    // Liveness must stay 200: the bridge is still serving last-known state, and
    // an orchestrator killing it here would make things strictly worse.
    const health = await fetch(`${harness.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "degraded", openstatus: "unavailable" });

    // Readiness is where the backend outage is allowed to surface.
    const ready = await fetch(`${harness.baseUrl}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, openstatus: "unavailable" });
  });

  it("renders a degraded OpenStatus monitor as PENDING by default, and says so in the message", async () => {
    const degradedBackend = new FakeBackend();
    degradedBackend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 30, status: "degraded" }));
    degradedBackend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    const degradedHarness = await startTestBridge({}, degradedBackend);

    const degradedClient = await connectClient(degradedHarness);
    await degradedClient.login();
    await degradedClient.waitFor("heartbeatList");

    const latest = beatsOf(degradedClient).at(-1)!;
    expect(latest.status).toBe(2); // PENDING
    // The compromise is documented, but the message must not pretend PENDING
    // means what OpenStatus means by degraded.
    expect(latest.msg).toMatch(/^Degraded/);
    expect(latest.msg).not.toMatch(/Pending/);

    degradedClient.disconnect();
    await degradedHarness.close();
  });

  it("honours DEGRADED_STATUS_MAPPING=down", async () => {
    const degradedBackend = new FakeBackend();
    degradedBackend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 30, status: "degraded" }));
    degradedBackend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    const degradedHarness = await startTestBridge({ DEGRADED_STATUS_MAPPING: "down" }, degradedBackend);

    const degradedClient = await connectClient(degradedHarness);
    await degradedClient.login();
    await degradedClient.waitFor("heartbeatList");

    expect(beatsOf(degradedClient).at(-1)?.status).toBe(0);
    degradedClient.disconnect();
    await degradedHarness.close();
  });

  it("reports a paused monitor as unknown/PENDING rather than up or down", async () => {
    const pausedBackend = new FakeBackend();
    pausedBackend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 30, active: false }));
    pausedBackend.setRegions("mon_a", [region("fly_ams", "up")]);
    const pausedHarness = await startTestBridge({}, pausedBackend);

    const pausedClient = await connectClient(pausedHarness);
    await pausedClient.login();
    await pausedClient.waitFor("heartbeatList");

    expect(beatsOf(pausedClient).at(-1)?.status).toBe(2);
    pausedClient.disconnect();
    await pausedHarness.close();
  });
});

describe("history and charts", () => {
  let harness: Harness;
  let client: TestClient;
  let backend: FakeBackend;

  const now = Date.now();
  const log = (offsetMinutes: number, latencies: number[], status: "up" | "down" = "up") => {
    const cronTimestamp = now - offsetMinutes * MINUTE;
    return ["fly_ams", "fly_iad", "fly_gru"].map((regionName, index) => ({
      id: `${offsetMinutes}-${regionName}`,
      cronTimestamp,
      timestamp: cronTimestamp + 500,
      latencyMs: latencies[index] ?? latencies[0] ?? 0,
      statusCode: status === "up" ? 200 : 500,
      region: regionName,
      requestStatus: status,
    }));
  };

  beforeEach(async () => {
    backend = new FakeBackend();
    backend.setMonitor(
      makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", kind: "http", intervalSeconds: 60, status: "up" }),
    );
    backend.setRegions("mon_a", [region("fly_ams", "up")]);
    // 10 minutes of healthy checks, then 5 minutes of outage, then recovery.
    const logs = [
      ...[10, 9, 8, 7, 6].flatMap((offset) => log(offset, [18, 24, 30])),
      ...[5, 4, 3].flatMap((offset) => log(offset, [0, 0, 0], "down")),
      ...[2, 1, 0].flatMap((offset) => log(offset, [20, 22, 26])),
    ];
    backend.setHistory("mon_a", logs);
    harness = await startTestBridge({ HISTORY_SOURCE: "openstatus" }, backend);
    client = await connectClient(harness);
    await client.login();
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("collapses per-region logs into one heartbeat per logical check", async () => {
    const response = await client.emit<{ ok: boolean; data: Beat[] }>("getMonitorBeats", 1, 24);

    expect(response.ok).toBe(true);
    expect(response.data).toHaveLength(11); // 11 logical checks, not 33 region rows

    const statuses = response.data.map((beat) => beat.status);
    // 5 up, 3 down, 3 up
    expect(statuses.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(statuses.slice(5, 8)).toEqual([0, 0, 0]);
    expect(statuses.slice(8)).toEqual([1, 1, 1]);
  });

  it("returns beats oldest-first, as Kuma stores and renders them", async () => {
    const response = await client.emit<{ ok: boolean; data: Beat[] }>("getMonitorBeats", 1, 24);
    const times = response.data.map((beat) => new Date(beat.time).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("aggregates latency per check using the median across regions", async () => {
    const response = await client.emit<{ ok: boolean; data: Beat[] }>("getMonitorBeats", 1, 24);
    expect(response.data[0]?.ping).toBe(24);
  });

  it("marks only genuine status transitions important", async () => {
    const response = await client.emit<{ ok: boolean; data: Beat[] }>("getMonitorBeats", 1, 24);
    const important = response.data.map((beat, index) => (beat.important ? index : -1)).filter((i) => i >= 0);
    // first beat, up->down, down->up
    expect(important).toEqual([0, 5, 8]);
  });

  it("builds chart buckets with Kuma's field names and unix-second timestamps", async () => {
    const response = await client.emit<{ ok: boolean; data: Record<string, number>[] }>("getMonitorChartData", 1, 24);

    expect(response.ok).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);

    for (const point of response.data) {
      expect(point).toHaveProperty("timestamp");
      expect(point).toHaveProperty("up");
      expect(point).toHaveProperty("down");
      expect(point).toHaveProperty("avgPing");
      expect(point).toHaveProperty("minPing");
      expect(point).toHaveProperty("maxPing");
      // Kuma sends seconds, not milliseconds.
      expect(point["timestamp"]).toBeLessThan(1e11);
    }
  });

  it("uses minute buckets for <=24h and hour buckets beyond", async () => {
    const minute = await client.emit<{ ok: boolean; data: { timestamp: number }[] }>("getMonitorChartData", 1, 6);
    const hour = await client.emit<{ ok: boolean; data: { timestamp: number }[] }>("getMonitorChartData", 1, 48);
    expect(minute.ok && hour.ok).toBe(true);
    if (!minute.ok || !hour.ok) return;

    // Kuma's rule: period <= 24 -> 1-minute buckets, <= 720 -> 1-hour buckets.
    // An 11-minute history therefore collapses into a single hourly point, which
    // is correct rather than a bug: one point per bucket, never one per check.
    expect(minute.data.every((p) => p.timestamp % 60 === 0)).toBe(true);
    expect(hour.data.every((p) => p.timestamp % 3600 === 0)).toBe(true);
    expect(minute.data.length).toBeGreaterThan(hour.data.length);
    expect(hour.data.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a missing period with Kuma's own message", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("getMonitorBeats", 1, null);
    expect(response).toEqual({ ok: false, msg: "Invalid period." });
  });

  it("never fabricates history beyond what the backend returns", async () => {
    const response = await client.emit<{ ok: boolean; data: Beat[] }>("getMonitorBeats", 1, 720);
    expect(response.data.length).toBe(11);
  });
});