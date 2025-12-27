import { TZDate } from "@date-fns/tz";

/**
 * ICS Calendar Event Input
 */
export interface ICSEvent {
  uid: string;
  title: string;
  description?: string | null;
  startTime: Date | string; // ISO string or Date object
  endTime: Date | string; // ISO string or Date object
  location?: string | null;
  allDay?: boolean; // If true, event is all-day
  timezone: string; // IANA timezone identifier (e.g., "America/New_York")
}

/**
 * Escape special characters in ICS text according to RFC 5545
 * Special characters: comma, semicolon, backslash, newline
 */
function escapeICSValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/;/g, "\\;") // Escape semicolons
    .replace(/,/g, "\\,") // Escape commas
    .replace(/\n/g, "\\n") // Escape newlines
    .replace(/\r/g, ""); // Remove carriage returns
}

/**
 * Format a date/time for ICS DTSTART/DTEND
 * Returns format: YYYYMMDDTHHMMSS (with timezone if not all-day)
 */
function formatICSDateTime(date: Date | string, timezone: string, allDay: boolean = false): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;

  if (allDay) {
    // All-day events use date-only format: YYYYMMDD
    const year = dateObj.getUTCFullYear();
    const month = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  // Timed events: convert to the specified timezone and format
  const tzDate = new TZDate(dateObj, timezone);

  const year = tzDate.getFullYear();
  const month = String(tzDate.getMonth() + 1).padStart(2, "0");
  const day = String(tzDate.getDate()).padStart(2, "0");
  const hour = String(tzDate.getHours()).padStart(2, "0");
  const minute = String(tzDate.getMinutes()).padStart(2, "0");
  const second = String(tzDate.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}T${hour}${minute}${second}`;
}

/**
 * Generate a VEVENT entry for ICS format
 */
function generateVEVENT(event: ICSEvent): string {
  const lines: string[] = [];

  lines.push("BEGIN:VEVENT");

  // UID (required)
  lines.push(`UID:${event.uid}`);

  // DTSTAMP (required) - current time in UTC
  const now = new Date();
  const dtstamp = formatICSDateTime(now, "UTC", false);
  lines.push(`DTSTAMP:${dtstamp}Z`);

  // DTSTART
  if (event.allDay) {
    const dtstart = formatICSDateTime(event.startTime, event.timezone, true);
    lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
  } else {
    const dtstart = formatICSDateTime(event.startTime, event.timezone, false);
    // Use TZID parameter for timezone-aware events
    lines.push(`DTSTART;TZID=${event.timezone}:${dtstart}`);
  }

  // DTEND
  if (event.allDay) {
    // For all-day events, DTEND is exclusive (day after)
    const endDate = typeof event.endTime === "string" ? new Date(event.endTime) : event.endTime;
    const nextDay = new Date(endDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const dtend = formatICSDateTime(nextDay, event.timezone, true);
    lines.push(`DTEND;VALUE=DATE:${dtend}`);
  } else {
    const dtend = formatICSDateTime(event.endTime, event.timezone, false);
    lines.push(`DTEND;TZID=${event.timezone}:${dtend}`);
  }

  // SUMMARY (title)
  lines.push(`SUMMARY:${escapeICSValue(event.title)}`);

  // DESCRIPTION (optional)
  if (event.description) {
    // ICS lines should be max 75 chars, but we'll let clients handle wrapping
    const escapedDesc = escapeICSValue(event.description);
    lines.push(`DESCRIPTION:${escapedDesc}`);
  }

  // LOCATION (optional)
  if (event.location) {
    lines.push(`LOCATION:${escapeICSValue(event.location)}`);
  }

  lines.push("END:VEVENT");

  return lines.join("\r\n");
}

/**
 * Generate a complete ICS calendar file
 * @param events Array of calendar events
 * @param calendarName Name of the calendar (for PRODID)
 * @returns ICS formatted string
 */
export function generateICS(events: ICSEvent[], calendarName: string = "Pawtograder Calendar"): string {
  const lines: string[] = [];

  // ICS Header
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Pawtograder//Course Calendar//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`X-WR-CALNAME:${escapeICSValue(calendarName)}`);

  // Add timezone definitions for all unique timezones used
  const uniqueTimezones = new Set<string>();
  events.forEach((event) => {
    if (!event.allDay) {
      uniqueTimezones.add(event.timezone);
    }
  });

  // Generate VTIMEZONE entries for each timezone
  // Note: For simplicity, we'll use a basic VTIMEZONE structure
  // Full timezone definitions would require TZ database info
  // Most calendar clients can handle TZID references without full definitions
  uniqueTimezones.forEach((tz) => {
    // Basic VTIMEZONE - calendar clients will resolve the timezone
    // For production, you might want to include full VTIMEZONE definitions
    lines.push(`X-WR-TIMEZONE:${tz}`);
  });

  // Add all events
  events.forEach((event) => {
    lines.push(generateVEVENT(event));
  });

  // ICS Footer
  lines.push("END:VCALENDAR");

  return lines.join("\r\n");
}
