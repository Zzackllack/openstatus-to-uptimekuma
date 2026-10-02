import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, redactUrlCredentials } from "../../src/config/env.js";

const base = {
  PUBLIC_BASE_URL: "https://kuma.example.com",
  OPENSTATUS_API_KEY: "os-key",
  BRIDGE_USERNAME: "cedric",
  BRIDGE_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA",
  JWT_SECRET: "x".repeat(48),
};

describe("config", () => {
  it("accepts a minimal valid configuration", () => {
    const env = loadConfig(base);
    expect(env.OPENSTATUS_API_URL).toBe("https://api.openstatus.dev/rpc");
    expect(env.DEGRADED_STATUS_MAPPING).toBe("pending");
    expect(env.STATUS_AGGREGATION_STRATEGY).toBe("openstatus");
    expect(env.LATENCY_AGGREGATION).toBe("median");
  });

  it("fails fast on a missing required secret", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OPENSTATUS_API_KEY: undefined })).toThrow(/OPENSTATUS_API_KEY/);
  });

  it("rejects a plaintext password", () => {
    expect(() => loadConfig({ ...base, BRIDGE_PASSWORD_HASH: "hunter2" })).toThrow(/Argon2id/);
  });

  it("rejects a short JWT secret", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "tooshort" })).toThrow(/32 characters/);
  });

  it("requires https for the public base URL except on loopback", () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "http://kuma.example.com" })).toThrow(/https/);
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:3000" }).PUBLIC_BASE_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("never echoes a secret value in the error message", () => {
    try {
      loadConfig({ ...base, JWT_SECRET: "short", PUBLIC_BASE_URL: "http://insecure.example.com" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain("os-key");
      expect((error as ConfigError).message).not.toContain("hunter2");
      expect((error as ConfigError).message).not.toContain("$argon2id");
    }
  });

  it("supports a self-hosted OpenStatus URL", () => {
    const env = loadConfig({ ...base, OPENSTATUS_API_URL: "https://openstatus.internal.example.com/rpc" });
    expect(env.OPENSTATUS_API_URL).toBe("https://openstatus.internal.example.com/rpc");
  });

  it("treats empty strings as absent rather than as invalid values", () => {
    const env = loadConfig({ ...base, LOG_LEVEL: "", OPENSTATUS_WEBHOOK_SECRET: "" });
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.OPENSTATUS_WEBHOOK_SECRET).toBeUndefined();
  });
});

describe("redactUrlCredentials", () => {
  it("removes basic-auth credentials from an API URL", () => {
    expect(redactUrlCredentials("https://user:pass@openstatus.example.com/rpc")).not.toContain("pass");
    expect(redactUrlCredentials("https://openstatus.example.com/rpc")).toBe("https://openstatus.example.com/rpc");
    expect(redactUrlCredentials("not a url")).toBe("[unparseable url]");
  });
});
