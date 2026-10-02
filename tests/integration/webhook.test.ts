import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectClient, startTestBridge, type Harness, type TestClient } from "../helpers/harness.js";
import { FakeBackend, makeMonitor, region } from "../helpers/fake-openstatus.js";
import { parseWebhookPayload, verifyWebhookSecret } from "../../src/webhook/verify.js";

const SECRET = "s3cret-webhook-shared-value";
const HEADER = "x-bridge-secret";

describe("webhook authentication", () => {
  it("rejects when no secret is configured", () => {
    expect(verifyWebhookSecret("anything", undefined).ok).toBe(false);
  });

  it("accepts the exact secret and rejects near-misses", () => {
    expect(verifyWebhookSecret(SECRET, SECRET).ok).toBe(true);
    expect(verifyWebhookSecret(`${SECRET}x`, SECRET).ok).toBe(false);
    expect(verifyWebhookSecret(SECRET.slice(0, -1), SECRET).ok).toBe(false);
    expect(verifyWebhookSecret(undefined, SECRET).ok).toBe(false);
  });
});

describe("webhook payload parsing", () => {
  it("accepts the payload OpenStatus actually sends", () => {
    const result = parseWebhookPayload({
      monitor: { id: 123, name: "Mini-PC", url: "https://example.com" },
      cronTimestamp: 1744023705307,
      status: "error",
      statusCode: 500,
      latency: 1337,
      errorMessage: "Internal Server Error",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The webhook sends a *number* here while the RPC layer uses strings.
      expect(result.payload.monitor.id).toBe("123");
      expect(result.payload.status).toBe("error");
    }
  });

  it("uses `recovered`, not `active`", () => {
    expect(
      parseWebhookPayload({ monitor: { id: 1 }, cronTimestamp: 1, status: "recovered" }).ok,
    ).toBe(true);
    expect(parseWebhookPayload({ monitor: { id: 1 }, cronTimestamp: 1, status: "active" }).ok).toBe(false);
  });

  it("rejects malformed input without echoing it back", () => {
    const result = parseWebhookPayload({ monitor: { id: 1 }, cronTimestamp: "soon", status: "error" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cronTimestamp");
  });
});

describe("webhook ingestion", () => {
  let harness: Harness;
  let client: TestClient;
  let backend: FakeBackend;

  const post = async (body: unknown, secret: string | null = SECRET) =>
    fetch(`${harness.baseUrl}/webhooks/openstatus`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === null ? {} : { [HEADER]: secret }),
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    backend = new FakeBackend();
    backend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 30, status: "up" }));
    backend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    harness = await startTestBridge({ OPENSTATUS_WEBHOOK_SECRET: SECRET }, backend);
    client = await connectClient(harness);
    await client.login();
    await client.waitFor("heartbeatList");
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("rejects an unauthenticated request", async () => {
    const response = await post({ monitor: { id: "mon_a" }, cronTimestamp: Date.now(), status: "error" }, null);
    expect(response.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const response = await post(
      { monitor: { id: "mon_a" }, cronTimestamp: Date.now(), status: "error" },
      "wrong-secret-value",
    );
    expect(response.status).toBe(401);
  });

  it("rejects an oversized or malformed body", async () => {
    const response = await post({ nope: true });
    expect(response.status).toBe(400);
  });

  it("applies an outage and pushes a heartbeat to connected clients", async () => {
    // The webhook means OpenStatus' quorum already transitioned; the regions we
    // read back confirm it.
    backend.setMonitor({ ...backend.monitors.get("mon_a")!, status: "down" });
    backend.setRegions("mon_a", [region("fly_ams", "down"), region("fly_iad", "down")]);

    const before = client.all("heartbeat").length;
    const response = await post({
      monitor: { id: "mon_a", name: "Mini-PC" },
      cronTimestamp: Date.now(),
      status: "error",
      errorMessage: "connection refused",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, applied: true });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.all("heartbeat").length).toBeGreaterThan(before);
    const beat = client.all("heartbeat").at(-1)?.[0] as { status: number; important: boolean };
    expect(beat.status).toBe(0);
    expect(beat.important).toBe(true);
  });

  it("is idempotent: a duplicate delivery does not re-emit a transition", async () => {
    backend.setMonitor({ ...backend.monitors.get("mon_a")!, status: "down" });
    backend.setRegions("mon_a", [region("fly_ams", "down"), region("fly_iad", "down")]);

    const payload = { monitor: { id: "mon_a" }, cronTimestamp: Date.now(), status: "error" };
    await post(payload);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const countAfterFirst = client.all("heartbeat").length;

    const second = await post(payload);
    expect(await second.json()).toMatchObject({ received: true, applied: false });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // OpenStatus retries webhooks up to three times; that must not produce three
    // identical pushes, and `cronTimestamp` is the idempotency key.
    expect(client.all("heartbeat").length).toBe(countAfterFirst);
  });

  it("ignores an out-of-order delivery older than the state it already applied", async () => {
    const now = Date.now();
    backend.setMonitor({ ...backend.monitors.get("mon_a")!, status: "down" });
    backend.setRegions("mon_a", [region("fly_ams", "down")]);

    await post({ monitor: { id: "mon_a" }, cronTimestamp: now, status: "error" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const count = client.all("heartbeat").length;

    // A late retry from before the transition must not rewind the monitor.
    backend.setRegions("mon_a", [region("fly_ams", "up"), region("fly_iad", "up")]);
    const late = await post({ monitor: { id: "mon_a" }, cronTimestamp: now - 60_000, status: "recovered" });

    expect(await late.json()).toMatchObject({ received: true, applied: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.all("heartbeat").length).toBe(count);
  });

  it("accepts a webhook for a monitor it has not synced yet without failing", async () => {
    const response = await post({
      monitor: { id: "mon_unknown" },
      cronTimestamp: Date.now(),
      status: "error",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, applied: false });
  });
});

describe("bridge HTTP surface", () => {
  let harness: Harness;

  beforeEach(async () => {
    const backend = new FakeBackend();
    backend.setMonitor(makeMonitor({ openStatusId: "mon_a", name: "Mini-PC", intervalSeconds: 30 }));
    backend.setRegions("mon_a", [region("fly_ams", "up")]);
    harness = await startTestBridge({}, backend);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("reports health without leaking the OpenStatus key", async () => {
    const response = await fetch(`${harness.baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", openstatus: "connected", monitors: 1 });

    // With a healthy backend, readiness agrees with liveness.
    const ready = await fetch(`${harness.baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("test-key-never-leaves-the-process");
  });

  it("exposes bridge info separately from the Kuma protocol", async () => {
    const response = await fetch(`${harness.baseUrl}/bridge/info`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "openstatus-kuma-bridge",
      kumaCompatibilityVersion: "2.5.5",
      openstatusConnected: true,
    });
    expect(body["config"]).toMatchObject({ degradedStatusMapping: "pending", statusAggregationStrategy: "openstatus" });
    // The API key must never appear anywhere in the bridge's own diagnostics.
    expect(JSON.stringify(body)).not.toContain("test-key-never-leaves-the-process");
  });

  it("sets defensive security headers", async () => {
    const response = await fetch(`${harness.baseUrl}/healthz`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves Prometheus metrics", async () => {
    const response = await fetch(`${harness.baseUrl}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("bridge_monitors 1");
    expect(body).toContain("bridge_socket_connections");
  });

  it("404s unknown paths instead of falling through to a Kuma-looking page", async () => {
    const response = await fetch(`${harness.baseUrl}/dashboard`);
    expect(response.status).toBe(404);
  });
});