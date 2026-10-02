import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket as ClientSocket } from "socket.io-client";
import { startBridge, type Bridge } from "../../src/app.js";
import { loadConfig, type Env } from "../../src/config/env.js";
import { hashPassword } from "../../src/kuma/auth.js";
import { createLogger } from "../../src/observability/logger.js";
import { FakeBackend } from "./fake-openstatus.js";

export const TEST_USERNAME = "cedric";
export const TEST_PASSWORD = "correct horse battery staple";

export interface Harness {
  bridge: Bridge;
  backend: FakeBackend;
  baseUrl: string;
  passwordHash: string;
  close(): Promise<void>;
}

let passwordHashCache: string | null = null;

/** Argon2id is intentionally slow; hash once for the whole suite. */
export async function testPasswordHash(): Promise<string> {
  passwordHashCache ??= await hashPassword(TEST_PASSWORD);
  return passwordHashCache;
}

/** Ports are handed out sequentially to keep the single-fork test run collision-free. */
let nextPort = 24_100;

export async function startTestBridge(
  overrides: Partial<Env> = {},
  backend = new FakeBackend(),
): Promise<Harness> {
  const passwordHash = await testPasswordHash();
  const dir = mkdtempSync(join(tmpdir(), "kuma-bridge-int-"));
  const port = nextPort++;

  // Env overrides arrive already coerced by Zod, so the raw record is built as
  // strings and the validated values are asserted separately in config tests.
  const env = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_BASE_URL: `https://kuma.test`,
    OPENSTATUS_API_URL: "https://openstatus.example.com/rpc",
    OPENSTATUS_API_KEY: "test-key-never-leaves-the-process",
    BRIDGE_USERNAME: TEST_USERNAME,
    BRIDGE_PASSWORD_HASH: passwordHash,
    JWT_SECRET: "a".repeat(48),
    DATABASE_PATH: join(dir, "bridge.sqlite"),
    SERVER_TIMEZONE: "UTC",
    // Poll fast so a driven state change lands within a test's patience without
    // the test having to sleep for a production-length interval.
    STATUS_POLL_INTERVAL_SECONDS: "5",
    MONITOR_LIST_REFRESH_SECONDS: "10",
    SUMMARY_REFRESH_SECONDS: "30",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);

  const bridge = await startBridge(env, {
    backend,
    logger: createLogger({ LOG_LEVEL: "silent", NODE_ENV: "test" }),
  });

  return {
    bridge,
    backend,
    baseUrl: `http://127.0.0.1:${port}`,
    passwordHash,
    close: async () => {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A real Socket.IO client that records every server push.
 *
 * Using the actual `socket.io-client` (rather than a hand-rolled stub) is the
 * point: it is the same library a Kuma client embeds, so transport-level
 * incompatibilities would show up here.
 */
export async function connectClient(harness: Harness): Promise<TestClient> {
  const { io } = await import("socket.io-client");
  const socket = io(harness.baseUrl, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new TestClient(socket);
}

type AnyRecord = Record<string, unknown>;

export class TestClient {
  readonly events: { name: string; args: unknown[] }[] = [];
  private readonly waiters: { name: string; resolve: (args: unknown[]) => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly socket: ClientSocket) {
    socket.onAny((name, ...args) => {
      this.events.push({ name, args });
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter && waiter.name === name) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(args);
        }
      }
    });
  }

  waitFor(name: string, timeoutMs = 8000): Promise<unknown[]> {
    const existing = this.events.filter((e) => e.name === name);
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      return Promise.resolve(last ? last.args : []);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for "${name}"; saw: ${[...new Set(this.events.map((e) => e.name))].join(", ")}`));
      }, timeoutMs);
      this.waiters.push({ name, resolve, timer });
    });
  }

  all(name: string): unknown[][] {
    return this.events.filter((e) => e.name === name).map((e) => e.args);
  }

  emit<T = AnyRecord>(name: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout for "${name}"`)), 8000);
      this.socket.emit(name, ...args, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  async login(username = TEST_USERNAME, password = TEST_PASSWORD): Promise<string> {
    const response = await this.emit<{ ok: boolean; token?: string }>("login", { username, password });
    if (!response.ok || !response.token) throw new Error(`login failed: ${JSON.stringify(response)}`);
    return response.token;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  get id(): string {
    return this.socket.id ?? "";
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}
