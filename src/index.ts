import { extractTextFromImage, generateEventInfos, generateSummary, type AiEnv } from "./lib/ai.js";
import {
  obtainAccessToken,
  listEvents,
  createEvent,
  type CalendarEnv,
  type GoogleCalendarEvent,
} from "./lib/calendar.js";
import { isDuplicate, computeHash } from "./lib/dedupe.js";
import { sendNotification } from "./lib/telegram.js";
import { parseRss } from "./lib/rss.js";
import {
  getProcessedRecord,
  putProcessedRecord,
  getMaxProcessedId,
  updateMaxProcessedId,
  openDatabase,
  LEGACY_FEED_ID,
  type StateEnv,
} from "./lib/state.js";
import { isWithinLastWeek, buildDescription, splitLongEvent } from "./lib/transforms.js";
import type {
  CalendarEventInput,
  FeedSource,
  ProcessedRecord,
  RssItem,
  PreviewContent,
} from "./types.js";
import { buildAttachmentFromFile, getFileType } from "./lib/utils.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

interface Env extends StateEnv, CalendarEnv, AiEnv {
  SIMILARITY_THRESHOLD?: string;
  LOOKBACK_DAYS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_USER_ID?: string;
}

export const FEEDS: readonly FeedSource[] = [
  {
    id: LEGACY_FEED_ID,
    url: "https://www.knue.ac.kr/rssBbsNtt.do?bbsNo=28",
    label: "행사세미나",
  },
];

function buildCalendarEventUrl(eventId: string, calendarId: string): string {
  const eidRaw = `${eventId} ${calendarId}`;
  const eidEncoded = btoa(eidRaw)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `https://calendar.google.com/calendar/u/0/r/event?eid=${eidEncoded}`;
}

async function fetchRssFeed(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "knue-event-harvester/1.0" },
  });
  if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
  return response.text();
}

