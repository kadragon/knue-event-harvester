import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDatabase,
  getProcessedRecord,
  putProcessedRecord,
  getMaxProcessedId,
  updateMaxProcessedId,
  getItemFailureCount,
  recordItemFailure,
  clearItemFailureCount,
  type StateEnv,
} from '../../src/lib/state.js';
import type { ProcessedRecord } from '../../src/types.js';

describe('State Module', () => {
  let db: Database.Database;
  let env: StateEnv;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
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
    env = { db };
  });

  afterEach(() => {
    db.close();
  });

  describe('openDatabase', () => {
    it('creates tables and returns a Database instance', () => {
      const tmpDb = openDatabase(':memory:');
      try {
        const tables = tmpDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>;
        const names = tables.map((r) => r.name);
        expect(names).toContain('processed_items');
        expect(names).toContain('meta');
      } finally {
        tmpDb.close();
      }
    });
  });

  describe('getProcessedRecord', () => {
    it('returns record stored with namespaced key', async () => {
      const record: ProcessedRecord = {
        eventId: 'test-event',
        nttNo: '123',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'test-hash',
        feedId: 'bbs250',
      };
      await putProcessedRecord(env, 'bbs250', '123', record);

      const result = await getProcessedRecord(env, 'bbs250', '123');
      expect(result).toEqual(record);
    });

    it('does not return record from a different feed with same nttNo', async () => {
      const record: ProcessedRecord = {
        eventId: 'test-event',
        nttNo: '123',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'test-hash',
        feedId: 'bbs250',
      };
      await putProcessedRecord(env, 'bbs250', '123', record);

      const result = await getProcessedRecord(env, 'bbs28', '123');
      expect(result).toBeNull();
    });

    it('returns null when key not found', async () => {
      const result = await getProcessedRecord(env, 'bbs28', 'nonexistent-id');
      expect(result).toBeNull();
    });

    it('falls back to legacy raw-nttNo row when feedId is bbs28', async () => {
      db.prepare(
        'INSERT INTO processed_items (ntt_no, event_id, processed_at, hash) VALUES (?, ?, ?, ?)',
      ).run('legacy-123', 'event-legacy', '2023-01-01T00:00:00Z', 'legacy-hash');

      const result = await getProcessedRecord(env, 'bbs28', 'legacy-123');
      expect(result).toEqual({
        eventId: 'event-legacy',
        nttNo: 'legacy-123',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'legacy-hash',
        feedId: 'bbs28',
      });
    });

    it('self-heals legacy row by writing the namespaced key on fallback read', async () => {
      db.prepare(
        'INSERT INTO processed_items (ntt_no, event_id, processed_at, hash) VALUES (?, ?, ?, ?)',
      ).run('legacy-777', 'event-heal', '2023-02-02T00:00:00Z', 'heal-hash');

      const result = await getProcessedRecord(env, 'bbs28', 'legacy-777');

      expect(result).toEqual({
        eventId: 'event-heal',
        nttNo: 'legacy-777',
        processedAt: '2023-02-02T00:00:00Z',
        hash: 'heal-hash',
        feedId: 'bbs28',
      });

      const namespaced = db
        .prepare('SELECT event_id, processed_at, hash FROM processed_items WHERE ntt_no = ?')
        .get('bbs28:legacy-777') as { event_id: string; processed_at: string; hash: string } | undefined;
      expect(namespaced).toEqual({
        event_id: 'event-heal',
        processed_at: '2023-02-02T00:00:00Z',
        hash: 'heal-hash',
      });
    });

    it('does not fall back to legacy row for non-bbs28 feeds', async () => {
      db.prepare(
        'INSERT INTO processed_items (ntt_no, event_id, processed_at, hash) VALUES (?, ?, ?, ?)',
      ).run('legacy-123', 'event-legacy', '2023-01-01T00:00:00Z', 'legacy-hash');

      const result = await getProcessedRecord(env, 'bbs250', 'legacy-123');
      expect(result).toBeNull();
    });
  });

  describe('putProcessedRecord', () => {
    it('stores record using namespaced key', async () => {
      const record: ProcessedRecord = {
        eventId: 'test-event',
        nttNo: '123',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'test-hash',
        feedId: 'bbs28',
      };

      await putProcessedRecord(env, 'bbs28', '123', record);

      const row = db
        .prepare('SELECT ntt_no FROM processed_items WHERE ntt_no = ?')
        .get('bbs28:123') as { ntt_no: string } | undefined;
      expect(row?.ntt_no).toBe('bbs28:123');
    });

    it('overwrites existing record (upsert)', async () => {
      const original: ProcessedRecord = {
        eventId: 'original-event',
        nttNo: '456',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'original-hash',
        feedId: 'bbs28',
      };
      const updated: ProcessedRecord = {
        ...original,
        eventId: 'updated-event',
        processedAt: '2023-06-15T12:00:00Z',
        hash: 'updated-hash',
      };

      await putProcessedRecord(env, 'bbs28', '456', original);
      await putProcessedRecord(env, 'bbs28', '456', updated);

      const result = await getProcessedRecord(env, 'bbs28', '456');
      expect(result).toEqual(updated);
    });

    it('keeps records from different feeds isolated even when nttNo collides', async () => {
      const a: ProcessedRecord = {
        eventId: 'evt-a',
        nttNo: '999',
        processedAt: '2023-01-01T00:00:00Z',
        hash: 'hash-a',
        feedId: 'bbs28',
      };
      const b: ProcessedRecord = {
        ...a,
        eventId: 'evt-b',
        hash: 'hash-b',
        feedId: 'bbs250',
      };

      await putProcessedRecord(env, 'bbs28', '999', a);
      await putProcessedRecord(env, 'bbs250', '999', b);

      expect(await getProcessedRecord(env, 'bbs28', '999')).toEqual(a);
      expect(await getProcessedRecord(env, 'bbs250', '999')).toEqual(b);
    });
  });

  describe('getMaxProcessedId', () => {
    it('returns per-feed stored max ID', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_max_processed_id:bbs250', '5000')").run();

      const result = await getMaxProcessedId(env, 'bbs250');
      expect(result).toBe(5000);
    });

    it('returns 0 when no max ID is stored for the feed', async () => {
      const result = await getMaxProcessedId(env, 'bbs250');
      expect(result).toBe(0);
    });

    it('falls back to legacy key for bbs28 feed', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_max_processed_id', '1234')").run();

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(1234);
      expect(await getMaxProcessedId(env, 'bbs250')).toBe(0);
    });

    it('returns 0 when stored value is not a number', async () => {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('_max_processed_id:bbs28', 'not-a-number')",
      ).run();

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(0);
    });
  });

  describe('updateMaxProcessedId', () => {
    it('updates per-feed max ID when new ID is larger', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_max_processed_id:bbs28', '5000')").run();

      await updateMaxProcessedId(env, 'bbs28', '5100');

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(5100);
    });

    it('does not update when new ID is smaller than current max', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_max_processed_id:bbs28', '5000')").run();

      await updateMaxProcessedId(env, 'bbs28', '4999');

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(5000);
    });

    it('updates independent max IDs per feed', async () => {
      await updateMaxProcessedId(env, 'bbs28', '100');
      await updateMaxProcessedId(env, 'bbs250', '9000');

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(100);
      expect(await getMaxProcessedId(env, 'bbs250')).toBe(9000);
    });

    it('does not update and does not throw when new ID is not a number', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_max_processed_id:bbs28', '5000')").run();

      await updateMaxProcessedId(env, 'bbs28', 'not-a-number');

      expect(await getMaxProcessedId(env, 'bbs28')).toBe(5000);
    });
  });

  describe('item failure counts', () => {
    it('persists consecutive failures per feed and item', async () => {
      expect(await getItemFailureCount(env, 'bbs28', '123')).toBe(0);

      expect(await recordItemFailure(env, 'bbs28', '123')).toBe(1);
      expect(await recordItemFailure(env, 'bbs28', '123')).toBe(2);
      expect(await getItemFailureCount(env, 'bbs28', '123')).toBe(2);

      expect(await recordItemFailure(env, 'bbs250', '123')).toBe(1);
      expect(await getItemFailureCount(env, 'bbs28', '123')).toBe(2);
      expect(await getItemFailureCount(env, 'bbs250', '123')).toBe(1);
    });

    it('clears a failure count so a later failure starts a new streak', async () => {
      await recordItemFailure(env, 'bbs28', '123');
      await recordItemFailure(env, 'bbs28', '123');

      await clearItemFailureCount(env, 'bbs28', '123');

      expect(await getItemFailureCount(env, 'bbs28', '123')).toBe(0);
      expect(await recordItemFailure(env, 'bbs28', '123')).toBe(1);
    });

    it('treats a malformed stored count as zero', async () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('_item_failure_count:bbs28:123', 'invalid')").run();

      expect(await getItemFailureCount(env, 'bbs28', '123')).toBe(0);
      expect(await recordItemFailure(env, 'bbs28', '123')).toBe(1);
    });
  });
});
