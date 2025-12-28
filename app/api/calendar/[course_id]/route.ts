import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { generateICS, ICSEvent } from "@/lib/ics-generator";
import { TZDate } from "@date-fns/tz";

/**
 * Parse class section meeting times string (e.g., "MWF 10:00-11:00" or "T/R 2:30pm-3:30pm")
 * Returns days of week, start time, and end time
 */
function parseClassSectionMeetingTimes(meetingTimes: string): {
  days: string[];
  startTime: string | null;
  endTime: string | null;
} {
  if (!meetingTimes?.trim()) {
    return { days: [], startTime: null, endTime: null };
  }

  // Day mapping
  const dayMap: Record<string, string> = {
    M: "monday",
    T: "tuesday",
    W: "wednesday",
    R: "thursday",
    F: "friday",
    S: "saturday",
    U: "sunday"
  };

  // Extract all days mentioned
  const days: string[] = [];
  const dayChars = new Set<string>();

  // Handle "/" separator (e.g., "T/R" means Tuesday and Thursday)
  const parts = meetingTimes.split(/\s+/);
  for (const part of parts) {
    if (part.includes("/")) {
      // Split on "/" and add each day
      const dayParts = part.split("/");
      for (const dayPart of dayParts) {
        if (dayPart in dayMap && !dayChars.has(dayPart)) {
          dayChars.add(dayPart);
          days.push(dayMap[dayPart]);
        }
      }
    } else {
      // Check each character in the part
      for (const char of part) {
        if (char in dayMap && !dayChars.has(char)) {
          dayChars.add(char);
          days.push(dayMap[char]);
        }
      }
    }
  }

  // Try multiple time pattern variations
  const timePatterns = [
    /(\d{1,2}:\d{2}[ap])\s*-\s*(\d{1,2}:\d{2}[ap])/i, // 8:00a-9:40a
    /(\d{1,2}:\d{2}[ap]m)\s*-\s*(\d{1,2}:\d{2}[ap]m)/i, // 9:00am-10:00am
    /(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i, // 9:00 am-10:00 pm
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/i, // 09:00-10:00
    /(\d{1,2}[ap])\s*-\s*(\d{1,2}[ap])/i, // 9a-10a
    /(\d{1,2}[ap]m)\s*-\s*(\d{1,2}[ap]m)/i // 9am-10am
  ];

  let timeMatch: RegExpMatchArray | null = null;
  let matchedPattern = -1;

  for (let i = 0; i < timePatterns.length; i++) {
    timeMatch = meetingTimes.match(timePatterns[i]);
    if (timeMatch) {
      matchedPattern = i;
      break;
    }
  }

  if (!timeMatch) {
    return { days, startTime: null, endTime: null };
  }

  const [, startTimeStr, endTimeStr] = timeMatch;

  // Convert to 24-hour format
  const convertTo24Hour = (timeStr: string): string => {
    let match: RegExpMatchArray | null = null;

    if (matchedPattern === 0) {
      // 8:00a format
      match = timeStr.match(/^(\d{1,2}):(\d{2})([ap])$/i);
    } else if (matchedPattern === 1) {
      // 9:00am format
      match = timeStr.match(/^(\d{1,2}):(\d{2})([ap])m$/i);
    } else if (matchedPattern === 2) {
      // 9:00 am format
      match = timeStr.match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i);
    } else if (matchedPattern === 3) {
      // 09:00 format (24hr already)
      match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const [, hours, minutes] = match;
        return `${parseInt(hours).toString().padStart(2, "0")}:${minutes}`;
      }
    } else if (matchedPattern === 4) {
      // 9a format
      match = timeStr.match(/^(\d{1,2})([ap])$/i);
      if (match) {
        const [, hours, ampm] = match;
        let hour = parseInt(hours);
        if (ampm.toLowerCase() === "p" && hour !== 12) {
          hour += 12;
        } else if (ampm.toLowerCase() === "a" && hour === 12) {
          hour = 0;
        }
        return `${hour.toString().padStart(2, "0")}:00`;
      }
    } else if (matchedPattern === 5) {
      // 9am format
      match = timeStr.match(/^(\d{1,2})([ap])m$/i);
      if (match) {
        const [, hours, ampm] = match;
        let hour = parseInt(hours);
        if (ampm.toLowerCase() === "p" && hour !== 12) {
          hour += 12;
        } else if (ampm.toLowerCase() === "a" && hour === 12) {
          hour = 0;
        }
        return `${hour.toString().padStart(2, "0")}:00`;
      }
    }

    if (!match) {
      return timeStr; // Return as-is if we can't parse
    }

    const [, hours, minutes, ampm] = match;
    let hour = parseInt(hours);

    if (ampm && ampm.toLowerCase() === "p" && hour !== 12) {
      hour += 12;
    } else if (ampm && ampm.toLowerCase() === "a" && hour === 12) {
      hour = 0;
    }

    return `${hour.toString().padStart(2, "0")}:${minutes || "00"}`;
  };

  const startTime = convertTo24Hour(startTimeStr);
  const endTime = convertTo24Hour(endTimeStr);

  return { days, startTime, endTime };
}

