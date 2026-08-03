import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { run } from '../src/index.js';
import type { FeedSource, RssItem } from '../src/types.js';

vi.mock('../src/lib/rss.js', () => ({
  parseRss: vi.fn(),
}));

vi.mock('../src/lib/ai.js', async (importOriginal) => ({
  // Keep the real AiResponseParseError so tests can reject with the genuine class.
  AiResponseParseError: (await importOriginal<typeof import('../src/lib/ai.js')>())
    .AiResponseParseError,
  generateSummary: vi.fn(),
  generateEventInfos: vi.fn(),
  extractTextFromImage: vi.fn(),
}));

vi.mock('../src/lib/calendar.js', () => ({
  obtainAccessToken: vi.fn(),
  listEvents: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock('../src/lib/dedupe.js', () => ({
  isDuplicate: vi.fn(),
  computeHash: vi.fn(),
}));

vi.mock('../src/lib/state.js', () => ({
  getProcessedRecord: vi.fn(),
  putProcessedRecord: vi.fn(),
  getMaxProcessedId: vi.fn(),
  updateMaxProcessedId: vi.fn(),
  getItemFailureCount: vi.fn(),
  recordItemFailure: vi.fn(),
  clearItemFailureCount: vi.fn(),
  openDatabase: vi.fn(),
  LEGACY_FEED_ID: 'bbs28',
}));

vi.mock('../src/lib/telegram.js', () => ({
  sendNotification: vi.fn(),
}));

import { parseRss } from '../src/lib/rss.js';
import { AiResponseParseError, generateSummary, generateEventInfos } from '../src/lib/ai.js';
import { obtainAccessToken, listEvents, createEvent } from '../src/lib/calendar.js';
import {
  getMaxProcessedId,
  getProcessedRecord,
  putProcessedRecord,
  updateMaxProcessedId,
  getItemFailureCount,
  recordItemFailure,
  clearItemFailureCount,
} from '../src/lib/state.js';
import { isDuplicate, computeHash } from '../src/lib/dedupe.js';

const NOTICE_FEED: FeedSource = {
  id: 'bbs28',
  url: 'https://www.knue.ac.kr/rssBbsNtt.do?bbsNo=28',
  label: '행사세미나',
};

const CHEONGNAM_FEED: FeedSource = {
  id: 'bbs250',
  url: 'https://www.knue.ac.kr/rssBbsNtt.do?bbsNo=250',
  label: '청람동정',
};

describe('Integration Tests', () => {
  let mockEnv: any;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    mockEnv = {
      db,
      GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      GOOGLE_CALENDAR_ID: 'test-calendar',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      OLLAMA_CONTENT_MODEL: 'llama3.1:8b',
      SIMILARITY_THRESHOLD: '0.85',
      LOOKBACK_DAYS: '60',
    };

    vi.clearAllMocks();
    global.fetch = vi.fn();
    (obtainAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue('test-token');
    (listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getMaxProcessedId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (getProcessedRecord as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (putProcessedRecord as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getItemFailureCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (recordItemFailure as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (clearItemFailureCount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (computeHash as ReturnType<typeof vi.fn>).mockResolvedValue('hash');
    (isDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('run()', () => {
    it('processes an empty RSS feed without errors', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss><channel></channel></rss>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const stats = await run(mockEnv, [NOTICE_FEED]);

      expect(stats).toEqual({ processed: 0, created: 0 });
    });

    it('skips items already processed (below maxProcessedId)', async () => {
      const mockItems: RssItem[] = [
        {
          id: '100',
          title: 'Old item',
          link: 'https://example.com/100',
          pubDate: '2023-01-01',
          descriptionHtml: '<p>Old content</p>',
        },
      ];
      const failureKey = `${NOTICE_FEED.id}:100`;
      const failureCounts = new Map([[failureKey, 2]]);

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue(mockItems);
      (getMaxProcessedId as ReturnType<typeof vi.fn>).mockResolvedValue(200);
      (clearItemFailureCount as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, feedId: string, nttNo: string) => {
          failureCounts.delete(`${feedId}:${nttNo}`);
        },
      );

      const stats = await run(mockEnv, [NOTICE_FEED]);

      expect(stats.processed).toBe(1);
      expect(stats.created).toBe(0);
      expect(generateSummary).not.toHaveBeenCalled();
      expect(generateEventInfos).not.toHaveBeenCalled();
      expect(clearItemFailureCount).toHaveBeenCalledWith(mockEnv, NOTICE_FEED.id, '100');
      expect(failureCounts.has(failureKey)).toBe(false);
    });

    it('iterates every configured feed', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await run(mockEnv, [NOTICE_FEED, CHEONGNAM_FEED]);

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        ([url]) => url as string,
      );
      expect(fetchCalls).toContain(NOTICE_FEED.url);
      expect(fetchCalls).toContain(CHEONGNAM_FEED.url);
    });

    it('continues processing remaining feeds when one feed fails', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const goodItem: RssItem = {
        id: '555',
        title: '학술제 안내',
        link: 'https://www.knue.ac.kr/notice/555',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>행사 내용</p>',
      };

      // bbs28 fetch fails; bbs250 fetch succeeds
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.includes('bbsNo=28')) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('<rss/>') });
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([goodItem]);
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '요약', highlights: [], actionItems: [], links: [],
      });
      (generateEventInfos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          title: '학술제',
          description: '',
          startDate: '2026-04-20',
          endDate: '2026-04-20',
        },
      ]);
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt-555',
        htmlLink: 'https://calendar.example/evt-555',
      });

      const stats = await run(mockEnv, [NOTICE_FEED, CHEONGNAM_FEED]);

      expect(createEvent).toHaveBeenCalledTimes(1);
      expect(stats.processed).toBe(1);
      expect(stats.created).toBe(1);

      vi.useRealTimers();
    });

    it('Golden Principle 4: per-item errors do not abort run()', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const badItem: RssItem = {
        id: '101',
        title: '첫번째',
        link: 'https://www.knue.ac.kr/notice/101',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>실패 케이스</p>',
      };
      const goodItem: RssItem = {
        id: '102',
        title: '두번째',
        link: 'https://www.knue.ac.kr/notice/102',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>정상 케이스</p>',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([badItem, goodItem]);

      // First item explodes during summarisation; second item proceeds normally.
      (generateSummary as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, content: { title: string }) => {
          if (content.title === '첫번째') throw new Error('LLM blew up');
          return { summary: '요약', highlights: [], actionItems: [], links: [] };
        },
      );
      (generateEventInfos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          title: '행사',
          description: '',
          startDate: '2026-04-20',
          endDate: '2026-04-20',
        },
      ]);
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt-102',
        htmlLink: 'https://calendar.example/evt-102',
      });

      const stats = await run(mockEnv, [NOTICE_FEED]);

      // Loop must have reached the second item despite the first one throwing.
      expect(generateSummary).toHaveBeenCalledTimes(2);
      expect(createEvent).toHaveBeenCalledTimes(1);
      const createdArgs = (createEvent as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createdArgs[3]).toEqual(expect.objectContaining({ nttNo: '102' }));
      expect(stats.created).toBe(1);

      vi.useRealTimers();
    });

    it('marks 청람동정 non-event items as processed without creating a calendar event', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const noticeOnlyItem: RssItem = {
        id: '777',
        title: '인사이동 안내',
        link: 'https://www.knue.ac.kr/cheongnam/777',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>단순 인사 동정</p>',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([noticeOnlyItem]);
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '',
        highlights: [],
        actionItems: [],
        links: [],
      });
      // LLM decides this is not an event → empty events array
      (generateEventInfos as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const stats = await run(mockEnv, [CHEONGNAM_FEED]);

      expect(stats.processed).toBe(1);
      expect(stats.created).toBe(0);
      expect(createEvent).not.toHaveBeenCalled();

      // State is marked so the item is not retried next run
      expect(putProcessedRecord).toHaveBeenCalledWith(
        expect.anything(),
        'bbs250',
        '777',
        expect.objectContaining({ feedId: 'bbs250' }),
      );

      vi.useRealTimers();
    });

    // Trace: AC-6 — a parse failure must not be mistaken for "no events"
    it('does not mark an item processed when the AI response fails to parse', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const unparseableItem: RssItem = {
        id: '201',
        title: '파싱 실패',
        link: 'https://www.knue.ac.kr/notice/201',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>AI 응답이 깨진 케이스</p>',
      };
      const goodItem: RssItem = {
        id: '202',
        title: '정상',
        link: 'https://www.knue.ac.kr/notice/202',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>정상 케이스</p>',
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([unparseableItem, goodItem]);
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '요약',
        highlights: [],
        actionItems: [],
        links: [],
      });
      (generateEventInfos as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, item: RssItem) => {
          if (item.id === '201') {
            throw new AiResponseParseError('Failed to parse event JSON');
          }
          return [
            {
              title: '행사',
              description: '',
              startDate: '2026-04-20',
              endDate: '2026-04-20',
            },
          ];
        },
      );
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt-202',
        htmlLink: 'https://calendar.example/evt-202',
      });

      const stats = await run(mockEnv, [NOTICE_FEED]);

      // The failed item gets no processed record, so the next run re-reads it.
      const recordedItemIds = (putProcessedRecord as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[2],
      );
      expect(recordedItemIds).not.toContain('201');

      // Trace: AC-6 — the rest of the feed still runs (Golden Principle 4).
      expect(recordedItemIds).toContain('202');
      expect(stats.created).toBe(1);

      // The watermark must stay below the failed id so the next run reaches it again,
      // even though the newer item 202 succeeded.
      expect(updateMaxProcessedId).toHaveBeenCalledWith(mockEnv, NOTICE_FEED.id, '200');

      vi.useRealTimers();
    });

    // Trace: AC-1/AC-2 — failure streaks persist across runs and give up after three failures.
    it('permanently skips an item after three consecutive failures and advances the watermark', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const failingItem: RssItem = {
        id: '201',
        title: '영구 실패',
        link: 'https://www.knue.ac.kr/notice/201',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>계속 실패하는 케이스</p>',
      };
      const goodItem: RssItem = {
        id: '202',
        title: '정상',
        link: 'https://www.knue.ac.kr/notice/202',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>정상 케이스</p>',
      };
      const failureCounts = new Map<string, number>();
      let watermark = 0;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([failingItem, goodItem]);
      (getMaxProcessedId as ReturnType<typeof vi.fn>).mockImplementation(
        async () => watermark,
      );
      (getItemFailureCount as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, feedId: string, nttNo: string) =>
          failureCounts.get(`${feedId}:${nttNo}`) ?? 0,
      );
      (recordItemFailure as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, feedId: string, nttNo: string) => {
          const key = `${feedId}:${nttNo}`;
          const next = (failureCounts.get(key) ?? 0) + 1;
          failureCounts.set(key, next);
          return next;
        },
      );
      (clearItemFailureCount as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, feedId: string, nttNo: string) => {
          failureCounts.delete(`${feedId}:${nttNo}`);
        },
      );
      (updateMaxProcessedId as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, _feedId: string, id: string) => {
          watermark = Math.max(watermark, Number(id));
        },
      );
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '요약',
        highlights: [],
        actionItems: [],
        links: [],
      });
      (generateEventInfos as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, item: RssItem) => {
          if (item.id === failingItem.id) {
            throw new AiResponseParseError('Failed to parse event JSON');
          }
          return [
            {
              title: '행사',
              description: '',
              startDate: '2026-04-20',
              endDate: '2026-04-20',
            },
          ];
        },
      );
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt-202',
        htmlLink: 'https://calendar.example/evt-202',
      });

      await run(mockEnv, [NOTICE_FEED]);
      await run(mockEnv, [NOTICE_FEED]);
      await run(mockEnv, [NOTICE_FEED]);

      expect(failureCounts.get(`${NOTICE_FEED.id}:${failingItem.id}`)).toBe(3);
      expect(generateEventInfos).toHaveBeenCalledTimes(6);
      expect(updateMaxProcessedId).toHaveBeenLastCalledWith(mockEnv, NOTICE_FEED.id, '202');

      await run(mockEnv, [NOTICE_FEED]);

      expect(generateEventInfos).toHaveBeenCalledTimes(6);
      expect(watermark).toBe(202);

      vi.useRealTimers();
    });

    it('keeps transient processing failures retryable instead of giving up', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const transientFailureItem: RssItem = {
        id: '201',
        title: '일시 장애',
        link: 'https://www.knue.ac.kr/notice/201',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>일시적인 Ollama 장애</p>',
      };
      const goodItem: RssItem = {
        id: '202',
        title: '정상',
        link: 'https://www.knue.ac.kr/notice/202',
        pubDate: '2026-04-16',
        descriptionHtml: '<p>정상 케이스</p>',
      };
      let watermark = 0;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue([
        transientFailureItem,
        goodItem,
      ]);
      (getMaxProcessedId as ReturnType<typeof vi.fn>).mockImplementation(
        async () => watermark,
      );
      (updateMaxProcessedId as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, _feedId: string, id: string) => {
          watermark = Math.max(watermark, Number(id));
        },
      );
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '요약',
        highlights: [],
        actionItems: [],
        links: [],
      });
      (generateEventInfos as ReturnType<typeof vi.fn>).mockImplementation(
        async (_env: unknown, item: RssItem) => {
          if (item.id === transientFailureItem.id) {
            throw new Error('Ollama request failed');
          }
          return [
            {
              title: '행사',
              description: '',
              startDate: '2026-04-20',
              endDate: '2026-04-20',
            },
          ];
        },
      );
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt-202',
        htmlLink: 'https://calendar.example/evt-202',
      });

      await run(mockEnv, [NOTICE_FEED]);
      await run(mockEnv, [NOTICE_FEED]);
      await run(mockEnv, [NOTICE_FEED]);

      expect(recordItemFailure).not.toHaveBeenCalled();
      expect(updateMaxProcessedId).toHaveBeenLastCalledWith(mockEnv, NOTICE_FEED.id, '200');
      expect(watermark).toBe(200);

      vi.useRealTimers();
    });

    it('skips a numeric item that already has a processed record above the watermark', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const items: RssItem[] = [
        {
          id: '401',
          title: '이미 처리됨',
          link: 'https://www.knue.ac.kr/notice/401',
          pubDate: '2026-04-16',
          descriptionHtml: '<p>본문</p>',
        },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue(items);
      // maxProcessedId is capped below 401 by an earlier failure, so the id check does not
      // filter this item — only the processed-record lookup can.
      (getMaxProcessedId as ReturnType<typeof vi.fn>).mockResolvedValue(300);
      (getProcessedRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        eventId: 'evt-401',
        nttNo: '401',
        processedAt: '2026-04-16T00:00:00.000Z',
        hash: 'hash',
        feedId: NOTICE_FEED.id,
      });

      const stats = await run(mockEnv, [NOTICE_FEED]);

      // No AI enrichment, no calendar write, and the record is left untouched.
      expect(generateEventInfos).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
      expect(putProcessedRecord).not.toHaveBeenCalled();
      expect(stats).toEqual({ processed: 1, created: 0 });

      // An already-processed item still lets the watermark move forward.
      expect(updateMaxProcessedId).toHaveBeenCalledWith(mockEnv, NOTICE_FEED.id, '401');

      vi.useRealTimers();
    });

    it('advances the watermark to the newest success when nothing fails', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17'));

      const items: RssItem[] = [
        {
          id: '301',
          title: '정상 1',
          link: 'https://www.knue.ac.kr/notice/301',
          pubDate: '2026-04-16',
          descriptionHtml: '<p>본문</p>',
        },
        {
          id: '302',
          title: '정상 2',
          link: 'https://www.knue.ac.kr/notice/302',
          pubDate: '2026-04-16',
          descriptionHtml: '<p>본문</p>',
        },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<rss/>'),
      });
      (parseRss as ReturnType<typeof vi.fn>).mockReturnValue(items);
      (generateSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        summary: '요약',
        highlights: [],
        actionItems: [],
        links: [],
      });
      (generateEventInfos as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          title: '행사',
          description: '',
          startDate: '2026-04-20',
          endDate: '2026-04-20',
        },
      ]);
      (createEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'evt',
        htmlLink: 'https://calendar.example/evt',
      });

      await run(mockEnv, [NOTICE_FEED]);

      expect(updateMaxProcessedId).toHaveBeenCalledWith(mockEnv, NOTICE_FEED.id, '302');

      vi.useRealTimers();
    });
  });
});
