import type { ProcessedRecord } from "../types.js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StateEnv {
  db: Database.Database;
}

export const LEGACY_FEED_ID = "bbs28";
const MAX_PROCESSED_ID_KEY_PREFIX = "_max_processed_id";
const ITEM_FAILURE_COUNT_KEY_PREFIX = "_item_failure_count";

function makeKey(feedId: string, nttNo: string): string {
  return `${feedId}:${nttNo}`;
}

function maxIdKey(feedId: string): string {
  return `${MAX_PROCESSED_ID_KEY_PREFIX}:${feedId}`;
}

function itemFailureCountKey(feedId: string, nttNo: string): string {
  return `${ITEM_FAILURE_COUNT_KEY_PREFIX}:${feedId}:${nttNo}`;
}

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_items (
      ntt_no       TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      hash         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

type Row = { ntt_no: string; event_id: string; processed_at: string; hash: string };

function rowToRecord(row: Row, feedId: string, nttNo: string): ProcessedRecord {
  return {
    nttNo,
    eventId: row.event_id,
    processedAt: row.processed_at,
    hash: row.hash,
    feedId,
  };
}

function readMaxId(env: StateEnv, feedId: string): number {
  const stmt = env.db.prepare<[string], { value: string }>(
    "SELECT value FROM meta WHERE key = ?",
  );
  const row = stmt.get(maxIdKey(feedId));
  if (row) return Number.parseInt(row.value, 10) || 0;
  if (feedId === LEGACY_FEED_ID) {
    const legacy = stmt.get(MAX_PROCESSED_ID_KEY_PREFIX);
    if (legacy) return Number.parseInt(legacy.value, 10) || 0;
  }
  return 0;
}

export async function getProcessedRecord(
  env: StateEnv,
  feedId: string,
  nttNo: string,
): Promise<ProcessedRecord | null> {
  const stmt = env.db.prepare<[string], Row>(
    "SELECT ntt_no, event_id, processed_at, hash FROM processed_items WHERE ntt_no = ?",
  );
  const namespaced = stmt.get(makeKey(feedId, nttNo));
  if (namespaced) return rowToRecord(namespaced, feedId, nttNo);
  // Legacy fallback: rows written before feedId namespacing stored raw nttNo
  // and implicitly belonged to the bbs28 feed.
  if (feedId === LEGACY_FEED_ID) {
    const legacy = stmt.get(nttNo);
    if (legacy) {
      // Self-heal: rewrite the pre-namespace row under the namespaced key so
      // future reads hit the primary lookup. The raw-nttNo row is left in
      // place — it is dead data (never re-read after the namespaced row exists)
      // and deleting it would add churn with no behavioral benefit.
      // Invariant: the early return at line 74 guarantees this block runs at
      // most once per nttNo — subsequent reads short-circuit on the namespaced
      // row, so there is no write amplification and no risk of overwriting
      // newer namespaced data with stale legacy data.
      env.db
        .prepare(
          `INSERT INTO processed_items (ntt_no, event_id, processed_at, hash)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(ntt_no) DO UPDATE SET
             event_id     = excluded.event_id,
             processed_at = excluded.processed_at,
             hash         = excluded.hash`,
        )
        .run(makeKey(feedId, nttNo), legacy.event_id, legacy.processed_at, legacy.hash);
      return rowToRecord(legacy, feedId, nttNo);
    }
  }
  return null;
}

export async function putProcessedRecord(
  env: StateEnv,
  feedId: string,
  nttNo: string,
  record: ProcessedRecord,
): Promise<void> {
  env.db
    .prepare(
      `INSERT INTO processed_items (ntt_no, event_id, processed_at, hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ntt_no) DO UPDATE SET
         event_id     = excluded.event_id,
         processed_at = excluded.processed_at,
         hash         = excluded.hash`,
    )
    .run(makeKey(feedId, nttNo), record.eventId, record.processedAt, record.hash);
}

export async function getMaxProcessedId(env: StateEnv, feedId: string): Promise<number> {
  return readMaxId(env, feedId);
}

export async function updateMaxProcessedId(
  env: StateEnv,
  feedId: string,
  id: string,
): Promise<void> {
  const numId = Number.parseInt(id, 10);
  if (Number.isNaN(numId)) {
    console.warn(`updateMaxProcessedId called with non-numeric id: "${id}"`);
    return;
  }
  env.db.transaction(() => {
    const currentMax = readMaxId(env, feedId);
    if (numId > currentMax) {
      env.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(maxIdKey(feedId), numId.toString());
    }
  })();
}

function readItemFailureCount(env: StateEnv, feedId: string, nttNo: string): number {
  const row = env.db
    .prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?")
    .get(itemFailureCountKey(feedId, nttNo));
  if (!row) return 0;

  const count = Number.parseInt(row.value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export async function getItemFailureCount(
  env: StateEnv,
  feedId: string,
  nttNo: string,
): Promise<number> {
  return readItemFailureCount(env, feedId, nttNo);
}

export async function recordItemFailure(
  env: StateEnv,
  feedId: string,
  nttNo: string,
): Promise<number> {
  return env.db.transaction(() => {
    const nextCount = readItemFailureCount(env, feedId, nttNo) + 1;
    env.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(itemFailureCountKey(feedId, nttNo), nextCount.toString());
    return nextCount;
  })();
}

export async function clearItemFailureCount(
  env: StateEnv,
  feedId: string,
  nttNo: string,
): Promise<void> {
  env.db.prepare("DELETE FROM meta WHERE key = ?").run(itemFailureCountKey(feedId, nttNo));
}
