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
  timezone?: string; // Original timezone from DTSTART TZID parameter
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
function describeRecurringSeries(events: ParsedEvent[], classTimezone: string): string {
  if (events.length === 0) return "";
  if (events.length === 1) {
    // Single event - just show the date
    const start = new Date(events[0].start_time);
    const end = new Date(events[0].end_time);
    return formatSingleEventDescription(start, end, classTimezone);
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
  const timeStr = formatTimeRange(firstStart, firstEnd, classTimezone);

  // Detect day pattern
  const dayPattern = detectDayPattern(sorted);

  // Date range
  const startDateStr = firstStart.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: classTimezone
  });
  const endDateStr = lastStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: classTimezone });

  return `${dayPattern} ${timeStr} (${startDateStr} - ${endDateStr}, ${events.length} sessions)`;
}

// Format time range like "10:00 AM - 12:00 PM"
function formatTimeRange(start: Date, end: Date, classTimezone: string): string {
  const startTime = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: classTimezone });
  const endTime = end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: classTimezone });
  return `${startTime} - ${endTime}`;
}

// Format single event description
function formatSingleEventDescription(start: Date, end: Date, classTimezone: string): string {
  const dateStr = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: classTimezone
  });
  const timeStr = formatTimeRange(start, end, classTimezone);
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
// Uses Intl.DateTimeFormat to reliably convert timezone-aware dates to UTC
function convertToUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string
): Date {
  // Normalize timezone to IANA format
  const normalizedTimezone = normalizeTimezone(timezone);

  try {
    // Strategy: Use Intl.DateTimeFormat to find the UTC time that, when formatted
    // in the target timezone, shows our target date/time.

    // Start with a reasonable initial guess: treat the time as if it were UTC
    // This will be close for most timezones
    let candidateUTC = new Date(Date.UTC(year, month, day, hour, minute, second));

    // Create formatter for target timezone
    const tzFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: normalizedTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

    // Iteratively refine until we find the exact UTC time
    let iterations = 0;
    const maxIterations = 20; // Allow more iterations for edge cases

    while (iterations < maxIterations) {
      const tzParts = tzFormatter.formatToParts(candidateUTC);
      const tzYear = parseInt(tzParts.find((p) => p.type === "year")!.value);
      const tzMonth = parseInt(tzParts.find((p) => p.type === "month")!.value);
      const tzDay = parseInt(tzParts.find((p) => p.type === "day")!.value);
      const tzHour = parseInt(tzParts.find((p) => p.type === "hour")!.value);
      const tzMinute = parseInt(tzParts.find((p) => p.type === "minute")!.value);
      const tzSecond = parseInt(tzParts.find((p) => p.type === "second")!.value);

      // Check if we've found the exact match
      if (
        tzYear === year &&
        tzMonth === month + 1 &&
        tzDay === day &&
        tzHour === hour &&
        tzMinute === minute &&
        tzSecond === second
      ) {
        return candidateUTC;
      }

      // Calculate the difference more accurately
      // We need to adjust candidateUTC so that when formatted in timezone, it shows our target
      // The key insight: if candidateUTC shows tzHour:tzMinute:tzSecond in the timezone,
      // and we want hour:minute:second, we need to adjust by the time difference

      // Calculate total seconds difference in the timezone's local time representation
      const targetTotalSeconds = hour * 3600 + minute * 60 + second;
      const tzTotalSeconds = tzHour * 3600 + tzMinute * 60 + tzSecond;
      let secondsDiff = targetTotalSeconds - tzTotalSeconds;

      // Account for day differences (which can cause hour rollover)
      const targetDate = new Date(Date.UTC(year, month, day));
      const tzDate = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay));
      const dayDiffMs = targetDate.getTime() - tzDate.getTime();

      // If days differ, we need to account for that
      // The day difference in milliseconds, plus the time difference
      const totalAdjustmentMs = dayDiffMs + secondsDiff * 1000;

      // Apply adjustment
      candidateUTC = new Date(candidateUTC.getTime() + totalAdjustmentMs);

      iterations++;
    }

    // If we didn't converge exactly, return the best guess
    // (This should rarely happen, but log it for debugging)
    if (iterations >= maxIterations) {
      console.warn(
        `[convertToUTC] Did not converge exactly after ${maxIterations} iterations for ${year}-${month + 1}-${day} ${hour}:${minute}:${second} in ${normalizedTimezone}, using best guess`
      );
    }
    return candidateUTC;
  } catch (e) {
    // Fallback: log error and use UTC (better than wrong timezone)
    console.warn(
      `[convertToUTC] Failed to convert timezone ${normalizedTimezone} (original: ${timezone}) for ${year}-${month + 1}-${day} ${hour}:${minute}:${second}:`,
      e
    );
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
}

