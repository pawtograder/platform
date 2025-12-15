import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";

// Types
interface ICSEvent {
  uid: string;
  summary: string;
  description?: string;
  dtstart: Date;
  dtend: Date;
  location?: string;
  rrule?: string;
  exdates?: Date[];
  recurrenceId?: Date;
}

interface ParsedEvent {
  uid: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  location?: string;
  queue_name?: string;
  organizer_name?: string;
  raw_ics_data: Record<string, string>;
}

interface ClassWithCalendar {
  id: number;
  office_hours_ics_url: string | null;
  events_ics_url: string | null;
  discord_server_id: string | null;
  time_zone: string;
}

interface CalendarEvent {
  id: number;
  class_id: number;
  calendar_type: string;
  uid: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  queue_name: string | null;
  organizer_name: string | null;
  start_announced_at: string | null;
  end_announced_at: string | null;
  change_announced_at: string | null;
}

// Parse event title to extract name and queue
// Format: "Jonathan Bell (Queue1)" or "Jonathan Bell"
function parseEventTitle(title: string): { name: string; queue?: string } {
  const match = title.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (match) return { name: match[1].trim(), queue: match[2].trim() };
  return { name: title.trim() };
}

// Check if a UID represents a recurring occurrence (has _YYYYMMDDTHHMMSS suffix)
function isRecurringOccurrence(uid: string): boolean {
  return /_\d{8}T\d{6}$/.test(uid);
}

// Extract base UID from an occurrence UID
function getBaseUid(uid: string): string {
  if (isRecurringOccurrence(uid)) {
    return uid.replace(/_\d{8}T\d{6}$/, "");
  }
  return uid;
}

// Group events by their base UID (recurring events share the same base)
function groupEventsByBaseUid<T extends { uid: string }>(events: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const event of events) {
    const baseUid = getBaseUid(event.uid);
    const group = groups.get(baseUid) || [];
    group.push(event);
    groups.set(baseUid, group);
  }
  return groups;
}

// Generate human-readable description of a recurring series
function describeRecurringSeries(events: ParsedEvent[]): string {
  if (events.length === 0) return "";
  if (events.length === 1) {
    // Single event - just show the date
    const start = new Date(events[0].start_time);
    const end = new Date(events[0].end_time);
    return formatSingleEventDescription(start, end);
  }

  // Sort events by start time
  const sorted = [...events].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  // Analyze the pattern
  const firstEvent = sorted[0];
  const lastEvent = sorted[sorted.length - 1];
  const firstStart = new Date(firstEvent.start_time);
  const lastStart = new Date(lastEvent.start_time);
  const firstEnd = new Date(firstEvent.end_time);

  // Get time of day
  const timeStr = formatTimeRange(firstStart, firstEnd);

  // Detect day pattern
  const dayPattern = detectDayPattern(sorted);

  // Date range
  const startDateStr = firstStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endDateStr = lastStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return `${dayPattern} ${timeStr} (${startDateStr} - ${endDateStr}, ${events.length} sessions)`;
}

