import type { RssItem, AiSummary, CalendarEventInput } from "../types.js";
import { deduplicateLinks } from "./utils.js";

const MAX_HIGHLIGHTS = 4;
const MAX_ACTION_ITEMS = 2;

export function normalizeDate(pubDate: string): string {
  if (!pubDate) {
    const today = new Date();
    return today.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(pubDate)) return pubDate;
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) {
    const today = new Date();
    return today.toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

export function isWithinLastWeek(pubDate: string): boolean {
  if (!pubDate) return true;
  try {
    const normalizedDate = normalizeDate(pubDate);
    const itemDate = new Date(normalizedDate);
    const today = new Date();
    itemDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const diffDays = (today.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays <= 7 && diffDays >= -30;
  } catch (error) {
    console.warn("Failed to parse pubDate for filtering:", pubDate, error);
    // fail-open: include the item rather than silently dropping it on a parse error
    return true;
  }
}

export function buildDescription(item: RssItem, summary: AiSummary): string {
  const parts: string[] = [];
  parts.push(summary.summary);
  const limitedHighlights = summary.highlights.slice(0, MAX_HIGHLIGHTS);
  if (limitedHighlights.length > 0) {
    parts.push("주요 포인트:\n" + limitedHighlights.map((line) => `- ${line}`).join("\n"));
  }
  const limitedActions = summary.actionItems.slice(0, MAX_ACTION_ITEMS);
  if (limitedActions.length > 0) {
    parts.push("확인/신청 사항:\n" + limitedActions.map((line) => `- ${line}`).join("\n"));
  }
  if (summary.links.length > 0 || item.link) {
    const uniqueLinks = deduplicateLinks(item.link, summary.links);
    parts.push("관련 링크:\n" + uniqueLinks.map((link) => `- ${link}`).join("\n"));
  }
  return parts.join("\n\n");
}

export function formatDateForDisplay(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`formatDateForDisplay: expected YYYY-MM-DD, got "${date}"`);
  }
  const currentYear = new Date().getFullYear();
  const dateYear = parseInt(date.substring(0, 4), 10);
  return dateYear === currentYear ? date.substring(5) : date;
}

export function calculateDaysDuration(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays + 1;
}

export function splitLongEvent(eventInput: CalendarEventInput): CalendarEventInput[] {
  const duration = calculateDaysDuration(eventInput.startDate, eventInput.endDate);
  if (duration <= 3) return [eventInput];

  const formattedStartDate = formatDateForDisplay(eventInput.startDate);
  const formattedEndDate = formatDateForDisplay(eventInput.endDate);

  const startEvent: CalendarEventInput = {
    ...eventInput,
    title: `${eventInput.title} (~${formattedEndDate})`,
    endDate: eventInput.startDate,
    startTime: eventInput.startTime,
    endTime: eventInput.endTime,
  };

  const endEvent: CalendarEventInput = {
    ...eventInput,
    title: `${eventInput.title} (${formattedStartDate}~)`,
    startDate: eventInput.endDate,
    startTime: eventInput.startTime,
    endTime: eventInput.endTime,
  };

  return [startEvent, endEvent];
}