// Map common timezone names to IANA timezone identifiers
// ICS files may contain Windows-style or display names instead of IANA identifiers
function normalizeTimezone(timezone: string): string {
  // If it's already a valid IANA identifier (contains /), return as-is
  if (timezone.includes("/")) {
    return timezone;
  }

  // Map common timezone names to IANA identifiers
  const timezoneMap: Record<string, string> = {
    // US Eastern Time
    "Eastern Standard Time": "America/New_York",
    "Eastern Time": "America/New_York",
    EST: "America/New_York",
    EDT: "America/New_York",
    ET: "America/New_York",

    // US Central Time
    "Central Standard Time": "America/Chicago",
    "Central Time": "America/Chicago",
    CST: "America/Chicago",
    CDT: "America/Chicago",
    CT: "America/Chicago",

    // US Mountain Time
    "Mountain Standard Time": "America/Denver",
    "Mountain Time": "America/Denver",
    MST: "America/Denver",
    MDT: "America/Denver",
    MT: "America/Denver",

    // US Pacific Time
    "Pacific Standard Time": "America/Los_Angeles",
    "Pacific Time": "America/Los_Angeles",
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    PT: "America/Los_Angeles",

    // US Alaska Time
    "Alaska Standard Time": "America/Anchorage",
    "Alaska Time": "America/Anchorage",
    AKST: "America/Anchorage",
    AKDT: "America/Anchorage",

    // US Hawaii Time
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "Hawaii Time": "Pacific/Honolulu",
    HST: "Pacific/Honolulu",

    // UTC
    UTC: "UTC",
    GMT: "UTC",
    "Greenwich Mean Time": "UTC",
    "Coordinated Universal Time": "UTC",

    // Common European timezones
    "Central European Time": "Europe/Paris",
    CET: "Europe/Paris",
    CEST: "Europe/Paris",
    "British Summer Time": "Europe/London",
    BST: "Europe/London",
    "GMT Standard Time": "Europe/London"
  };

  // Normalize the input (case-insensitive, trim whitespace)
  const normalized = timezone.trim();
  const mapped = timezoneMap[normalized] || timezoneMap[normalized.toUpperCase()];

  if (mapped) {
    return mapped;
  }

  // If not found in map, try to validate it as an IANA timezone
  // If it fails validation, return UTC as fallback
  try {
    // Try to use it - if it's invalid, Intl will throw
    Intl.DateTimeFormat(undefined, { timeZone: normalized });
    return normalized;
  } catch {
    console.warn(`[normalizeTimezone] Unknown timezone "${timezone}", using UTC as fallback`);
    return "UTC";
  }
}

// Extract timezone from ICS line (e.g., "DTSTART;TZID=America/New_York:20241210T100000")
function extractTimezoneFromICSLine(icsLine: string, defaultTimezone: string = "UTC"): string {
  const colonIndex = icsLine.indexOf(":");
  if (colonIndex > 0) {
    const prefix = icsLine.slice(0, colonIndex);
    const tzidMatch = prefix.match(/TZID=([^;:]+)/i);
    if (tzidMatch) {
      const extractedTz = tzidMatch[1];
      // Normalize the timezone to IANA format
      return normalizeTimezone(extractedTz);
    }
  }

  // Check if date value ends with Z (UTC indicator)
  const dateValue = colonIndex > 0 ? icsLine.slice(colonIndex + 1) : icsLine;
  if (dateValue.endsWith("Z")) {
    return "UTC";
  }

  return normalizeTimezone(defaultTimezone);
}