async function fetchImageAsBase64(url: string): Promise<PreviewContent | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Image fetch failed (${response.status}): ${url}`);
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const buffer = await response.arrayBuffer();
    const imageBase64 = Buffer.from(buffer).toString("base64");
    return { sourceType: "image", imageBase64, contentType };
  } catch (error) {
    console.warn("Failed to fetch image", url, error);
    return null;
  }
}

// Stage 1: Enrich item with OCR + AI outputs.
// I/O: image fetch, Ollama calls. Returns fully described event inputs.
async function enrichItem(
  env: Env,
  item: RssItem,
): Promise<{ eventInputs: CalendarEventInput[] }> {
  let previewText: string | undefined;
  if (item.attachment?.url && getFileType(item.attachment.filename) === "image") {
    const imageContent = await fetchImageAsBase64(item.attachment.url);
    if (imageContent) {
      previewText = await extractTextFromImage(env, imageContent);
      if (previewText) {
        console.log(`OCR extracted ${previewText.length} chars from image for item ${item.id}`);
      }
    }
  }

  const [summary, rawInputs] = await Promise.all([
    generateSummary(env, {
      title: item.title,
      description: item.descriptionHtml,
      previewText,
      attachmentText: item.attachment?.filename
        ? `첨부파일: ${item.attachment.filename}`
        : undefined,
      link: item.link,
      pubDate: item.pubDate,
    }),
    generateEventInfos(env, item, previewText),
  ]);

  const description = buildDescription(item, summary);
  const eventInputs = rawInputs.map((raw) => {
    const withEndTime = raw.startTime && !raw.endTime ? { ...raw, endTime: raw.startTime } : raw;
    return { ...withEndTime, description };
  });

  return { eventInputs };
}

type PreparedEvent = {
  input: CalendarEventInput;
  hash: string;
  meta: ProcessedRecord;
};

// Stage 2: Validate one event group (original + splits) against existing events.
// No external I/O — only crypto.subtle and in-memory comparison.
async function validateEventGroup(
  eventInput: CalendarEventInput,
  existingEvents: GoogleCalendarEvent[],
  feedId: string,
  itemId: string,
  threshold: number,
): Promise<{ kind: "duplicate"; skipHash: string } | { kind: "novel"; prepared: PreparedEvent[] }> {
  const eventsToCreate = splitLongEvent(eventInput);
  const prepared: PreparedEvent[] = [];

  for (const splitEvent of eventsToCreate) {
    const hash = await computeHash(splitEvent);
    const meta: ProcessedRecord = {
      eventId: "",
      nttNo: itemId,
      processedAt: new Date().toISOString(),
      hash,
      feedId,
    };

    if (await isDuplicate(existingEvents, splitEvent, { threshold, meta })) {
      console.log(`Duplicate detected for ${itemId} event: ${splitEvent.title}`);
      return { kind: "duplicate", skipHash: prepared[0]?.hash ?? hash };
    }

    prepared.push({ input: splitEvent, hash, meta });
  }

  return { kind: "novel", prepared };
}

export async function processNewItem(
  env: Env,
  feedId: string,
  item: RssItem,
  accessToken: string,
  existingEvents: GoogleCalendarEvent[],
  similarityThreshold: number,
): Promise<GoogleCalendarEvent[]> {
  const { eventInputs } = await enrichItem(env, item);
  const createdEvents: GoogleCalendarEvent[] = [];
  const attachments = buildAttachmentFromFile(item);

  for (const eventInput of eventInputs) {
    const result = await validateEventGroup(
      eventInput, existingEvents, feedId, item.id, similarityThreshold,
    );

    if (result.kind === "duplicate") {
      await putProcessedRecord(env, feedId, item.id, {
        eventId: "duplicate-skip",
        nttNo: item.id,
        processedAt: new Date().toISOString(),
        hash: result.skipHash,
        feedId,
      });
      continue;
    }

    // Create all events in the group (none are duplicates)
    const newlyCreated: GoogleCalendarEvent[] = [];
    for (const prepared of result.prepared) {
      const created = await createEvent(
        env, accessToken, prepared.input, prepared.meta,
        { summaryHash: prepared.hash, feedId },
        attachments ? [attachments] : undefined,
      );
      newlyCreated.push(created);
    }

    // Commit state and notify after all events in group are created
    for (let i = 0; i < newlyCreated.length; i++) {
      const created = newlyCreated[i];
      const prepared = result.prepared[i];
      await putProcessedRecord(env, feedId, item.id, {
        ...prepared.meta,
        eventId: created.id,
      });
      existingEvents.push(created);
      createdEvents.push(created);
      const calendarUrl = created.htmlLink ?? buildCalendarEventUrl(created.id, env.GOOGLE_CALENDAR_ID);
      await sendNotification(
        { eventTitle: prepared.input.title, rssUrl: item.link, eventUrl: calendarUrl },
        env,
      );
    }
  }

  if (eventInputs.length === 0) {
    console.log(
      `No meaningful events extracted for item ${item.id} (feed=${feedId}), marking as processed`,
    );
    await putProcessedRecord(env, feedId, item.id, {
      eventId: "",
      nttNo: item.id,
      processedAt: new Date().toISOString(),
      hash: "",
      feedId,
    });
  }

  return createdEvents;
}

export async function run(
  env: Env,
  feeds: readonly FeedSource[] = FEEDS,
): Promise<{ processed: number; created: number }> {
  const accessToken = await obtainAccessToken(env);
  const lookbackDays = Number.parseInt(env.LOOKBACK_DAYS ?? "60", 10);
  const now = new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const [existing, similarityThreshold] = await Promise.all([
    listEvents(env, accessToken, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    }),
    Promise.resolve(Number.parseFloat(env.SIMILARITY_THRESHOLD ?? "0.85")),
  ]);

  let totalProcessed = 0;
  let totalCreated = 0;

  for (const feed of feeds) {
    try {
      const stats = await runFeed(env, feed, accessToken, existing, similarityThreshold);
      totalProcessed += stats.processed;
      totalCreated += stats.created;
    } catch (error) {
      console.error(`Failed to process feed ${feed.id} (${feed.url})`, error);
    }
  }

  return { processed: totalProcessed, created: totalCreated };
}

async function runFeed(
  env: Env,
  feed: FeedSource,
  accessToken: string,
  existing: GoogleCalendarEvent[],
  similarityThreshold: number,
): Promise<{ processed: number; created: number }> {
  const rssXml = await fetchRssFeed(feed.url);
  const items = parseRss(rssXml);
  const maxProcessedId = await getMaxProcessedId(env, feed.id);

  let processed = 0;
  let created = 0;
  const skippedItems: string[] = [];
  const alreadyProcessedItems: string[] = [];
  let maxSuccessfulId = 0;

  for (const item of items) {
    const itemId = Number.parseInt(item.id, 10);
    if (!Number.isNaN(itemId) && itemId <= maxProcessedId) {
      alreadyProcessedItems.push(item.id);
      processed += 1;
      break;
    }

    if (!isWithinLastWeek(item.pubDate)) {
      skippedItems.push(`Item ${item.id} - pubDate ${item.pubDate}`);
      continue;
    }

    if (Number.isNaN(itemId)) {
      const already = await getProcessedRecord(env, feed.id, item.id);
      if (already) {
        alreadyProcessedItems.push(item.id);
        processed += 1;
        continue;
      }
    }

    try {
      const results = await processNewItem(
        env, feed.id, item, accessToken, existing, similarityThreshold,
      );
      processed += 1;
      created += results.length;
      if (!Number.isNaN(itemId) && itemId > maxSuccessfulId) {
        maxSuccessfulId = itemId;
      }
    } catch (error) {
      console.error(`Failed to process item ${item.id} (feed=${feed.id})`, error);
    }
  }

  if (maxSuccessfulId > 0) {
    await updateMaxProcessedId(env, feed.id, maxSuccessfulId.toString());
  }

  if (skippedItems.length > 0) {
    console.log(
      `[${feed.id}] Skipped ${skippedItems.length} items (older than 1 week):\n${skippedItems.join("\n")}`,
    );
  }

  if (alreadyProcessedItems.length > 0) {
    console.log(
      `[${feed.id}] Already processed ${alreadyProcessedItems.length} items (max_id: ${maxProcessedId})`,
    );
  }

  return { processed, created };
}

async function main() {
  const { config } = await import("dotenv");
  config();

  const dbPath = process.env.DATABASE_PATH ?? (() => {
    const defaultPath = new URL("../data/state.db", import.meta.url).pathname;
    console.warn(`DATABASE_PATH not set, using default: ${defaultPath}`);
    return defaultPath;
  })();
  const db = openDatabase(dbPath);

  const env: Env = {
    db,
    OLLAMA_HOST: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    OLLAMA_CONTENT_MODEL: process.env.OLLAMA_CONTENT_MODEL ?? "llama3.1:8b",
    OLLAMA_VISION_MODEL: process.env.OLLAMA_VISION_MODEL,
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID ?? "",
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
    SIMILARITY_THRESHOLD: process.env.SIMILARITY_THRESHOLD,
    LOOKBACK_DAYS: process.env.LOOKBACK_DAYS,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_USER_ID: process.env.TELEGRAM_USER_ID,
  };

  try {
    const stats = await run(env);
    console.log("Run complete", stats);
  } finally {
    db.close();
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    console.warn("isMain: unexpected error resolving argv[1]:", err);
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
