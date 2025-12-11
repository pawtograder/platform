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

// Parse ICS date formats
function parseICSDate(dateStr: string): Date {
  // Handle TZID format: TZID=America/New_York:20241210T100000
  if (dateStr.includes(":")) {
    dateStr = dateStr.split(":").pop() || dateStr;
  }

  // Remove any VALUE=DATE-TIME or similar prefixes
  dateStr = dateStr.replace(/^[^:]*:/, "");

  // Handle basic format: 20241210T100000 or 20241210T100000Z
  if (dateStr.length === 15 || dateStr.length === 16) {
    const year = parseInt(dateStr.slice(0, 4));
    const month = parseInt(dateStr.slice(4, 6)) - 1;
    const day = parseInt(dateStr.slice(6, 8));
    const hour = parseInt(dateStr.slice(9, 11));
    const minute = parseInt(dateStr.slice(11, 13));
    const second = parseInt(dateStr.slice(13, 15));

    if (dateStr.endsWith("Z")) {
      return new Date(Date.UTC(year, month, day, hour, minute, second));
    }
    return new Date(year, month, day, hour, minute, second);
  }

  // Handle date-only format: 20241210
  if (dateStr.length === 8) {
    const year = parseInt(dateStr.slice(0, 4));
    const month = parseInt(dateStr.slice(4, 6)) - 1;
    const day = parseInt(dateStr.slice(6, 8));
    return new Date(year, month, day);
  }

  // Fallback to Date parsing
  return new Date(dateStr);
}

// Parse ICS content into events
function parseICS(icsContent: string): ICSEvent[] {
  const events: ICSEvent[] = [];
  const lines = icsContent
    .replace(/\r\n /g, "")
    .replace(/\r\n\t/g, "")
    .split(/\r?\n/);

  let currentEvent: (Partial<ICSEvent> & { rawData: Record<string, string> }) | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      currentEvent = { rawData: {} };
    } else if (line === "END:VEVENT" && currentEvent) {
      if (currentEvent.uid && currentEvent.summary && currentEvent.dtstart && currentEvent.dtend) {
        events.push({
          uid: currentEvent.uid,
          summary: currentEvent.summary,
          description: currentEvent.description,
          dtstart: currentEvent.dtstart,
          dtend: currentEvent.dtend,
          location: currentEvent.location
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
            currentEvent.dtstart = parseICSDate(line.slice(line.indexOf(":") + 1));
            break;
          case "DTEND":
            currentEvent.dtend = parseICSDate(line.slice(line.indexOf(":") + 1));
            break;
          case "LOCATION":
            currentEvent.location = value.replace(/\\,/g, ",").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
            break;
        }
      }
    }
  }

  return events;
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

  // Parse ICS content
  const icsEvents = parseICS(content);
  const parsedEvents = icsEvents.map(convertToCalendarEvent);

  console.log(`[syncCalendar] Parsed ${parsedEvents.length} events from ICS`);

  // Get existing events from database
  const { data: existingEvents } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("class_id", classData.id)
    .eq("calendar_type", calendarType)
    .limit(1000);

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
  const toUpdate: { existing: CalendarEvent; parsed: ParsedEvent }[] = [];
  const toDelete: CalendarEvent[] = [];

  // Check for new and updated events
  for (const [uid, parsed] of parsedByUid) {
    const existing = existingByUid.get(uid);
    if (!existing) {
      toAdd.push(parsed);
    } else {
      // Check if event has changed
      if (
        existing.title !== parsed.title ||
        existing.start_time !== parsed.start_time ||
        existing.end_time !== parsed.end_time ||
        existing.location !== (parsed.location || null) ||
        existing.description !== (parsed.description || null)
      ) {
        toUpdate.push({ existing, parsed });
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

  // Process additions
  if (toAdd.length > 0) {
    const now = new Date();
    const nowIso = now.toISOString();

    const { error: insertError } = await supabase.from("calendar_events").insert(
      toAdd.map((e) => {
        const startTime = new Date(e.start_time);
        const endTime = new Date(e.end_time);

        // Pre-populate announced timestamps for past events to avoid announcing them
        // - If event has ended → mark both start and end as announced
        // - If event has started but not ended → mark start as announced
        // - If event is in the future → leave both null (normal case)
        const startAlreadyPast = startTime <= now;
        const endAlreadyPast = endTime <= now;

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
          // Mark as announced if already past to avoid announcing old events
          start_announced_at: startAlreadyPast ? nowIso : null,
          end_announced_at: endAlreadyPast ? nowIso : null
        };
      })
    );

    if (insertError) {
      console.error(`[syncCalendar] Error inserting events:`, insertError);
      scope.setContext("insert_error", { error: insertError.message });
    }
  }

  // Process updates (reset change_announced_at so it gets re-announced)
  for (const { existing, parsed } of toUpdate) {
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
        change_announced_at: null, // Reset so change gets announced
        // Reset start/end announced if times changed
        start_announced_at: existing.start_time !== parsed.start_time ? null : existing.start_announced_at,
        end_announced_at: existing.end_time !== parsed.end_time ? null : existing.end_announced_at
      })
      .eq("id", existing.id);

    if (updateError) {
      console.error(`[syncCalendar] Error updating event ${existing.id}:`, updateError);
    }
  }

  // Process deletions - announce before deleting
  for (const event of toDelete) {
    // Announce deletion if Discord is configured
    if (classData.discord_server_id) {
      await enqueueCalendarChangeAnnouncement(
        supabase,
        classData.id,
        event.title,
        "removed",
        event.start_time,
        event.end_time
      );
    }

    const { error: deleteError } = await supabase.from("calendar_events").delete().eq("id", event.id);

    if (deleteError) {
      console.error(`[syncCalendar] Error deleting event ${event.id}:`, deleteError);
    }
  }

  // Update sync state
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

// Enqueue calendar change announcement to #scheduling channel (used for deletions only)
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
    .select("id, office_hours_ics_url, events_ics_url, discord_server_id")
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