// Parse ICS date formats with timezone support
// Accepts the full ICS line (e.g., "DTSTART;TZID=America/New_York:20241210T100000")
// or just the value portion, along with a default timezone
// Returns a Date object in UTC, which can be converted to ISO string for Postgres timestamptz
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
      timezone = normalizeTimezone(tzidMatch[1]);
    }
  } else {
    // No colon, assume it's just the date value
    dateValue = icsLine;
  }

  // Handle UTC format (ends with Z)
  if (dateValue.endsWith("Z")) {
    timezone = "UTC";
    dateValue = dateValue.slice(0, -1);
  } else {
    // Normalize timezone to IANA format
    timezone = normalizeTimezone(timezone);
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
// Expands in the original timezone to maintain consistent local times (e.g., always 10:00 AM Eastern)
function expandRecurringEvent(event: ICSEvent, maxDate: Date, defaultTimezone: string = "UTC"): ICSEvent[] {
  if (!event.rrule) {
    return [event];
  }

  const rrule = parseRRule(event.rrule, defaultTimezone);
  if (!rrule) {
    console.log(`[expandRecurringEvent] Failed to parse RRULE: ${event.rrule}`);
    return [event];
  }

  // Use the event's timezone if available, otherwise use default
  // Normalize to IANA format
  const eventTimezone = normalizeTimezone(event.timezone || defaultTimezone);

  // Extract local time components from dtstart in the original timezone
  // This ensures recurring events maintain the same local time even when DST changes
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: eventTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const startParts = tzFormatter.formatToParts(event.dtstart);
  const startYear = parseInt(startParts.find((p) => p.type === "year")!.value);
  const startMonth = parseInt(startParts.find((p) => p.type === "month")!.value) - 1; // 0-indexed
  const startDay = parseInt(startParts.find((p) => p.type === "day")!.value);
  const startHour = parseInt(startParts.find((p) => p.type === "hour")!.value);
  const startMinute = parseInt(startParts.find((p) => p.type === "minute")!.value);
  const startSecond = parseInt(startParts.find((p) => p.type === "second")!.value);

  // Calculate duration in milliseconds
  const duration = event.dtend.getTime() - event.dtstart.getTime();

  const occurrences: ICSEvent[] = [];
  const exdateSet = new Set(event.exdates?.map((d) => d.toISOString().split("T")[0]) || []);

  // Limit expansion: max 1 year ahead or 500 occurrences
  const maxOccurrences = Math.min(rrule.count || 500, 500);
  const effectiveUntil = rrule.until ? new Date(Math.min(rrule.until.getTime(), maxDate.getTime())) : maxDate;

  // Start with the original local time components
  let currentYear = startYear;
  let currentMonth = startMonth;
  let currentDay = startDay;
  const currentHour = startHour;
  const currentMinute = startMinute;
  const currentSecond = startSecond;

  let occurrenceCount = 0;

  // Generate a unique occurrence UID
  const makeOccurrenceUid = (baseUid: string, date: Date): string => {
    const dateStr = date.toISOString().replace(/[-:]/g, "").split(".")[0];
    return `${baseUid}_${dateStr}`;
  };

  while (occurrenceCount < maxOccurrences) {
    // Convert current local time components to UTC Date
    const occurrenceStartUTC = convertToUTC(
      currentYear,
      currentMonth,
      currentDay,
      currentHour,
      currentMinute,
      currentSecond,
      eventTimezone
    );

    // Check if we've exceeded the effective until date
    if (occurrenceStartUTC > effectiveUntil) {
      break;
    }

    const dateKey = occurrenceStartUTC.toISOString().split("T")[0];

    // Check if this date should be included
    let includeDate = !exdateSet.has(dateKey);

    // For WEEKLY with BYDAY, check if current day matches
    if (includeDate && rrule.freq === "WEEKLY" && rrule.byday) {
      // Get day of week by formatting the occurrence start date in the timezone
      // Use a formatter that gives us the weekday
      const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: eventTimezone,
        weekday: "short"
      });
      const weekdayStr = weekdayFormatter.format(occurrenceStartUTC).toUpperCase().slice(0, 2);
      includeDate = rrule.byday.some((day) => {
        const dayPart = day.replace(/^-?\d+/, "");
        return dayPart === weekdayStr;
      });
    }

    // For MONTHLY with BYMONTHDAY, check if day matches
    if (includeDate && rrule.freq === "MONTHLY" && rrule.bymonthday) {
      includeDate = rrule.bymonthday.includes(currentDay);
    }

    if (includeDate) {
      const occurrenceEndUTC = new Date(occurrenceStartUTC.getTime() + duration);

      occurrences.push({
        uid: makeOccurrenceUid(event.uid, occurrenceStartUTC),
        summary: event.summary,
        description: event.description,
        dtstart: occurrenceStartUTC,
        dtend: occurrenceEndUTC,
        location: event.location,
        timezone: eventTimezone
      });
      occurrenceCount++;
    }

    // Move to next potential occurrence in local time
    switch (rrule.freq) {
      case "DAILY": {
        currentDay += rrule.interval;
        // Handle month/year rollover
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        if (currentDay > daysInMonth) {
          currentDay = 1;
          currentMonth++;
          if (currentMonth > 11) {
            currentMonth = 0;
            currentYear++;
          }
        }
        break;
      }
      case "WEEKLY": {
        if (rrule.byday && rrule.byday.length > 1) {
          // For multi-day weekly rules, advance by 1 day
          currentDay++;
          const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
          if (currentDay > daysInMonth) {
            currentDay = 1;
            currentMonth++;
            if (currentMonth > 11) {
              currentMonth = 0;
              currentYear++;
            }
          }
        } else {
          // Add weeks (7 days)
          currentDay += 7 * rrule.interval;
          const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
          while (currentDay > daysInMonth) {
            currentDay -= daysInMonth;
            currentMonth++;
            if (currentMonth > 11) {
              currentMonth = 0;
              currentYear++;
            }
            const newDaysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
            if (currentDay > newDaysInMonth) {
              currentDay = newDaysInMonth;
            }
          }
        }
        break;
      }
      case "MONTHLY": {
        currentMonth += rrule.interval;
        while (currentMonth > 11) {
          currentMonth -= 12;
          currentYear++;
        }
        // Adjust day if it's invalid for the new month (e.g., Feb 30 -> Feb 28/29)
        const maxDay = new Date(currentYear, currentMonth + 1, 0).getDate();
        if (currentDay > maxDay) {
          currentDay = maxDay;
        }
        break;
      }
      case "YEARLY": {
        currentYear += rrule.interval;
        // Adjust day if it's invalid for the new year (e.g., Feb 29 in non-leap year)
        const maxDayYearly = new Date(currentYear, currentMonth + 1, 0).getDate();
        if (currentDay > maxDayYearly) {
          currentDay = maxDayYearly;
        }
        break;
      }
    }
  }

  console.log(
    `[expandRecurringEvent] Expanded ${event.uid} (${rrule.freq}) into ${occurrences.length} occurrences in timezone ${eventTimezone}`
  );
  return occurrences;
}

