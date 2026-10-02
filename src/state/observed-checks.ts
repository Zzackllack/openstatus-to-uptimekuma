
import type { NormalizedCheck, NormalizedRegionalResult } from "../model/monitor.js";
import type { SqliteDatabase } from "./sqlite.js";

/**
 * The bridge's own log of observed checks.
 *
 * This is *not* a second monitoring system: nothing here is produced by an
 * HTTP/TCP/DNS probe. Every row records a state the bridge read out of
 * OpenStatus. It exists because OpenStatus exposes real response logs for HTTP
 * monitors only, and a monitor with no history has no uptime, no chart and no
 * heartbeat bar in a Kuma client.
 *
 * Consequence to be honest about: for TCP/DNS monitors, history depth is bounded
 * by how long the bridge has been running, not by OpenStatus retention.
 */
export class ObservedCheckStore {
  constructor(private readonly db: SqliteDatabase) {}

  insert(check: NormalizedCheck): void {
    this.db.run(
      `INSERT INTO observed_check (openstatus_id, checked_at, status, latency_ms, message, regions_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(openstatus_id, checked_at) DO UPDATE SET
         status = excluded.status,
         latency_ms = excluded.latency_ms,
         message = excluded.message,
         regions_json = excluded.regions_json,
         source = excluded.source`,
      [
        check.monitorId,
        check.timestamp.getTime(),
        check.status,
        check.latencyMs,
        check.message,
        JSON.stringify(check.regions),
        check.source,
      ],
    );
  }

  insertMany(checks: readonly NormalizedCheck[]): void {
    if (checks.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const check of checks) this.insert(check);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(openStatusId: string, from: Date, to: Date, limit: number): NormalizedCheck[] {
    const rows = this.db.all(
      `SELECT * FROM observed_check
       WHERE openstatus_id = ? AND checked_at >= ? AND checked_at <= ?
       ORDER BY checked_at DESC
       LIMIT ?`,
      [openStatusId, from.getTime(), to.getTime(), limit],
    ) as unknown as ObservedRow[];

    return rows.map(toCheck).reverse();
  }

  /** Newest checks first is what the caller usually wants; keep that available. */
  latest(openStatusId: string, limit: number): NormalizedCheck[] {
    const rows = this.db.all(
      "SELECT * FROM observed_check WHERE openstatus_id = ? ORDER BY checked_at DESC LIMIT ?",
      [openStatusId, limit],
    ) as unknown as ObservedRow[];
    return rows.map(toCheck);
  }

  /** Keep the table bounded; older rows are already summarized in uptime. */
  pruneOlderThan(cutoff: Date): number {
    const result = this.db.run("DELETE FROM observed_check WHERE checked_at < ?", [cutoff.getTime()]);
    return result.changes;
  }
}

interface ObservedRow {
  openstatus_id: string;
  checked_at: number;
  status: NormalizedCheck["status"];
  latency_ms: number | null;
  message: string;
  regions_json: string;
  source: NormalizedCheck["source"];
}

function toCheck(row: ObservedRow): NormalizedCheck {
  return {
    monitorId: row.openstatus_id,
    timestamp: new Date(Number(row.checked_at)),
    status: row.status,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    message: row.message,
    regions: parseRegions(row.regions_json),
    source: row.source,
  };
}

function parseRegions(value: string): NormalizedRegionalResult[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is NormalizedRegionalResult =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as NormalizedRegionalResult).region === "string" &&
        typeof (entry as NormalizedRegionalResult).status === "string",
    );
  } catch {
    return [];
  }
}