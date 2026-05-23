import type { CalendarEventInput, ProcessedRecord } from "../types.js";
import type { GoogleCalendarEvent } from "./calendar.js";
import { LEGACY_FEED_ID } from "./state.js";

export function normalizedLevenshtein(a: string, b: string): number {
  const source = a.trim().toLowerCase();
  const target = b.trim().toLowerCase();
  if (source === target) return 1;
  if (source.length === 0 || target.length === 0) return 0;
  const matrix: number[][] = Array.from({ length: source.length + 1 }, () => []);
  for (let i = 0; i <= source.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= target.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= source.length; i += 1) {
    for (let j = 1; j <= target.length; j += 1) {
      if (source[i - 1] === target[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1,
        );
      }
    }
  }

  const distance = matrix[source.length][target.length];
  const maxLength = Math.max(source.length, target.length);
  return 1 - distance / maxLength;
}

function normalizeText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Parse ISO 8601 datetime string to Date object
 * Handles format: YYYY-MM-DDTHH:MM:SS+09:00 or similar
 */
export function parseDateTime(isoString: string): Date {
  try {
    const date = new Date(isoString);
    // Check if the date is valid
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid datetime: ${isoString}`);
    }
    return date;
  } catch (error) {
    throw new Error(`Failed to parse datetime: ${isoString}`);
  }
}

/**
 * Extract time range from Google Calendar event
 * Returns {start, end} in Date objects, or null if all-day event
 */
export function getEventTimeRange(
  event: GoogleCalendarEvent,
): { start: Date; end: Date } | null {
  // All-day event: has date property
  if (event.start?.date) {
    return null;
  }

  // Timed event: has dateTime property
  if (!event.start?.dateTime || !event.end?.dateTime) {
    return null;
  }

  try {
    return {
      start: parseDateTime(event.start.dateTime),
      end: parseDateTime(event.end.dateTime),
    };
  } catch {
    return null;
  }
}

/**
 * Extract time range from candidate event input
 * Returns {start, end} in Date objects, or null if all-day event
 */
export function getInputTimeRange(
  input: CalendarEventInput,
  day: string,
): { start: Date; end: Date } | null {
  // All-day event: no startTime/endTime
  if (!input.startTime) {
    return null;
  }

  try {
    // Assume KST timezone
    const startStr = `${day}T${input.startTime}:00+09:00`;
    const endDate = input.endDate ?? day;
    const endStr = `${endDate}T${input.endTime ?? "23:59"}:00+09:00`;

    return {
      start: parseDateTime(startStr),
      end: parseDateTime(endStr),
    };
  } catch {
    return null;
  }
}

/**
 * Check if two time ranges overlap
 * Two ranges overlap if: range1.start < range2.end AND range2.start < range1.end
 */
export function timeRangesOverlap(
  range1: { start: Date; end: Date },
  range2: { start: Date; end: Date },
): boolean {
  return range1.start < range2.end && range2.start < range1.end;
}

export async function computeHash(input: {
  title: string;
  description: string;
  startDate: string;
}): Promise<string> {
  const payload = `${input.title}::${input.startDate}::${input.description}`;
  const buffer = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function isDuplicate(
  existing: GoogleCalendarEvent[],
  candidate: CalendarEventInput,
  options: { threshold: number; meta?: ProcessedRecord },
): Promise<boolean> {
  const normalizedTitle = normalizeText(candidate.title);
  const normalizedDescription = normalizeText(candidate.description);
  const day = candidate.startDate;
  const inputTimeRange = getInputTimeRange(candidate, day);

  for (const event of existing) {
    // 1. Check nttNo exact match (highest priority)
    // nttNo can collide across feeds; require feedId agreement when advertised.
    // Legacy events (pre-namespacing) have no feedId and implicitly belong to the legacy
    // feed, so they may only loose-match new items from that same legacy feed.
    if (options.meta?.nttNo && event.extendedProperties?.private?.nttNo === options.meta.nttNo) {
      const eventFeedId = event.extendedProperties?.private?.feedId;
      const metaFeedId = options.meta.feedId;
      if (eventFeedId && metaFeedId) {
        if (eventFeedId === metaFeedId) return true;
      } else if (metaFeedId === LEGACY_FEED_ID) {
        return true;
      }
    }

    // 2. Filter by date
    const eventDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10);
    if (eventDate !== day) continue;

    // 3. Check time range overlap (if both are timed events)
    const eventTimeRange = getEventTimeRange(event);

    if (eventTimeRange && inputTimeRange) {
      // Both are timed events: must have time overlap to be considered duplicate
      if (!timeRangesOverlap(eventTimeRange, inputTimeRange)) {
        continue; // No time overlap, not a duplicate
      }
    } else if (!eventTimeRange && !inputTimeRange) {
      // Both are all-day events on same date
      // Fall through to Levenshtein comparison
    } else {
      // One is timed, one is all-day: different types, continue to next event
      continue;
    }

    // 4. Compare title and description similarity
    const titleScore = normalizedLevenshtein(
      normalizedTitle,
      normalizeText(event.summary ?? ""),
    );
    const descScore = normalizedLevenshtein(
      normalizedDescription,
      normalizeText(event.description ?? ""),
    );
    const maxScore = Math.max(titleScore, descScore);
    if (maxScore >= options.threshold) {
      return true;
    }
  }
  return false;
}