// Format time range like "10:00 AM - 12:00 PM"
function formatTimeRange(start: Date, end: Date): string {
  const startTime = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const endTime = end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${startTime} - ${endTime}`;
}

// Format single event description
function formatSingleEventDescription(start: Date, end: Date): string {
  const dateStr = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const timeStr = formatTimeRange(start, end);
  return `${dateStr} ${timeStr}`;
}

// Detect day pattern from a series of events
function detectDayPattern(events: ParsedEvent[]): string {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fullDayNames = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

  // Count occurrences by day of week
  const dayCounts = new Map<number, number>();
  for (const event of events) {
    const day = new Date(event.start_time).getDay();
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }

  // Find days that appear more than once
  const recurringDays = Array.from(dayCounts.entries())
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0])
    .sort((a, b) => a - b);

  if (recurringDays.length === 0) {
    // No clear pattern - just say how many sessions
    return "Multiple sessions";
  }

  if (recurringDays.length === 1) {
    return `Every ${fullDayNames[recurringDays[0]]}`;
  }

  if (recurringDays.length === 5 && !recurringDays.includes(0) && !recurringDays.includes(6)) {
    return "Weekdays";
  }

  // List the days
  const dayList = recurringDays.map((d) => dayNames[d]).join(", ");
  return `Every ${dayList}`;
}

// Simple hash function for content comparison
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// Helper function to convert a date/time in a specific timezone to UTC
function convertToUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string
): Date {
  // Create an ISO string for the date/time (without timezone)
  const isoStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;

  try {
    // Strategy: We'll create a date string that represents this time in the target timezone,
    // then use Intl to convert it to UTC.
    //
    // The trick: Create a date representing midnight UTC on the target date,
    // then format it in the target timezone to see what time it shows.
    // Then calculate the offset needed to make it show our desired time.

    // Step 1: Create a reference UTC date (midnight UTC on the target date)
    const referenceUTC = new Date(
      `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`
    );

    // Step 2: Format this UTC date in the target timezone to see what time it represents there
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

    const parts = formatter.formatToParts(referenceUTC);
    const tzYear = parseInt(parts.find((p) => p.type === "year")!.value);
    const tzMonth = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
    const tzDay = parseInt(parts.find((p) => p.type === "day")!.value);
    const tzHour = parseInt(parts.find((p) => p.type === "hour")!.value);
    const tzMinute = parseInt(parts.find((p) => p.type === "minute")!.value);
    const tzSecond = parseInt(parts.find((p) => p.type === "second")!.value);

    // Step 3: Calculate how many milliseconds from referenceUTC to get to our target time
    // We want: year/month/day hour:minute:second in the timezone
    // referenceUTC shows: tzYear/tzMonth/tzDay tzHour:tzMinute:tzSecond in the timezone

    // Create dates representing both times (as if they were local)
    const targetTime = new Date(year, month, day, hour, minute, second).getTime();
    const referenceTimeInTz = new Date(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond).getTime();

    // The difference tells us how much to adjust referenceUTC
    const offsetMs = targetTime - referenceTimeInTz;

    // Step 4: Apply the offset to get the correct UTC time
    return new Date(referenceUTC.getTime() + offsetMs);
  } catch (e) {
    // Fallback: treat as local time (not ideal, but better than crashing)
    console.warn(`[convertToUTC] Failed to convert timezone ${timezone} for ${isoStr}, using local time:`, e);
    return new Date(year, month, day, hour, minute, second);
  }
}

// Parse ICS date formats with timezone support
// Accepts the full ICS line (e.g., "DTSTART;TZID=America/New_York:20241210T100000")
// or just the value portion, along with a default timezone
function parseICSDate(icsLine: string, defaultTimezone: string = "UTC"): Date {
  // Extract TZID parameter if present (e.g., "DTSTART;TZID=America/New_York:20241210T100000")
  let timezone = defaultTimezone;
  let dateValue: string;

  const colonIndex = icsLine.indexOf(":");
  if (colonIndex > 0) {
    const prefix = icsLine.slice(0, colonIndex);
    dateValue = icsLine.slice(colonIndex + 1);

    // Check for TZID parameter in the prefix
    const tzidMatch = prefix.match(/TZID=([^;:]+)/i);
    if (tzidMatch) {
      timezone = tzidMatch[1];
    }
  } else {
    // No colon, assume it's just the date value
    dateValue = icsLine;
  }

  // Handle UTC format (ends with Z)
  if (dateValue.endsWith("Z")) {
    timezone = "UTC";
    dateValue = dateValue.slice(0, -1);
  }

  // Handle basic format: 20241210T100000
  if (dateValue.length === 15) {
    const year = parseInt(dateValue.slice(0, 4));
    const month = parseInt(dateValue.slice(4, 6)) - 1;
    const day = parseInt(dateValue.slice(6, 8));
    const hour = parseInt(dateValue.slice(9, 11));
    const minute = parseInt(dateValue.slice(11, 13));
    const second = parseInt(dateValue.slice(13, 15));

    // If UTC, use Date.UTC
    if (timezone === "UTC") {
      return new Date(Date.UTC(year, month, day, hour, minute, second));
    }

    // Convert from the specified timezone to UTC
    return convertToUTC(year, month, day, hour, minute, second, timezone);
  }

  // Handle date-only format: 20241210
  if (dateValue.length === 8) {
    const year = parseInt(dateValue.slice(0, 4));
    const month = parseInt(dateValue.slice(4, 6)) - 1;
    const day = parseInt(dateValue.slice(6, 8));
    // For date-only, create at midnight in the specified timezone
    if (timezone === "UTC") {
      return new Date(Date.UTC(year, month, day));
    }
    return convertToUTC(year, month, day, 0, 0, 0, timezone);
  }

  // Fallback to Date parsing
  return new Date(dateValue);
}

// Parse RRULE into components
interface RRuleComponents {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: Date;
  byday?: string[];
  bymonth?: number[];
  bymonthday?: number[];
}

function parseRRule(rrule: string, defaultTimezone: string = "UTC"): RRuleComponents | null {
  const parts = rrule.split(";");
  const result: Partial<RRuleComponents> = { interval: 1 };

  for (const part of parts) {
    const [key, value] = part.split("=");
    switch (key) {
      case "FREQ":
        if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(value)) {
          result.freq = value as RRuleComponents["freq"];
        }
        break;
      case "INTERVAL":
        result.interval = parseInt(value) || 1;
        break;
      case "COUNT":
        result.count = parseInt(value);
        break;
      case "UNTIL":
        result.until = parseICSDate(value, defaultTimezone);
        break;
      case "BYDAY":
        result.byday = value.split(",");
        break;
      case "BYMONTH":
        result.bymonth = value.split(",").map((m) => parseInt(m));
        break;
      case "BYMONTHDAY":
        result.bymonthday = value.split(",").map((d) => parseInt(d));
        break;
    }
  }

  if (!result.freq) return null;
  return result as RRuleComponents;
}

// Day name to day number mapping (Sunday = 0)
const dayMap: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
};

// Expand recurring event into individual occurrences
function expandRecurringEvent(event: ICSEvent, maxDate: Date, defaultTimezone: string = "UTC"): ICSEvent[] {
  if (!event.rrule) {
    return [event];
  }

  const rrule = parseRRule(event.rrule, defaultTimezone);
  if (!rrule) {
    console.log(`[expandRecurringEvent] Failed to parse RRULE: ${event.rrule}`);
    return [event];
  }

  const occurrences: ICSEvent[] = [];
  const duration = event.dtend.getTime() - event.dtstart.getTime();
  const exdateSet = new Set(event.exdates?.map((d) => d.toISOString().split("T")[0]) || []);

  // Limit expansion: max 1 year ahead or 500 occurrences
  const maxOccurrences = Math.min(rrule.count || 500, 500);
  const effectiveUntil = rrule.until ? new Date(Math.min(rrule.until.getTime(), maxDate.getTime())) : maxDate;

  const currentDate = new Date(event.dtstart);
  let occurrenceCount = 0;

  // Generate a unique occurrence UID
  const makeOccurrenceUid = (baseUid: string, date: Date): string => {
    const dateStr = date.toISOString().replace(/[-:]/g, "").split(".")[0];
    return `${baseUid}_${dateStr}`;
  };

  while (currentDate <= effectiveUntil && occurrenceCount < maxOccurrences) {
    const dateKey = currentDate.toISOString().split("T")[0];

    // Check if this date should be included
    let includeDate = !exdateSet.has(dateKey);

    // For WEEKLY with BYDAY, check if current day matches
    if (includeDate && rrule.freq === "WEEKLY" && rrule.byday) {
      const dayOfWeek = currentDate.getUTCDay();
      // Find the day name(s) for the current day of week
      const dayNames = Object.entries(dayMap)
        .filter((entry) => entry[1] === dayOfWeek)
        .map((entry) => entry[0]);
      includeDate = rrule.byday.some((day) => {
        // Handle formats like "1MO" (first Monday) or just "MO"
        const dayPart = day.replace(/^-?\d+/, "");
        return dayNames.includes(dayPart);
      });
    }

    // For MONTHLY with BYMONTHDAY, check if day matches
    if (includeDate && rrule.freq === "MONTHLY" && rrule.bymonthday) {
      includeDate = rrule.bymonthday.includes(currentDate.getUTCDate());
    }

    if (includeDate) {
      const occurrenceStart = new Date(currentDate);
      const occurrenceEnd = new Date(occurrenceStart.getTime() + duration);

      occurrences.push({
        uid: makeOccurrenceUid(event.uid, occurrenceStart),
        summary: event.summary,
        description: event.description,
        dtstart: occurrenceStart,
        dtend: occurrenceEnd,
        location: event.location
        // Don't include rrule in expanded occurrences
      });
      occurrenceCount++;
    }

    // Move to next potential occurrence (using UTC operations to avoid DST drift)
    switch (rrule.freq) {
      case "DAILY":
        // Add days using UTC epoch milliseconds to avoid DST issues
        currentDate.setTime(currentDate.getTime() + rrule.interval * 24 * 60 * 60 * 1000);
        break;
      case "WEEKLY":
        if (rrule.byday && rrule.byday.length > 1) {
          // For multi-day weekly rules, advance by 1 day using UTC epoch milliseconds
          currentDate.setTime(currentDate.getTime() + 24 * 60 * 60 * 1000);
          // If we've passed a week boundary, skip to maintain interval
          const weeksPassed = Math.floor((currentDate.getTime() - event.dtstart.getTime()) / (7 * 24 * 60 * 60 * 1000));
          if (weeksPassed > 0 && weeksPassed % rrule.interval !== 0) {
            // Skip to the next valid week using UTC epoch milliseconds
            const daysToSkip = (rrule.interval - (weeksPassed % rrule.interval)) * 7;
            currentDate.setTime(currentDate.getTime() + (daysToSkip - 1) * 24 * 60 * 60 * 1000);
          }
        } else {
          // Add weeks using UTC epoch milliseconds
          currentDate.setTime(currentDate.getTime() + 7 * rrule.interval * 24 * 60 * 60 * 1000);
        }
        break;
      case "MONTHLY":
        currentDate.setUTCMonth(currentDate.getUTCMonth() + rrule.interval);
        break;
      case "YEARLY":
        currentDate.setUTCFullYear(currentDate.getUTCFullYear() + rrule.interval);
        break;
    }
  }

  console.log(`[expandRecurringEvent] Expanded ${event.uid} (${rrule.freq}) into ${occurrences.length} occurrences`);
  return occurrences;
}

// Parse ICS content into events
function parseICS(icsContent: string, expandUntil: Date, defaultTimezone: string = "UTC"): ICSEvent[] {
  const rawEvents: ICSEvent[] = [];
  const lines = icsContent
    .replace(/\r\n /g, "")
    .replace(/\r\n\t/g, "")
    .split(/\r?\n/);

  let currentEvent: (Partial<ICSEvent> & { rawData: Record<string, string>; exdatesRaw?: string[] }) | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      currentEvent = { rawData: {}, exdatesRaw: [] };
    } else if (line === "END:VEVENT" && currentEvent) {
      if (currentEvent.uid && currentEvent.summary && currentEvent.dtstart && currentEvent.dtend) {
        // Parse EXDATE values - pass full line to preserve TZID
        const exdates = currentEvent.exdatesRaw?.map((ex) => parseICSDate(ex, defaultTimezone)) || [];

        rawEvents.push({
          uid: currentEvent.uid,
          summary: currentEvent.summary,
          description: currentEvent.description,
          dtstart: currentEvent.dtstart,
          dtend: currentEvent.dtend,
          location: currentEvent.location,
          rrule: currentEvent.rrule,
          exdates: exdates.length > 0 ? exdates : undefined,
          recurrenceId: currentEvent.recurrenceId
        });
      }
      currentEvent = null;
    } else if (currentEvent) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        let key = line.slice(0, colonIndex);
        const value = line.slice(colonIndex + 1);

        // Handle parameters like DTSTART;TZID=America/New_York
        const semicolonIndex = key.indexOf(";");
        if (semicolonIndex > 0) {
          key = key.slice(0, semicolonIndex);
        }

        currentEvent.rawData[key] = value;

        switch (key) {
          case "UID":
            currentEvent.uid = value;
            break;
          case "SUMMARY":
            currentEvent.summary = value.replace(/\\,/g, ",").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
            break;
          case "DESCRIPTION":
            currentEvent.description = value.replace(/\\,/g, ",").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
            break;
          case "DTSTART":
            // Pass the full line to preserve TZID parameter
            currentEvent.dtstart = parseICSDate(line, defaultTimezone);
            break;
          case "DTEND":
            // Pass the full line to preserve TZID parameter
            currentEvent.dtend = parseICSDate(line, defaultTimezone);
            break;
          case "LOCATION":
            currentEvent.location = value.replace(/\\,/g, ",").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
            break;
          case "RRULE":
            currentEvent.rrule = value;
            break;
          case "EXDATE":
            // EXDATE can have multiple values separated by commas
            // TZID is in the prefix (before colon), values are after colon
            // Store the full line so parseICSDate can extract TZID for each value
            const exdatePrefix = line.slice(0, line.indexOf(":"));
            const exdateLine = line.slice(line.indexOf(":") + 1);
            const exdateValues = exdateLine.split(",");
            // Prepend prefix to each value so TZID is preserved
            const exdateWithPrefix = exdateValues.map((val) => `${exdatePrefix}:${val}`);
            currentEvent.exdatesRaw = [...(currentEvent.exdatesRaw || []), ...exdateWithPrefix];
            break;
          case "RECURRENCE-ID":
            // Pass the full line to preserve TZID parameter
            currentEvent.recurrenceId = parseICSDate(line, defaultTimezone);
            break;
        }
      }
    }
  }

  // Expand recurring events into individual occurrences
  const expandedEvents: ICSEvent[] = [];
  for (const event of rawEvents) {
    if (event.recurrenceId) {
      // This is a modified occurrence - it will replace the generated one
      expandedEvents.push(event);
    } else {
      expandedEvents.push(...expandRecurringEvent(event, expandUntil, defaultTimezone));
    }
  }

  // Handle modified occurrences (RECURRENCE-ID overrides generated occurrences)
  // Modified occurrences share the base UID but have RECURRENCE-ID set
  const modifiedOccurrences = expandedEvents.filter((e) => e.recurrenceId);
  if (modifiedOccurrences.length > 0) {
    const modifiedDates = new Map<string, ICSEvent>();
    for (const mod of modifiedOccurrences) {
      const baseUid = mod.uid;
      const dateKey = mod.recurrenceId!.toISOString().split("T")[0];
      modifiedDates.set(`${baseUid}_${dateKey}`, mod);
    }

    // Replace or remove generated occurrences that have been modified
    return expandedEvents.filter((event) => {
      if (event.recurrenceId) return true; // Keep modified occurrences
      const dateKey = event.dtstart.toISOString().split("T")[0];
      // Check if this generated occurrence should be replaced by a modified one
      // The modified occurrence has the original UID, our generated has UID_datetime
      const originalUid = getBaseUid(event.uid);
      const modKey = `${originalUid}_${dateKey}`;
      return !modifiedDates.has(modKey);
    });
  }

  return expandedEvents;
}

// Convert ICS event to ParsedEvent
function convertToCalendarEvent(event: ICSEvent): ParsedEvent {
  const { name, queue } = parseEventTitle(event.summary);

  return {
    uid: event.uid,
    title: event.summary,
    description: event.description,
    start_time: event.dtstart.toISOString(),
    end_time: event.dtend.toISOString(),
    location: event.location,
    queue_name: queue,
    organizer_name: name,
    raw_ics_data: {
      uid: event.uid,
      summary: event.summary,
      dtstart: event.dtstart.toISOString(),
      dtend: event.dtend.toISOString()
    }
  };
}

// Fetch ICS content from URL
async function fetchICS(
  url: string,
  lastEtag?: string
): Promise<{ content: string | null; etag: string | null; unchanged: boolean }> {
  try {
    const headers: HeadersInit = {
      "User-Agent": "Pawtograder-Calendar-Sync/1.0"
    };

    if (lastEtag) {
      headers["If-None-Match"] = lastEtag;
    }

    const response = await fetch(url, { headers });

    if (response.status === 304) {
      return { content: null, etag: lastEtag || null, unchanged: true };
    }

    if (!response.ok) {
      console.error(`Failed to fetch ICS from ${url}: ${response.status} ${response.statusText}`);
      return { content: null, etag: null, unchanged: false };
    }

    const content = await response.text();
    const etag = response.headers.get("ETag");

    return { content, etag, unchanged: false };
  } catch (error) {
    console.error(`Error fetching ICS from ${url}:`, error);
    return { content: null, etag: null, unchanged: false };
  }
}

// Sync calendar for a specific class and calendar type
async function syncCalendar(
  supabase: SupabaseClient<Database>,
  classData: ClassWithCalendar,
  calendarType: "office_hours" | "events",
  icsUrl: string,
  scope: Sentry.Scope
): Promise<void> {
  console.log(`[syncCalendar] Syncing ${calendarType} for class ${classData.id}`);

  // Get current sync state
  const { data: syncState } = await supabase
    .from("calendar_sync_state")
    .select("*")
    .eq("class_id", classData.id)
    .eq("calendar_type", calendarType)
    .single();

  // Fetch ICS content
  const { content, etag, unchanged } = await fetchICS(icsUrl, syncState?.last_etag || undefined);

  if (unchanged) {
    console.log(`[syncCalendar] Content unchanged for ${calendarType} class ${classData.id}`);
    return;
  }

  if (!content) {
    // Update sync state with error
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        sync_error: "Failed to fetch ICS content"
      },
      { onConflict: "class_id,calendar_type" }
    );
    return;
  }

  // Check content hash
  const contentHash = simpleHash(content);
  if (syncState?.last_hash === contentHash) {
    console.log(`[syncCalendar] Content hash unchanged for ${calendarType} class ${classData.id}`);
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        last_etag: etag,
        last_hash: contentHash,
        sync_error: null
      },
      { onConflict: "class_id,calendar_type" }
    );
    return;
  }

  // Parse ICS content - expand recurring events up to 6 months ahead
  // Use class timezone as default (ICS TZID will override if present)
  const expandUntil = new Date();
  expandUntil.setMonth(expandUntil.getMonth() + 6);
  const defaultTimezone = classData.time_zone || "UTC";
  const icsEvents = parseICS(content, expandUntil, defaultTimezone);
  const parsedEvents = icsEvents.map(convertToCalendarEvent);

  console.log(`[syncCalendar] Parsed ${parsedEvents.length} events from ICS (including expanded recurrences)`);

  // Get existing events from database (higher limit to account for recurring events)
  // Only fetch events that haven't ended more than 30 days ago to avoid processing old data
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: existingEvents } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("class_id", classData.id)
    .eq("calendar_type", calendarType)
    .gte("end_time", thirtyDaysAgo.toISOString())
    .limit(5000);

  const existingByUid = new Map<string, CalendarEvent>();
  for (const event of existingEvents || []) {
    existingByUid.set(event.uid, event as CalendarEvent);
  }

  const parsedByUid = new Map<string, ParsedEvent>();
  for (const event of parsedEvents) {
    parsedByUid.set(event.uid, event);
  }

  // Find events to add, update, and delete
  const toAdd: ParsedEvent[] = [];
  const toUpdate: {
    existing: CalendarEvent;
    parsed: ParsedEvent;
    titleChanged: boolean;
    startChanged: boolean;
    endChanged: boolean;
    locationChanged: boolean;
    descriptionChanged: boolean;
  }[] = [];
  const toDelete: CalendarEvent[] = [];

  // Helper to compare timestamps (handles format differences)
  const sameTime = (a: string, b: string): boolean => {
    return new Date(a).getTime() === new Date(b).getTime();
  };

  // Check for new and updated events
  for (const [uid, parsed] of parsedByUid) {
    const existing = existingByUid.get(uid);
    if (!existing) {
      toAdd.push(parsed);
    } else {
      // Check if event has changed (compare dates by value, not string format)
      const titleChanged = existing.title !== parsed.title;
      const startChanged = !sameTime(existing.start_time, parsed.start_time);
      const endChanged = !sameTime(existing.end_time, parsed.end_time);
      const locationChanged = existing.location !== (parsed.location || null);
      const descriptionChanged = existing.description !== (parsed.description || null);

      if (titleChanged || startChanged || endChanged || locationChanged || descriptionChanged) {
        toUpdate.push({
          existing,
          parsed,
          // Track what changed for smarter announcement logic
          titleChanged,
          startChanged,
          endChanged,
          locationChanged,
          descriptionChanged
        } as {
          existing: CalendarEvent;
          parsed: ParsedEvent;
          titleChanged: boolean;
          startChanged: boolean;
          endChanged: boolean;
          locationChanged: boolean;
          descriptionChanged: boolean;
        });
      }
    }
  }

  // Check for deleted events
  for (const [uid, existing] of existingByUid) {
    if (!parsedByUid.has(uid)) {
      toDelete.push(existing);
    }
  }

  console.log(`[syncCalendar] Changes: ${toAdd.length} add, ${toUpdate.length} update, ${toDelete.length} delete`);

  // Track mutation errors to prevent marking sync as successful if any fail
  let hadMutationError = false;
  const mutationErrors: string[] = [];

  // Current time for determining past/future events
  const now = new Date();
  const nowIso = now.toISOString();

  // Group events by base UID to handle recurring series as batches
  const additionsByBaseUid = groupEventsByBaseUid(toAdd);
  const updatesByBaseUid = groupEventsByBaseUid(toUpdate.map((u) => ({ ...u.parsed, _update: u })));
  const deletionsByBaseUid = groupEventsByBaseUid(toDelete);

  // Process additions - batch insert and batch announce recurring series
  if (toAdd.length > 0) {
    // For recurring series (>1 event with same base UID), we'll send a batch announcement
    // and pre-mark change_announced_at so the RPC doesn't announce them individually
    const seriesAnnouncedUids = new Set<string>();

    // Send batch announcements for recurring series
    if (classData.discord_server_id) {
      for (const [baseUid, events] of additionsByBaseUid) {
        // Filter to only future events for announcements
        const futureEvents = events.filter((e) => new Date(e.end_time) > now);
        if (futureEvents.length > 1) {
          // This is a recurring series - send batch announcement
          await enqueueRecurringSeriesAnnouncement(supabase, classData.id, futureEvents, "added");
          // Mark all events in this series to skip individual announcements
          for (const e of events) {
            seriesAnnouncedUids.add(e.uid);
          }
          console.log(
            `[syncCalendar] Sent batch announcement for recurring series ${baseUid} (${futureEvents.length} future events)`
          );
        }
      }
    }

    // Batch insert all events
    const { error: insertError } = await supabase.from("calendar_events").insert(
      toAdd.map((e) => {
        const startTime = new Date(e.start_time);
        const endTime = new Date(e.end_time);
        const startAlreadyPast = startTime <= now;
        const endAlreadyPast = endTime <= now;

        // Mark as announced if: past event OR part of a recurring series that was batch-announced
        const skipChangeAnnouncement = endAlreadyPast || seriesAnnouncedUids.has(e.uid);

        return {
          class_id: classData.id,
          calendar_type: calendarType,
          uid: e.uid,
          title: e.title,
          description: e.description || null,
          start_time: e.start_time,
          end_time: e.end_time,
          location: e.location || null,
          queue_name: e.queue_name || null,
          organizer_name: e.organizer_name || null,
          raw_ics_data: e.raw_ics_data as unknown as Json,
          change_announced_at: skipChangeAnnouncement ? nowIso : null,
          start_announced_at: startAlreadyPast ? nowIso : null,
          end_announced_at: endAlreadyPast ? nowIso : null
        };
      })
    );

    if (insertError) {
      hadMutationError = true;
      const errorMsg = `Failed to insert ${toAdd.length} event(s): ${insertError.message}`;
      mutationErrors.push(errorMsg);
      console.error(`[syncCalendar] ${errorMsg}`, insertError);
      scope.setContext("insert_error", { error: insertError.message });
    }
  }

  // Process updates - batch update and batch announce recurring series
  if (toUpdate.length > 0) {
    const seriesAnnouncedUids = new Set<string>();

    // Send batch announcements for recurring series updates
    if (classData.discord_server_id) {
      for (const [baseUid, updates] of updatesByBaseUid) {
        const futureUpdates = updates.filter((u) => new Date(u._update.parsed.end_time) > now);
        if (futureUpdates.length > 1) {
          // Determine what changed across the series
          const firstUpdate = futureUpdates[0]._update;
          const changes: string[] = [];
          if (firstUpdate.locationChanged) changes.push("📍 Location changed");
          if (firstUpdate.titleChanged) changes.push("📝 Title changed");
          if (firstUpdate.startChanged || firstUpdate.endChanged) changes.push("⏰ Time changed");

          const parsedEvents = futureUpdates.map((u) => u._update.parsed);
          await enqueueRecurringSeriesAnnouncement(
            supabase,
            classData.id,
            parsedEvents,
            "changed",
            changes.length > 0 ? changes.join("\n") : undefined
          );

          for (const u of updates) {
            seriesAnnouncedUids.add(u.uid);
          }
          console.log(`[syncCalendar] Sent batch update announcement for recurring series ${baseUid}`);
        }
      }
    }

    // Perform updates
    for (const { existing, parsed, startChanged, endChanged } of toUpdate) {
      const parsedEndTime = new Date(parsed.end_time);
      const parsedStartTime = new Date(parsed.start_time);
      const eventAlreadyEnded = parsedEndTime <= now;
      const eventAlreadyStarted = parsedStartTime <= now;

      // Skip individual announcement if part of batch-announced series
      const skipChangeAnnouncement = eventAlreadyEnded || seriesAnnouncedUids.has(parsed.uid);

      const { error: updateError } = await supabase
        .from("calendar_events")
        .update({
          title: parsed.title,
          description: parsed.description || null,
          start_time: parsed.start_time,
          end_time: parsed.end_time,
          location: parsed.location || null,
          queue_name: parsed.queue_name || null,
          organizer_name: parsed.organizer_name || null,
          raw_ics_data: parsed.raw_ics_data as unknown as Json,
          change_announced_at: skipChangeAnnouncement ? nowIso : null,
          start_announced_at: startChanged && !eventAlreadyStarted ? null : existing.start_announced_at,
          end_announced_at: endChanged && !eventAlreadyEnded ? null : existing.end_announced_at
        })
        .eq("id", existing.id);

      if (updateError) {
        hadMutationError = true;
        const errorMsg = `Failed to update event ${existing.id} (${existing.uid}): ${updateError.message}`;
        mutationErrors.push(errorMsg);
        console.error(`[syncCalendar] ${errorMsg}`, updateError);
      }
    }
  }

  // Process deletions - batch announce and batch delete recurring series
  if (toDelete.length > 0) {
    const announcedBaseUids = new Set<string>();

    // Send batch announcements for recurring series deletions
    if (classData.discord_server_id) {
      for (const [baseUid, events] of deletionsByBaseUid) {
        const futureEvents = events.filter((e) => new Date(e.end_time) > now);
        if (futureEvents.length > 1) {
          // Convert CalendarEvent to ParsedEvent format for the announcement
          const parsedEvents: ParsedEvent[] = futureEvents.map((e) => ({
            uid: e.uid,
            title: e.title,
            description: e.description || undefined,
            start_time: e.start_time,
            end_time: e.end_time,
            location: e.location || undefined,
            queue_name: e.queue_name || undefined,
            organizer_name: e.organizer_name || undefined,
            raw_ics_data: {}
          }));
          await enqueueRecurringSeriesAnnouncement(supabase, classData.id, parsedEvents, "removed");
          announcedBaseUids.add(baseUid);
          console.log(`[syncCalendar] Sent batch deletion announcement for recurring series ${baseUid}`);
        } else if (futureEvents.length === 1) {
          // Single future event - announce individually
          const event = futureEvents[0];
          await enqueueCalendarChangeAnnouncement(
            supabase,
            classData.id,
            event.title,
            "removed",
            event.start_time,
            event.end_time
          );
        }
        // Past events don't need deletion announcements
      }
    }

    // Batch delete all events
    const deleteIds = toDelete.map((e) => e.id);
    const { error: deleteError } = await supabase.from("calendar_events").delete().in("id", deleteIds);

    if (deleteError) {
      hadMutationError = true;
      const errorMsg = `Failed to delete ${toDelete.length} event(s): ${deleteError.message}`;
      mutationErrors.push(errorMsg);
      console.error(`[syncCalendar] ${errorMsg}`, deleteError);
    }
  }

  // Update sync state - only advance hash/etag if no mutation errors occurred
  if (hadMutationError) {
    // Mutation errors occurred - record error but don't advance hash/etag
    // This ensures we retry processing the same content on next sync
    const syncErrorMsg = mutationErrors.join("; ");
    console.error(
      `[syncCalendar] Sync completed with errors for ${calendarType} class ${classData.id}: ${syncErrorMsg}`
    );
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        sync_error: syncErrorMsg
        // Note: last_etag and last_hash are NOT updated, so we'll retry with same content
      },
      { onConflict: "class_id,calendar_type" }
    );
  } else {
    // No errors - clear sync_error and advance hash/etag to mark success
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        last_etag: etag,
        last_hash: contentHash,
        sync_error: null
      },
      { onConflict: "class_id,calendar_type" }
    );
  }
}

// Process announcements via database RPC (transactional, batched)
async function processAnnouncements(supabase: SupabaseClient<Database>, scope: Sentry.Scope): Promise<void> {
  console.log("[processAnnouncements] Calling process_calendar_announcements RPC");

  const { data, error } = await supabase.rpc("process_calendar_announcements" as never);

  if (error) {
    console.error("[processAnnouncements] RPC error:", error);
    scope.setContext("rpc_error", { error: error.message });
    throw error;
  }

  const result = data as {
    success: boolean;
    processed_count: number;
    messages_queued: number;
    change_announcements: number;
    start_announcements: number;
    end_announcements: number;
  };

  console.log("[processAnnouncements] RPC result:", result);
  scope.setContext("announcements", result);
}

// Enqueue calendar change announcement for a single event or series
async function enqueueCalendarChangeAnnouncement(
  supabase: SupabaseClient<Database>,
  classId: number,
  eventTitle: string,
  changeType: "added" | "removed" | "changed",
  startTime: string,
  endTime: string
): Promise<void> {
  // Get the scheduling channel for this class
  const { data: channel } = await supabase
    .from("discord_channels")
    .select("discord_channel_id")
    .eq("class_id", classId)
    .eq("channel_type", "scheduling")
    .single();

  if (!channel?.discord_channel_id) {
    console.log(`[enqueueCalendarChangeAnnouncement] No scheduling channel for class ${classId}`);
    return;
  }

  const emoji = changeType === "added" ? "📅" : changeType === "removed" ? "❌" : "✏️";
  const action = changeType === "added" ? "added to" : changeType === "removed" ? "removed from" : "updated in";

  const startDate = new Date(startTime);
  const endDate = new Date(endTime);
  const dateStr = startDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const timeStr = `${startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  await supabase.schema("pgmq_public").rpc("send", {
    queue_name: "discord_async_calls",
    message: {
      method: "send_message",
      args: {
        channel_id: channel.discord_channel_id,
        content: `${emoji} **${eventTitle}** has been ${action} the schedule`,
        embeds: [
          {
            description: `📆 ${dateStr}\n⏰ ${timeStr}`,
            color: changeType === "added" ? 0x00ff00 : changeType === "removed" ? 0xff0000 : 0xffaa00
          }
        ]
      },
      class_id: classId
    } as unknown as Json
  });
}

// Enqueue announcement for a recurring series (batch announcement)
async function enqueueRecurringSeriesAnnouncement(
  supabase: SupabaseClient<Database>,
  classId: number,
  events: ParsedEvent[],
  changeType: "added" | "removed" | "changed",
  changeDescription?: string
): Promise<void> {
  if (events.length === 0) return;

  // Get the scheduling channel for this class
  const { data: channel } = await supabase
    .from("discord_channels")
    .select("discord_channel_id")
    .eq("class_id", classId)
    .eq("channel_type", "scheduling")
    .single();

  if (!channel?.discord_channel_id) {
    console.log(`[enqueueRecurringSeriesAnnouncement] No scheduling channel for class ${classId}`);
    return;
  }

  const firstEvent = events[0];
  const eventTitle = firstEvent.organizer_name || firstEvent.title;
  const seriesDescription = describeRecurringSeries(events);

  const emoji = changeType === "added" ? "📅" : changeType === "removed" ? "❌" : "✏️";
  const action = changeType === "added" ? "added to" : changeType === "removed" ? "removed from" : "updated in";

  let description = `🔄 ${seriesDescription}`;
  if (changeDescription) {
    description += `\n${changeDescription}`;
  }
  if (firstEvent.location) {
    description += `\n📍 ${firstEvent.location}`;
  }

  await supabase.schema("pgmq_public").rpc("send", {
    queue_name: "discord_async_calls",
    message: {
      method: "send_message",
      args: {
        channel_id: channel.discord_channel_id,
        content: `${emoji} **${eventTitle}** has been ${action} the schedule`,
        embeds: [
          {
            description,
            color: changeType === "added" ? 0x00ff00 : changeType === "removed" ? 0xff0000 : 0xffaa00
          }
        ]
      },
      class_id: classId
    } as unknown as Json
  });
}

// Main sync function
async function runSync(): Promise<void> {
  console.log("[calendar-sync] Starting calendar sync");

  const scope = new Sentry.Scope();
  scope.setTag("function", "calendar-sync");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing required environment variables");
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  // Get all classes with calendar URLs configured
  const { data: classes, error: classesError } = await supabase
    .from("classes")
    .select("id, office_hours_ics_url, events_ics_url, discord_server_id, time_zone")
    .or("office_hours_ics_url.not.is.null,events_ics_url.not.is.null");

  if (classesError) {
    console.error("[calendar-sync] Error fetching classes:", classesError);
    Sentry.captureException(classesError, scope);
    return;
  }

  if (!classes || classes.length === 0) {
    console.log("[calendar-sync] No classes with calendar URLs configured");
    return;
  }

  console.log(`[calendar-sync] Found ${classes.length} classes with calendar URLs`);

  // Sync each calendar
  for (const classData of classes) {
    try {
      if (classData.office_hours_ics_url) {
        await syncCalendar(
          supabase,
          classData as ClassWithCalendar,
          "office_hours",
          classData.office_hours_ics_url,
          scope
        );
      }

      if (classData.events_ics_url) {
        await syncCalendar(supabase, classData as ClassWithCalendar, "events", classData.events_ics_url, scope);
      }
    } catch (error) {
      console.error(`[calendar-sync] Error syncing class ${classData.id}:`, error);
      Sentry.captureException(error, scope);
    }
  }

  // Process announcements
  try {
    await processAnnouncements(supabase, scope);
  } catch (error) {
    console.error("[calendar-sync] Error processing announcements:", error);
    Sentry.captureException(error, scope);
  }

  console.log("[calendar-sync] Sync complete");
}

// HTTP handler
Deno.serve(async (req) => {
  console.log(`[calendar-sync] Received request: ${req.method}`);

  // Verify request is from cron or has proper auth
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  const webhookSource = req.headers.get("x-supabase-webhook-source");

  // Allow cron job requests or requests with valid secret
  if (webhookSource !== "calendar-sync" && secret !== expectedSecret) {
    console.error("[calendar-sync] Unauthorized request");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    await runSync();

    return new Response(
      JSON.stringify({
        success: true,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("[calendar-sync] Error:", error);
    Sentry.captureException(error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString()
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});
