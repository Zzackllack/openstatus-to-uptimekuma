/**
 * `node-sqlite3-wasm` is CommonJS.
 *
 * A named import (`import { Database } from "node-sqlite3-wasm"`) works under
 * Vitest's transform but throws `does not provide an export named 'Database'`
 * under plain Node ESM. The interop is done once, here, with the type
 * re-exported so no other module has to think about it.
 */
import sqlite from "node-sqlite3-wasm";

export const { Database } = sqlite;
export type { Database as SqliteDatabase } from "node-sqlite3-wasm";