// Parse ICS content into events
function parseICS(icsContent: string, expandUntil: Date, defaultTimezone: string = "UTC"): ICSEvent[] {
  const rawEvents: ICSEvent[] = [];
  const lines = icsContent
    .replace(/\r\n /g, "")
    .replace(/\r\n\t/g, "")
    .split(/\r?\n/);

  let currentEvent:
    | (Partial<ICSEvent> & { rawData: Record<string, string>; exdatesRaw?: string[]; dtstartTimezone?: string })
    | null = null;

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
          recurrenceId: currentEvent.recurrenceId,
          timezone: currentEvent.dtstartTimezone || defaultTimezone
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
            // Extract and store the timezone for recurring event expansion
            currentEvent.dtstartTimezone = extractTimezoneFromICSLine(line, defaultTimezone);
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
// Dates are converted to ISO strings (UTC) which Postgres will store as timestamptz
function convertToCalendarEvent(event: ICSEvent): ParsedEvent {
  const { name, queue } = parseEventTitle(event.summary);

  return {
    uid: event.uid,
    title: event.summary,
    description: event.description,
    // toISOString() produces UTC ISO strings (e.g., "2024-12-10T10:00:00.000Z")
    // Postgres timestamptz will parse these correctly and store as UTC internally
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
  // Normalize timezone to IANA format (class timezone should already be IANA, but normalize to be safe)
  const defaultTimezone = normalizeTimezone(classData.time_zone || "UTC");
  const icsEvents = parseICS(content, expandUntil, defaultTimezone);
  const parsedEvents = icsEvents.map(convertToCalendarEvent);

  console.log(`[syncCalendar] Parsed ${parsedEvents.length} events from ICS (including expanded recurrences)`);

  // Convert parsed events to JSON for RPC call
  const parsedEventsJson = parsedEvents.map((e) => ({
    uid: e.uid,
    title: e.title,
    description: e.description || null,
    start_time: e.start_time,
    end_time: e.end_time,
    location: e.location || null,
    queue_name: e.queue_name || null,
    organizer_name: e.organizer_name || null,
    raw_ics_data: e.raw_ics_data
  }));

  // Call RPC to sync events
  const { data: syncResult, error: rpcError } = await supabase.rpc(
    "sync_calendar_events" as never,
    {
      p_class_id: classData.id,
      p_calendar_type: calendarType,
      p_parsed_events: parsedEventsJson as unknown as Json,
      p_has_discord_server: !!classData.discord_server_id
    } as never
  );

  if (rpcError) {
    const syncErrorMsg = `RPC error: ${rpcError.message}`;
    console.error(`[syncCalendar] ${syncErrorMsg}`, rpcError);
    scope.setContext("rpc_error", { error: rpcError.message });
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        sync_error: syncErrorMsg
      },
      { onConflict: "class_id,calendar_type" }
    );
    return;
  }

  const result = syncResult as {
    success: boolean;
    added: number;
    updated: number;
    deleted: number;
    errors: string[];
    error_count: number;
  };

  console.log(
    `[syncCalendar] RPC result: ${result.added} added, ${result.updated} updated, ${result.deleted} deleted, ${result.error_count} errors`
  );

  // Handle batch announcements for recurring series (new/changed events)
  // Note: Individual announcements are handled by process_calendar_announcements RPC
  // Only query for announcements if we actually added or updated events
  if (classData.discord_server_id && (result.added > 0 || result.updated > 0)) {
    console.log(`[syncCalendar] Checking for batch announcements (${result.added} added, ${result.updated} updated)`);
    const now = new Date();

    // Get all events that need change announcements (not past, not already announced)
    const { data: eventsNeedingAnnouncement } = await supabase
      .from("calendar_events")
      .select("*")
      .eq("class_id", classData.id)
      .eq("calendar_type", calendarType)
      .is("change_announced_at", null)
      .gt("end_time", now.toISOString())
      .order("start_time", { ascending: true })
      .limit(1000);

    if (eventsNeedingAnnouncement && eventsNeedingAnnouncement.length > 0) {
      // Group by base UID for batch announcements
      const eventsByBaseUid = groupEventsByBaseUid(
        eventsNeedingAnnouncement.map((e) => ({
          uid: e.uid,
          title: e.title,
          description: e.description || undefined,
          start_time: e.start_time,
          end_time: e.end_time,
          location: e.location || undefined,
          queue_name: e.queue_name || undefined,
          organizer_name: e.organizer_name || undefined,
          raw_ics_data: {}
        }))
      );

      const seriesAnnouncedUids = new Set<string>();
      for (const [baseUid, events] of eventsByBaseUid) {
        if (events.length > 1) {
          // Recurring series - send batch announcement
          // Determine if this is a new series or changed series by checking if events were just added
          // For simplicity, treat all as "added" - the RPC will have marked updated events appropriately
          await enqueueRecurringSeriesAnnouncement(supabase, classData.id, events, "added");
          for (const e of events) {
            seriesAnnouncedUids.add(e.uid);
          }
          console.log(
            `[syncCalendar] Sent batch announcement for recurring series ${baseUid} (${events.length} events)`
          );
        }
      }

      // Mark batch-announced events as announced
      if (seriesAnnouncedUids.size > 0) {
        const { error: updateError } = await supabase
          .from("calendar_events")
          .update({ change_announced_at: now.toISOString() })
          .eq("class_id", classData.id)
          .eq("calendar_type", calendarType)
          .in("uid", Array.from(seriesAnnouncedUids));

        if (updateError) {
          console.error(`[syncCalendar] Failed to mark batch-announced events: ${updateError.message}`);
        }
      }
    }
  }

  // Update sync state - only advance hash/etag if no errors occurred
  if (!result.success || result.error_count > 0) {
    const syncErrorMsg = result.errors.length > 0 ? result.errors.join("; ") : "Unknown error";
    console.error(
      `[syncCalendar] Sync completed with errors for ${calendarType} class ${classData.id}: ${syncErrorMsg}`
    );
    await supabase.from("calendar_sync_state").upsert(
      {
        class_id: classData.id,
        calendar_type: calendarType,
        last_sync_at: new Date().toISOString(),
        sync_error: syncErrorMsg
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
// Currently unused - individual announcements handled by process_calendar_announcements RPC
async function _enqueueCalendarChangeAnnouncement(
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

  // Get the class timezone
  const { data: classData } = await supabase.from("classes").select("time_zone").eq("id", classId).single();

  const classTimezone = normalizeTimezone(classData?.time_zone || "UTC");

  const emoji = changeType === "added" ? "📅" : changeType === "removed" ? "❌" : "✏️";
  const action = changeType === "added" ? "added to" : changeType === "removed" ? "removed from" : "updated in";

  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  // Format dates using the class timezone
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: classTimezone
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: classTimezone
  });

  const dateStr = dateFormatter.format(startDate);
  const timeStr = `${timeFormatter.format(startDate)} - ${timeFormatter.format(endDate)}`;

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

  // Get the class timezone
  const { data: classData } = await supabase.from("classes").select("time_zone").eq("id", classId).single();
  const classTimezone = normalizeTimezone(classData?.time_zone || "UTC");

  const firstEvent = events[0];
  const eventTitle = firstEvent.organizer_name || firstEvent.title;
  const seriesDescription = describeRecurringSeries(events, classTimezone);

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