/**
 * Handle CORS preflight requests
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

/**
 * Generate ICS calendar feed for a course
 * GET /api/calendar/[course_id]?classSection={id}&labSection={id}
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ course_id: string }> }) {
  try {
    const { course_id } = await params;
    const courseId = parseInt(course_id);
    if (isNaN(courseId)) {
      return NextResponse.json({ error: "Invalid course ID" }, { status: 400 });
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const classSectionId = searchParams.get("classSection");
    const labSectionId = searchParams.get("labSection");
    const includeOfficeHours = searchParams.get("includeOfficeHours") !== "false"; // Default to true
    const includeCourseEvents = searchParams.get("includeCourseEvents") !== "false"; // Default to true

    // Create service role client for public access (bypasses RLS)
    const supabase = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Fetch course to get timezone and dates
    const { data: course, error: courseError } = await supabase
      .from("classes")
      .select("id, name, time_zone, start_date, end_date")
      .eq("id", courseId)
      .eq("archived", false)
      .single();

    if (courseError || !course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const timezone = course.time_zone || "America/New_York";
    const calendarName = course.name || `Course ${courseId}`;

    // Fetch all data in parallel
    const [calendarEventsResult, assignmentsResult, labSectionsResult, labMeetingsResult, classSectionsResult] =
      await Promise.all([
        // Calendar events (office hours and events)
        supabase.from("calendar_events").select("*").eq("class_id", courseId).order("start_time", { ascending: true }),

        // Assignments (excluding lab-based due dates)
        supabase
          .from("assignments")
          .select("id, title, description, release_date, due_date, minutes_due_after_lab, updated_at, created_at")
          .eq("class_id", courseId)
          .is("archived_at", null)
          .is("minutes_due_after_lab", null), // Exclude lab-based assignments

        // Lab sections (if labSection param provided)
        labSectionId
          ? supabase.from("lab_sections").select("*").eq("class_id", courseId).eq("id", parseInt(labSectionId)).single()
          : Promise.resolve({ data: null, error: null }),

        // Lab section meetings (if labSection param provided)
        labSectionId
          ? supabase
              .from("lab_section_meetings")
              .select("*")
              .eq("class_id", courseId)
              .eq("lab_section_id", parseInt(labSectionId))
              .eq("cancelled", false)
              .order("meeting_date", { ascending: true })
          : Promise.resolve({ data: [], error: null }),

        // Class sections (if classSection param provided)
        classSectionId
          ? supabase
              .from("class_sections")
              .select("*")
              .eq("class_id", courseId)
              .eq("id", parseInt(classSectionId))
              .single()
          : Promise.resolve({ data: null, error: null })
      ]);

    if (calendarEventsResult.error) {
      console.error("Error fetching calendar events:", calendarEventsResult.error);
    }
    if (assignmentsResult.error) {
      console.error("Error fetching assignments:", assignmentsResult.error);
    }

    const calendarEvents = calendarEventsResult.data || [];
    const assignments = assignmentsResult.data || [];
    const labSection = labSectionsResult.data;
    const labMeetings = labMeetingsResult.data || [];
    const classSection = classSectionsResult.data;

    // Build ICS events array
    const icsEvents: ICSEvent[] = [];

    // 1. Add calendar events (office hours and events) - filtered by include flags
    for (const event of calendarEvents) {
      // Filter based on include flags
      if (event.calendar_type === "office_hours" && !includeOfficeHours) {
        continue;
      }
      if (event.calendar_type === "events" && !includeCourseEvents) {
        continue;
      }

      icsEvents.push({
        uid: event.uid,
        title: event.title,
        description: event.description || undefined,
        startTime: event.start_time,
        endTime: event.end_time,
        location: event.location || undefined,
        allDay: false,
        timezone
      });
    }

    // 2. Add assignment release dates (all-day events)
    for (const assignment of assignments) {
      if (assignment.release_date) {
        icsEvents.push({
          uid: `assignment-release-${assignment.id}`,
          title: `Released: ${assignment.title}`,
          description: assignment.description || undefined,
          startTime: assignment.release_date,
          endTime: assignment.release_date,
          location: undefined,
          allDay: true,
          timezone
        });
      }
    }

    // 3. Add assignment due dates (timed events)
    for (const assignment of assignments) {
      if (assignment.due_date) {
        icsEvents.push({
          uid: `assignment-due-${assignment.id}`,
          title: `Due: ${assignment.title}`,
          description: assignment.description || undefined,
          startTime: assignment.due_date,
          endTime: assignment.due_date,
          location: undefined,
          allDay: false,
          timezone
        });
      }
    }

    // 4. Add lab section meetings (if labSection param provided)
    if (labSection && labMeetings.length > 0) {
      for (const meeting of labMeetings) {
        if (meeting.cancelled) continue;

        // Combine meeting_date with start_time and end_time from lab section
        if (!labSection.start_time) continue; // Skip if no start time

        const startTimeStr = labSection.start_time.length === 5 ? `${labSection.start_time}:00` : labSection.start_time;
        const endTimeStr = labSection.end_time
          ? labSection.end_time.length === 5
            ? `${labSection.end_time}:00`
            : labSection.end_time
          : startTimeStr;

        // Parse date components
        const [year, month, day] = meeting.meeting_date.split("-").map(Number);
        const [startHour, startMinute] = startTimeStr.split(":").map(Number);
        const finalEndTimeStr = endTimeStr || startTimeStr;
        const [endHour, endMinute] = finalEndTimeStr.split(":").map(Number);

        // Create TZDate objects in the course timezone
        const startTime = new TZDate(year, month - 1, day, startHour, startMinute, timezone);
        const endTime = new TZDate(year, month - 1, day, endHour, endMinute, timezone);

        icsEvents.push({
          uid: `lab-meeting-${meeting.id}`,
          title: labSection.name,
          description: meeting.notes || labSection.description || undefined,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          location: labSection.meeting_location || undefined,
          allDay: false,
          timezone
        });
      }
    }

    // 5. Add class section meetings (if classSection param provided)
    if (classSection && classSection.meeting_times && course.start_date && course.end_date) {
      // Parse meeting_times string (e.g., "MWF 10:00-11:00" or "T/R 2:30pm-3:30pm")
      const parsed = parseClassSectionMeetingTimes(classSection.meeting_times);

      if (parsed.days.length > 0 && parsed.startTime && parsed.endTime) {
        // Generate events for each day of the week from start_date to end_date
        const startDate = new Date(course.start_date);
        const endDate = new Date(course.end_date);

        // Day of week mapping (0 = Sunday, 1 = Monday, etc.)
        const dayOfWeekMap: Record<string, number> = {
          sunday: 0,
          monday: 1,
          tuesday: 2,
          wednesday: 3,
          thursday: 4,
          friday: 5,
          saturday: 6
        };

        // Parse time strings
        const [startHour, startMinute] = parsed.startTime.split(":").map(Number);
        const [endHour, endMinute] = parsed.endTime.split(":").map(Number);

        // Generate events for each occurrence
        const currentDate = new Date(startDate);
        let eventCount = 0;
        const maxEvents = 200; // Limit to prevent excessive events

        while (currentDate <= endDate && eventCount < maxEvents) {
          const dayOfWeek = currentDate.getDay();
          const dayName = Object.keys(dayOfWeekMap).find((key) => dayOfWeekMap[key] === dayOfWeek);

          // Check if this day matches any of the parsed days
          if (dayName && parsed.days.includes(dayName)) {
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth();
            const day = currentDate.getDate();

            // Create TZDate objects in the course timezone
            const startTime = new TZDate(year, month, day, startHour, startMinute, timezone);
            const endTime = new TZDate(year, month, day, endHour, endMinute, timezone);

            icsEvents.push({
              uid: `class-meeting-${classSection.id}-${currentDate.toISOString().split("T")[0]}`,
              title: classSection.name,
              description: undefined,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              location: classSection.meeting_location || undefined,
              allDay: false,
              timezone
            });

            eventCount++;
          }

          // Move to next day
          currentDate.setDate(currentDate.getDate() + 1);
        }
      }
    }

    // Generate ICS content
    const icsContent = generateICS(icsEvents, calendarName);

    // Find most recent update time for Last-Modified header
    const updateTimes: Date[] = [];
    if (calendarEvents.length > 0) {
      updateTimes.push(...calendarEvents.map((e) => new Date(e.updated_at)));
    }
    if (assignments.length > 0) {
      updateTimes.push(...assignments.map((a) => new Date(a.updated_at || a.created_at)));
    }
    if (labMeetings.length > 0) {
      updateTimes.push(...labMeetings.map((m) => new Date(m.updated_at || m.created_at)));
    }
    if (classSection) {
      updateTimes.push(new Date(classSection.created_at));
    }
    const lastModified =
      updateTimes.length > 0 ? new Date(Math.max(...updateTimes.map((d) => d.getTime()))) : new Date();

    // Return ICS file with proper headers
    return new NextResponse(icsContent, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
        "Last-Modified": lastModified.toUTCString(),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  } catch (error) {
    console.error("Error generating ICS calendar:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
