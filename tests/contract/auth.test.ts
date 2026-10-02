import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectClient, startTestBridge, TEST_PASSWORD, TEST_USERNAME, type Harness, type TestClient } from "../helpers/harness.js";
import { FakeBackend, makeMonitor, region } from "../helpers/fake-openstatus.js";
import { KUMA_COMPATIBILITY_VERSION } from "../../src/kuma/protocol/version.js";

/**
 * Authentication against a real Socket.IO server.
 *
 * These mirror Uptime Kuma 2.5.5's `login` / `loginByToken` contract exactly:
 * object argument for `login`, bare string for `loginByToken`, and the i18n
 * message keys translated clients expect.
 */
describe("authentication", () => {
  let harness: Harness;
  let client: TestClient;

  beforeEach(async () => {
    const backend = new FakeBackend();
    backend.setMonitor(makeMonitor({ name: "Mini-PC" }));
    backend.setRegions("mon_1", [region("ams", "up")]);
    harness = await startTestBridge({}, backend);
    client = await connectClient(harness);
  });

  afterEach(async () => {
    client.disconnect();
    await harness.close();
  });

  it("announces info then loginRequired on connect, in that order", async () => {
    await client.waitFor("loginRequired");
    const names = client.events.map((e) => e.name);
    expect(names.indexOf("info")).toBeLessThan(names.indexOf("loginRequired"));
  });

  it("sends a Kuma-shaped info payload", async () => {
    const [info] = (await client.waitFor("info")) as [Record<string, unknown>];
    expect(info).toMatchObject({
      primaryBaseURL: "https://kuma.test",
      serverTimezone: "UTC",
      version: KUMA_COMPATIBILITY_VERSION,
      latestVersion: KUMA_COMPATIBILITY_VERSION,
      dbType: "sqlite",
      runtime: { platform: expect.any(String), arch: expect.any(String) },
    });
  });

  it("accepts correct credentials and returns a token", async () => {
    const response = await client.emit<{ ok: boolean; token: string }>("login", {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    expect(response.ok).toBe(true);
    expect(typeof response.token).toBe("string");
    expect(response.token.split(".")).toHaveLength(3);
  });

  it("rejects a wrong password with Kuma's i18n key", async () => {
    const response = await client.emit<{ ok: boolean; msg: string; msgi18n: boolean }>("login", {
      username: TEST_USERNAME,
      password: "wrong",
    });
    expect(response).toEqual({ ok: false, msg: "authIncorrectCreds", msgi18n: true });
  });

  it("rejects a wrong username identically", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("login", {
      username: "someone-else",
      password: TEST_PASSWORD,
    });
    expect(response).toEqual({ ok: false, msg: "authIncorrectCreds", msgi18n: true });
  });

  it("rate-limits repeated failures", async () => {
    for (let i = 0; i < 12; i += 1) {
      await client.emit("login", { username: TEST_USERNAME, password: `wrong-${i}` });
    }
    const response = await client.emit<{ ok: boolean; msg: string }>("login", {
      username: TEST_USERNAME,
      password: "still-wrong",
    });
    expect(response.ok).toBe(false);
    expect(response.msg).toBe("Too many login attempts");
  });

  it("authenticates a remembered login via loginByToken with a bare string", async () => {
    const token = await client.login();
    client.disconnect();

    const second = await connectClient(harness);
    await second.waitFor("loginRequired");

    const response = await second.emit<{ ok: boolean }>("loginByToken", token);
    expect(response).toEqual({ ok: true });

    // and the initial state follows, as it does in Kuma
    await second.waitFor("monitorList");
    second.disconnect();
  });

  it("rejects an expired or tampered token", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("loginByToken", "not-a-jwt");
    expect(response).toEqual({ ok: false, msg: "authInvalidToken", msgi18n: true });
  });

  it("refuses monitor data before authentication", async () => {
    const response = await client.emit<{ ok: boolean; msg: string }>("getMonitor", 1);
    expect(response).toEqual({ ok: false, msg: "You are not logged in." });
  });

  it("logout drops the session", async () => {
    await client.login();
    await client.emit("logout");
    const response = await client.emit<{ ok: boolean; msg: string }>("getMonitor", 1);
    expect(response.ok).toBe(false);
  });
});