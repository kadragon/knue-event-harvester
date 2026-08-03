# Architecture

## Execution Model

Short-lived CLI process. Invoked by cron via `run.sh`:

```
cron → run.sh → git pull → (npm ci if lock changed) → npm run build → node dist/index.js
```

The process exits after one full harvest cycle. No persistent server, no daemon. Single-instance contract: concurrent invocations create duplicate Calendar events (cron must use `flock`).

## Data Flow

```
RSS feed (KNUE bulletin)
  │
  ▼
fetchRssFeed() + parseRss()         # src/lib/rss.ts
  │  items: [{nttNo, title, link, pubDate, content}]
  │
  ├──► obtainAccessToken()          # src/lib/calendar.ts  (parallel)
  ├──► listEvents()                 # src/lib/calendar.ts  (parallel)
  └──► getMaxProcessedId()          # src/lib/state.ts     (parallel)
  │
  ▼
Per-item loop (src/index.ts:381–467, errors caught per-item → continue)
  │
  ├── Early exit: nttNo ≤ maxProcessedId (already processed)
  ├── OCR via vision model (optional, if OLLAMA_VISION_MODEL set)
  ├── summariseContent() via Ollama  # src/lib/ai.ts
  ├── extractEvents()               # src/lib/ai.ts
  ├── splitLongEvent() (>3 days)    # src/lib/calendar.ts
  ├── isDuplicate() vs listEvents   # src/lib/calendar.ts
  ├── createEvent()                 # src/lib/calendar.ts
  ├── putProcessedRecord()          # src/lib/state.ts
  └── sendNotification()            # src/lib/telegram.ts
```

## Module Responsibilities

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Orchestration: env parsing, run() loop, error isolation per item |
| `src/lib/rss.ts` | RSS fetch, XML parse, U+FFFD sanitisation |
| `src/lib/ai.ts` | Ollama summarise + event extraction (content + vision models) |
| `src/lib/calendar.ts` | Google Calendar v3 REST: JWT signing (WebCrypto RSASSA-PKCS1-v1_5), event CRUD, dedup |
| `src/lib/state.ts` | SQLite state: processed_items tracking, meta KV store |
| `src/lib/telegram.ts` | Telegram Bot API notifications (fail-open: errors logged, not thrown) |
| `src/lib/preview.ts` | **Legacy / unused** — not wired into run(). Do not assume it executes. |

## Data Model

SQLite database at `$DATABASE_PATH` (default `./data/state.db`). WAL journal mode.

```sql
CREATE TABLE processed_items (
  ntt_no    TEXT PRIMARY KEY,
  event_id  TEXT,
  processed_at TEXT,
  hash      TEXT
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

The `meta` KV store also holds per-feed/item failure streaks under
`_item_failure_count:<feedId>:<nttNo>`. After three consecutive item-specific AI parse failures,
the item is permanently skipped and a numeric feed watermark may advance past it;
successful or already-processed handling clears the streak. Historical failures that
were already passed by a watermark are not recoverable from current state.

Schema evolution is **additive only** — no migration framework. `ALTER TABLE ... DROP COLUMN`, `DROP TABLE`, and `RENAME COLUMN` are forbidden (see Golden Principle 3). Breaking changes require wiping `data/state.db`.

## External Integrations

| Service | Auth model | Endpoint |
|---------|-----------|----------|
| Ollama | None (local) | `$OLLAMA_HOST/api/chat` |
| Google Calendar v3 | Service account JWT (`GOOGLE_SERVICE_ACCOUNT_JSON`) signed via WebCrypto; token cached per run | `https://www.googleapis.com/calendar/v3/` |
| Telegram Bot API | Bot token (`TELEGRAM_BOT_TOKEN`) | `https://api.telegram.org/bot{token}/sendMessage` |
| KNUE RSS | None | `https://www.knue.ac.kr/bbs/BBSMSTR_000000000333/rssList.do` |

## Artifacts to Ignore

- `.wrangler/` — leftover from the Cloudflare Workers era (PR #62 migrated away). Safe to delete if present.
- `src/lib/preview.ts` — built but not called. Tracked in backlog for cleanup or wiring.
- `dist/` — compiled output, not checked in.
