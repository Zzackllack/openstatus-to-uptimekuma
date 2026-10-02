
import type { NormalizedMonitor } from "../model/monitor.js";
import type { SqliteDatabase } from "./sqlite.js";

interface MapRow {
  kuma_id: number;
  openstatus_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface SyncResult {
  /** Every live OpenStatus id → Kuma id, including rows revived from tombstone. */
  ids: Map<string, number>;
  created: string[];
  revived: string[];
  /** OpenStatus ids that were tombstoned by this sync. */
  removed: string[];
}

/**
 * Persistent OpenStatus ↔ Kuma id translation.
 *
 * The contract with the user is that a monitor's identity never changes: not
 * across restarts, not across reordering, not after deletion. Everything here
 * exists to protect that.
 */
export class MonitorIdMap {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Reconcile the map with the current OpenStatus monitor set.
   *
   * Ordering is irrelevant: ids come from an AUTOINCREMENT column, not from
   * array position.
   */
  sync(monitors: readonly NormalizedMonitor[]): SyncResult {
    const live = new Set(monitors.map((m) => m.openStatusId));
    const created: string[] = [];
    const revived: string[] = [];

    const existing = new Map<string, MapRow>(
      this.db.all("SELECT * FROM monitor_id_map").map((row) => {
        const typed = row as unknown as MapRow;
        return [typed.openstatus_id, typed];
      }),
    );

    const insert = this.db.prepare(
      `INSERT INTO monitor_id_map (openstatus_id, created_at, deleted_at)
       VALUES (?, ?, ?)
       ON CONFLICT(openstatus_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
    );
    const now = new Date().toISOString();

    for (const monitor of monitors) {
      const row = existing.get(monitor.openStatusId);
      if (!row) {
        insert.run([monitor.openStatusId, now, null]);
        created.push(monitor.openStatusId);
      } else if (row.deleted_at !== null) {
        // Same OpenStatus id came back: reuse the id it always had, otherwise
        // every phone that cached it would show the wrong monitor.
        revived.push(monitor.openStatusId);
      }
    }

    const removed = [...existing.values()]
      .filter((row) => row.deleted_at === null && !live.has(row.openstatus_id))
      .map((row) => row.openstatus_id);

    if (removed.length > 0) {
      const tombstone = this.db.prepare("UPDATE monitor_id_map SET deleted_at = ? WHERE openstatus_id = ?");
      for (const id of removed) tombstone.run([now, id]);
    }

    const ids = this.resolve(monitors.map((m) => m.openStatusId));
    return { ids, created, revived, removed };
  }

  /** Look up the Kuma id for each OpenStatus id, without creating anything. */
  resolve(openStatusIds: readonly string[]): Map<string, number> {
    if (openStatusIds.length === 0) return new Map();

    const placeholders = openStatusIds.map(() => "?").join(",");
    const rows = this.db.all(
      `SELECT openstatus_id, kuma_id FROM monitor_id_map WHERE openstatus_id IN (${placeholders})`,
      [...openStatusIds],
    ) as unknown as { openstatus_id: string; kuma_id: number }[];

    return new Map(rows.map((row) => [row.openstatus_id, Number(row.kuma_id)]));
  }

  resolveOne(openStatusId: string): number | null {
    return this.resolve([openStatusId]).get(openStatusId) ?? null;
  }

  /**
   * Tombstone a single monitor (used when a client deletes one, or when a
   * monitor turns out to be unreadable). The row is kept so the id is never
   * handed to a different monitor.
   */
  tombstone(openStatusId: string): void {
    this.db.run("UPDATE monitor_id_map SET deleted_at = ? WHERE openstatus_id = ? AND deleted_at IS NULL", [
      new Date().toISOString(),
      openStatusId,
    ]);
  }
}

/** Attach Kuma ids to freshly fetched monitors. */
export function assignKumaIds(monitors: readonly NormalizedMonitor[], ids: Map<string, number>): NormalizedMonitor[] {
  const result: NormalizedMonitor[] = [];
  for (const monitor of monitors) {
    const kumaId = ids.get(monitor.openStatusId);
    if (kumaId === undefined) continue; // not synced; caller must not use it
    result.push({ ...monitor, kumaId });
  }
  return result;
}