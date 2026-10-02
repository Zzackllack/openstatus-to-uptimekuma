import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import type { Logger } from "../observability/logger.js";
import { Database, type SqliteDatabase } from "./sqlite.js";

/**
 * Direct SQLite with versioned migrations.
 *
 * Deliberately no ORM: the schema is three small tables and the only hot path is
 * an autoincrement + two indexed lookups. A migration framework would be more
 * machinery than the problem deserves.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      -- Stable OpenStatus <-> synthetic Kuma id mapping.
      --
      -- AUTOINCREMENT (not ROWID) is required: without it SQLite reuses the
      -- highest deleted rowid, which would hand a new monitor the id of a
      -- deleted one and make a phone's cached monitor list point at the wrong
      -- service. Tombstones (deleted_at) keep ids reserved forever.
      CREATE TABLE monitor_id_map (
        kuma_id        INTEGER PRIMARY KEY AUTOINCREMENT,
        openstatus_id  TEXT NOT NULL UNIQUE,
        created_at     TEXT NOT NULL,
        deleted_at     TEXT
      );

      -- Checks the bridge itself observed, for every monitor kind.
      --
      -- OpenStatus only exposes real response logs for HTTP monitors, so without
      -- this table TCP and DNS monitors would have no history, no uptime and no
      -- chart at all. We store what we actually saw and never backfill it.
      CREATE TABLE observed_check (
        openstatus_id  TEXT NOT NULL,
        checked_at     INTEGER NOT NULL,
        status         TEXT NOT NULL,
        latency_ms     INTEGER,
        message        TEXT NOT NULL DEFAULT '',
        regions_json   TEXT NOT NULL DEFAULT '[]',
        source         TEXT NOT NULL DEFAULT 'bridge-poll',
        PRIMARY KEY (openstatus_id, checked_at)
      );
      CREATE INDEX idx_observed_check_recent ON observed_check (openstatus_id, checked_at DESC);

      -- Idempotency for OpenStatus webhooks, which are retried up to three times.
      CREATE TABLE webhook_dedup (
        openstatus_id  TEXT NOT NULL,
        cron_timestamp INTEGER NOT NULL,
        received_at    TEXT NOT NULL,
        PRIMARY KEY (openstatus_id, cron_timestamp)
      );
    `,
  },
];

export interface StoreOptions {
  path: string;
  logger: Logger;
}

export function openDatabase({ path, logger }: StoreOptions): SqliteDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  // WAL keeps the poller's writes from blocking the Socket.IO thread's reads.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db, logger);
  return db;
}

export function migrate(db: SqliteDatabase, logger: Logger): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .all("SELECT version FROM schema_migration")
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // Each migration is atomic. No destructive auto-migration: a bridge that
    // silently drops its id map on an unknown future schema would be worse than
    // refusing to start.
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
      db.exec("COMMIT");
      logger.info({ version: migration.version, name: migration.name }, "db.migration.applied");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const known = new Set(MIGRATIONS.map((m) => m.version));
  const unknown = [...applied].filter((v) => !known.has(v));
  if (unknown.length > 0) {
    throw new Error(
      `Database schema is newer than this build (found migrations ${unknown.join(", ")}). Upgrade the bridge before starting.`,
    );
  }
}