import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectClient, startTestBridge, type Harness, type TestClient } from "../helpers/harness.js";
import { FakeBackend, makeMonitor, region } from "../helpers/fake-openstatus.js";

interface KumaMonitorShape {
  id: number;
  name: string;
  type: string;
  url: string;
  hostname: string;
  port: string;
  active: boolean;
  interval: number;
  tags: unknown[];
  childrenIDs: number[];
  parent: null;
}

/**
 * Monitor translation over the wire.
 *
 * The assertions are written against what the official Kuma frontend *reads*
 * (`MonitorList.vue`, `MonitorListItem.vue`, `Details.vue`) rather than against
 * the field names we happen to like.
 */
describe("monitor list and detail", () => {
  let harness: Harness;
  let client: TestClient;
  let backend: FakeBackend;

  beforeEach(async () => {
    backend = new FakeBackend();
    backend.setMonitor(
      makeMonitor({
        openStatusId: "mon_http",
        name: "Website",
        kind: "http",
        target: { url: "https://example.com" },
        intervalSeconds: 300,
        status: "up",
      }),
    );
    backend.setMonitor(
      makeMonitor({
        openStatusId: "mon_tcp",
        name: "Mini-PC",
        kind: "tcp",
        target: { hostname: "nas.example.com", port: 443 },
        intervalSeconds: 60,
        status: "up",
      }),
    );
    backend.setMonitor(
      makeMonitor({
        openStatusId: "mon_dns",
        name: "Resolver",
        kind: "dns",
        target: { dnsName: "example.com" },
        intervalSeconds: 1800,
        status: "down",
      }),
    );
    backend.setMonitor(
      makeMonitor({ openStatusId: "mon_paused", name: "Paused thing", active: false, intervalSeconds: 60 }),
    );
    backend.setRegions("mon_http", [region("ams", "up")]);
    backend.setRegions("mon_tcp", [region("ams", "up"), region("iad", "up")]);
    backend.setRegions("mon_dns", [region("ams", "down")]);

    harness = await startTestBridge({}, backend);
    client = await connectClient(harness);
    await client.login();
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("pushes monitorList as an object keyed by synthetic numeric id", async () => {
    const [list] = (await client.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];

    expect(Object.keys(list).sort()).toEqual(["1", "2", "3", "4"]);
    for (const [key, monitor] of Object.entries(list)) {
      expect(monitor.id).toBe(Number(key));
      expect(typeof monitor.name).toBe("string");
    }
  });

  it("gives each monitor a stable id that is not derived from list order", async () => {
    const [list] = (await client.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];
    const byName = Object.fromEntries(Object.values(list).map((m) => [m.name, m]));
    expect(byName["Website"]?.id).toBe(1);
    expect(byName["Mini-PC"]?.id).toBe(2);
    expect(byName["Resolver"]?.id).toBe(3);

    // Reconnect: the ids must not shuffle.
    client.disconnect();
    const second = await connectClient(harness);
    await second.waitFor("loginRequired");
    await second.login();
    const [list2] = (await second.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];
    expect(Object.fromEntries(Object.values(list2).map((m) => [m.name, m.id]))).toEqual({
      Website: 1,
      "Mini-PC": 2,
      Resolver: 3,
      "Paused thing": 4,
    });
    second.disconnect();
  });

  it("translates each monitor kind correctly", async () => {
    const [list] = (await client.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];
    const byName = Object.fromEntries(Object.values(list).map((m) => [m.name, m]));

    expect(byName["Website"]).toMatchObject({ type: "http", url: "https://example.com", interval: 300 });
    expect(byName["Mini-PC"]).toMatchObject({ type: "port", hostname: "nas.example.com", port: "443", interval: 60 });
    expect(byName["Resolver"]).toMatchObject({ type: "dns", hostname: "example.com", interval: 1800 });
  });

  it("carries every field the frontend dereferences without a guard", async () => {
    const [list] = (await client.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];
    for (const monitor of Object.values(list)) {
      expect(Array.isArray(monitor.tags)).toBe(true);
      expect(Array.isArray(monitor.childrenIDs)).toBe(true);
      expect(monitor.parent).toBeNull();
      expect(typeof monitor.active).toBe("boolean");
    }
  });

  it("reports paused monitors as inactive", async () => {
    const [list] = (await client.waitFor("monitorList")) as [Record<string, KumaMonitorShape>];
    const paused = Object.values(list).find((m) => m.name === "Paused thing");
    expect(paused?.active).toBe(false);
  });

  it("answers getMonitor with {ok, monitor}", async () => {
    const response = await client.emit<{ ok: boolean; monitor: KumaMonitorShape }>("getMonitor", 2);
    expect(response.ok).toBe(true);
    expect(response.monitor).toMatchObject({ id: 2, name: "Mini-PC", type: "port" });
  });

  it("accepts a string monitor id, as the Kuma frontend sends from Object.keys()", async () => {
    const response = await client.emit<{ ok: boolean; monitor: KumaMonitorShape }>("getMonitor", "2");
    expect(response.ok).toBe(true);
    expect(response.monitor.id).toBe(2);
  });

  it("returns {ok:false} for an unknown monitor", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("getMonitor", 9999);
    expect(response).toEqual({ ok: false, msg: "Monitor not found" });
  });

  it("replays monitorList after a reconnect", async () => {
    // The official frontend wipes local state on reconnect and relies entirely
    // on the server re-sending it.
    client.disconnect();
    const second = await connectClient(harness);
    await second.waitFor("loginRequired");
    await second.login();
    await second.waitFor("monitorList");
    const [list] = second.all("monitorList").at(-1) as [Record<string, KumaMonitorShape>];
    expect(Object.keys(list)).toHaveLength(4);
    second.disconnect();
  });
});

describe("mutations the bridge does not support", () => {
  let harness: Harness;
  let client: TestClient;

  beforeEach(async () => {
    const backend = new FakeBackend();
    backend.setMonitor(makeMonitor({ name: "Mini-PC" }));
    harness = await startTestBridge({}, backend);
    client = await connectClient(harness);
    await client.login();
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("never pretends a monitor edit succeeded", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("editMonitor", { id: 1, name: "hacked" });
    expect(response.ok).toBe(false);
    expect(response.msg).toContain("Not supported");
  });

  it("never pretends a notification was created", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("addNotification", { type: "webhook" }, 0);
    expect(response.ok).toBe(false);
  });

  it("still answers getSettings and getTags so settings pages do not hang", async () => {
    const settings = await client.emit<{ ok: boolean; data: Record<string, unknown> }>("getSettings");
    expect(settings.ok).toBe(true);
    expect(settings.data).toMatchObject({ primaryBaseURL: "https://kuma.test", serverTimezone: "UTC" });

    const tags = await client.emit<{ ok: boolean; tags: unknown[] }>("getTags");
    expect(tags).toEqual({ ok: true, tags: [] });
  });
});

describe("pause / resume", () => {
  let harness: Harness;
  let client: TestClient;
  let backend: FakeBackend;

  beforeEach(async () => {
    backend = new FakeBackend();
    backend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 60 }));
    harness = await startTestBridge({}, backend);
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("monitorList");
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("maps pauseMonitor to OpenStatus active=false and pushes the update", async () => {
    const response = await client.emit<{ ok: boolean }>("pauseMonitor", 1);
    expect(response.ok).toBe(true);

    await client.waitFor("updateMonitorIntoList");
    const [update] = (await client.waitFor("updateMonitorIntoList")) as [Record<string, { active: boolean }>];
    expect(update["1"]?.active).toBe(false);
    expect(backend.monitors.get("mon_a")?.active).toBe(false);
  });

  it("maps resumeMonitor back to active=true", async () => {
    await client.emit("pauseMonitor", 1);
    const response = await client.emit<{ ok: boolean }>("resumeMonitor", 1);
    expect(response.ok).toBe(true);
    expect(backend.monitors.get("mon_a")?.active).toBe(true);
  });

  it("reports an error rather than silently succeeding when the backend rejects", async () => {
    backend.failure = new Error("upstream down");
    const response = await client.emit<{ ok: boolean; msg: string }>("pauseMonitor", 1);
    expect(response.ok).toBe(false);
    expect(response.msg).toBeTruthy();
  });
});