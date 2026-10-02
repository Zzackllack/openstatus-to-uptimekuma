import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "node-sqlite3-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/state/database.js";
import { MonitorIdMap, assignKumaIds } from "../../src/state/monitor-id-map.js";
import { createLogger } from "../../src/observability/logger.js";
import { makeMonitor } from "../helpers/fake-openstatus.js";

const logger = createLogger({ LOG_LEVEL: "silent", NODE_ENV: "test" });

describe("monitor id map", () => {
  let db: Database;
  let map: MonitorIdMap;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kuma-bridge-test-"));
    db = openDatabase({ path: join(dir, "bridge.sqlite"), logger });
    map = new MonitorIdMap(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns numeric ids in first-seen order", () => {
    const a = makeMonitor({ openStatusId: "mon_a" });
    const b = makeMonitor({ openStatusId: "mon_b" });
    const result = map.sync([a, b]);

    expect(result.ids.get("mon_a")).toBe(1);
    expect(result.ids.get("mon_b")).toBe(2);
    expect(result.created).toEqual(["mon_a", "mon_b"]);
  });

  it("keeps ids stable when the listing order changes", () => {
    map.sync([makeMonitor({ openStatusId: "mon_a" }), makeMonitor({ openStatusId: "mon_b" })]);
    const first = map.resolve(["mon_a", "mon_b"]);

    map.sync([makeMonitor({ openStatusId: "mon_b" }), makeMonitor({ openStatusId: "mon_a" })]);

    expect(map.resolve(["mon_a", "mon_b"])).toEqual(first);
  });

  it("survives a restart (new process, same database)", () => {
    map.sync([makeMonitor({ openStatusId: "mon_a" })]);
    const assigned = map.resolveOne("mon_a");

    db.close();
    const reopened = openDatabase({ path: join(dir, "bridge.sqlite"), logger });
    const afterRestart = new MonitorIdMap(reopened).resolveOne("mon_a");

    expect(afterRestart).toBe(assigned);
    reopened.close();
    // Reopen for afterEach.
    db = openDatabase({ path: join(dir, "bridge.sqlite"), logger });
  });

  it("never reuses the id of a deleted monitor", () => {
    map.sync([makeMonitor({ openStatusId: "mon_a" }), makeMonitor({ openStatusId: "mon_b" })]);
    expect(map.resolveOne("mon_a")).toBe(1);
    expect(map.resolveOne("mon_b")).toBe(2);

    // mon_b disappears -> tombstoned, id 2 reserved forever
    const result = map.sync([makeMonitor({ openStatusId: "mon_a" })]);
    expect(result.removed).toEqual(["mon_b"]);

    // A brand new monitor must get 3, not 2.
    const result2 = map.sync([makeMonitor({ openStatusId: "mon_a" }), makeMonitor({ openStatusId: "mon_c" })]);
    expect(result2.ids.get("mon_a")).toBe(1);
    expect(result2.ids.get("mon_c")).toBe(3);
  });

  it("reuses the original id when a tombstoned monitor reappears", () => {
    map.sync([makeMonitor({ openStatusId: "mon_a" }), makeMonitor({ openStatusId: "mon_b" })]);
    map.sync([makeMonitor({ openStatusId: "mon_a" })]);

    const result = map.sync([makeMonitor({ openStatusId: "mon_a" }), makeMonitor({ openStatusId: "mon_b" })]);

    expect(result.revived).toEqual(["mon_b"]);
    expect(result.ids.get("mon_b")).toBe(2);
  });

  it("drops monitors the map does not know about instead of guessing ids", () => {
    const monitors = [makeMonitor({ openStatusId: "mon_known" })];
    map.sync(monitors);

    const assigned = assignKumaIds(
      [makeMonitor({ openStatusId: "mon_known" }), makeMonitor({ openStatusId: "mon_unknown" })],
      map.resolve(["mon_known", "mon_unknown"]),
    );

    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.openStatusId).toBe("mon_known");
    expect(assigned[0]?.kumaId).toBe(1);
  });

  it("applies migrations once and refuses a newer schema", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "kuma-bridge-test-"));
    const path = join(dir2, "bridge.sqlite");

    const first = openDatabase({ path, logger });
    expect(first.all("SELECT version FROM schema_migration")).toHaveLength(1);
    // Re-running migrations must be a no-op.
    openDatabase({ path, logger });
    first.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("observed check store", () => {
  it("deduplicates on (monitor, timestamp) so a fast poll cannot inflate uptime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kuma-bridge-test-"));
    const db = openDatabase({ path: join(dir, "bridge.sqlite"), logger });
    const { ObservedCheckStore } = await import("../../src/state/observed-checks.js");
    const store = new ObservedCheckStore(db);
    const at = new Date("2026-10-01T12:00:00.000Z");

    store.insertMany([
      { monitorId: "mon_a", timestamp: at, status: "up", latencyMs: 20, message: "", regions: [], source: "bridge-poll" },
      { monitorId: "mon_a", timestamp: at, status: "down", latencyMs: null, message: "", regions: [], source: "bridge-poll" },
    ]);

    expect(store.list("mon_a", new Date(at.getTime() - 1000), new Date(at.getTime() + 1000), 10)).toHaveLength(1);
    // Last write wins: the row is keyed, not duplicated.
    expect(store.latest("mon_a", 10)[0]?.status).toBe("down");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});