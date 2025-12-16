"use client";

import { useMemo, useEffect, useState } from "react";
import { TZDate } from "@date-fns/tz";
import { useCourseController } from "./useCourseController";
import { useCourse } from "./useCourseController";
import { useTableControllerTableValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// Use database types for calendar events and staff settings
export type CalendarEvent = Database["public"]["Tables"]["calendar_events"]["Row"];
export type ClassStaffSetting = Database["public"]["Tables"]["class_staff_settings"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];
export type LabSection = Database["public"]["Tables"]["lab_sections"]["Row"];
export type LabSectionMeeting = Database["public"]["Tables"]["lab_section_meetings"]["Row"];

/**
 * Hook to get assignments as calendar events
 * Transforms assignments into CalendarEvent format for display
 * Creates events for both release dates and due dates
 */
function useAssignmentsAsEvents(): CalendarEvent[] {
  const controller = useCourseController();
  const assignments = useTableControllerTableValues(controller.assignments) as Assignment[];

  return useMemo(() => {
    const events: CalendarEvent[] = [];

    for (const assignment of assignments) {
      if (assignment.archived_at) continue;

      // Create event for release date if it exists
      if (assignment.release_date) {
        const releaseDate = new Date(assignment.release_date);
        // Use release_date as start_time, end_time is 1 hour after (for display purposes)
        const endTime = new Date(releaseDate);
        endTime.setHours(endTime.getHours() + 1);

        events.push({
          id: -assignment.id - 500000, // Negative ID offset for release dates
          class_id: assignment.class_id,
          calendar_type: "events",
          uid: `assignment-release-${assignment.id}`,
          title: `Released: ${assignment.title}`,
          description: assignment.description || null,
          start_time: releaseDate.toISOString(),
          end_time: endTime.toISOString(),
          location: null,
          queue_name: null,
          organizer_name: null,
          raw_ics_data: null,
          start_announced_at: null,
          end_announced_at: null,
          change_announced_at: null,
          created_at: assignment.created_at,
          updated_at: assignment.updated_at
        });
      }

      // Create event for due date if it exists
      if (assignment.due_date) {
        const dueDate = new Date(assignment.due_date);
        // Use due_date as end_time, start_time is 1 hour before (for display purposes)
        const startTime = new Date(dueDate);
        startTime.setHours(startTime.getHours() - 1);

        events.push({
          id: -assignment.id, // Negative ID to avoid conflicts with real calendar events
          class_id: assignment.class_id,
          calendar_type: "events",
          uid: `assignment-due-${assignment.id}`,
          title: `Due: ${assignment.title}`,
          description: assignment.description || null,
          start_time: startTime.toISOString(),
          end_time: dueDate.toISOString(),
          location: null,
          queue_name: null,
          organizer_name: null,
          raw_ics_data: null,
          start_announced_at: null,
          end_announced_at: null,
          change_announced_at: null,
          created_at: assignment.created_at,
          updated_at: assignment.updated_at
        });
      }
    }

    return events;
  }, [assignments]);
}

/**
 * Hook to get lab section meetings as calendar events
 * Transforms lab section meetings into CalendarEvent format for display
 * Properly handles timezone conversion using course timezone
 * Includes lab leader names and location
 */
function useLabSectionMeetingsAsEvents(): CalendarEvent[] {
  const controller = useCourseController();
  const course = useCourse();
  const labSections = useTableControllerTableValues(controller.labSections) as LabSection[];
  const labMeetings = useTableControllerTableValues(controller.labSectionMeetings) as LabSectionMeeting[];
  const supabase = createClient();
  const [labLeadersMap, setLabLeadersMap] = useState<Map<number, string[]>>(new Map());

  // Fetch lab section leaders
  useEffect(() => {
    const fetchLeaders = async () => {
      if (labSections.length === 0) {
        setLabLeadersMap(new Map());
        return;
      }

      const { data: leaders } = await supabase
        .from("lab_section_leaders")
        .select("lab_section_id, profile_id, profiles(name)")
        .in(
          "lab_section_id",
          labSections.map((s) => s.id)
        );

      if (leaders) {
        const map = new Map<number, string[]>();
        leaders.forEach((leader) => {
          const sectionId = leader.lab_section_id;
          const profileName = (leader.profiles as { name: string | null })?.name;
          if (profileName) {
            if (!map.has(sectionId)) {
              map.set(sectionId, []);
            }
            map.get(sectionId)!.push(profileName);
          }
        });
        setLabLeadersMap(map);
      }
    };

    fetchLeaders();
  }, [labSections, supabase]);

  return useMemo(() => {
    const sectionMap = new Map(labSections.map((section) => [section.id, section]));
    const events: CalendarEvent[] = [];
    const timeZone = course.time_zone || "America/New_York";

    for (const meeting of labMeetings) {
      if (meeting.cancelled) continue;

      const section = sectionMap.get(meeting.lab_section_id);
      if (!section || !section.start_time) continue;

      // Combine meeting_date with start_time and end_time from lab section
      // meeting_date is a date string (YYYY-MM-DD), start_time/end_time are time strings (HH:MM:SS or HH:MM)
      // Parse the date/time components and create TZDate objects in the course timezone
      // This ensures the time is interpreted correctly in the course's timezone
      const startTimeStr = section.start_time.length === 5 ? `${section.start_time}:00` : section.start_time; // Ensure HH:MM:SS format
      const endTimeStr = section.end_time
        ? section.end_time.length === 5
          ? `${section.end_time}:00`
          : section.end_time
        : startTimeStr;

      // Parse date components from meeting_date
      const [year, month, day] = meeting.meeting_date.split("-").map(Number);

      // Parse time components from start_time and end_time
      const [startHour, startMinute] = startTimeStr.split(":").map(Number);
      const [endHour, endMinute] = endTimeStr.split(":").map(Number);

      // Create TZDate objects using individual components (month is 0-indexed in Date constructor)
      // TZDate constructor: new TZDate(year, month, day, hour, minute, timezone)
      // This ensures the time is interpreted correctly in the course's timezone
      const startTime = new TZDate(
        year,
        month - 1, // TZDate uses 0-indexed months like Date
        day,
        startHour,
        startMinute,
        timeZone
      );

      const endTime = new TZDate(
        year,
        month - 1, // TZDate uses 0-indexed months like Date
        day,
        endHour,
        endMinute,
        timeZone
      );

      // Get lab leaders for this section
      const labLeaders = labLeadersMap.get(section.id) || [];
      const labLeaderNames = labLeaders.length > 0 ? labLeaders.join(", ") : null;

      // Build description with lab leaders and notes
      const descriptionParts: string[] = [];
      if (section.description) {
        descriptionParts.push(section.description);
      }
      if (meeting.notes) {
        descriptionParts.push(meeting.notes);
      }
      const description = descriptionParts.length > 0 ? descriptionParts.join("\n\n") : null;

      events.push({
        id: -meeting.id - 1000000, // Negative ID offset to avoid conflicts
        class_id: meeting.class_id,
        calendar_type: "events",
        uid: `lab-meeting-${meeting.id}`,
        title: section.name,
        description,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        location: section.meeting_location || null,
        queue_name: null,
        organizer_name: labLeaderNames, // Lab leader names
        raw_ics_data: null,
        start_announced_at: null,
        end_announced_at: null,
        change_announced_at: null,
        created_at: meeting.created_at,
        updated_at: meeting.updated_at
      });
    }

    return events;
  }, [labSections, labMeetings, course.time_zone, labLeadersMap]);
}

/**
 * Hook to get all calendar events using TableController
 * Automatically handles realtime updates via ClassRealTimeController
 * Now includes assignments and lab section meetings
 */
export function useCalendarEvents() {
  const controller = useCourseController();
  const calendarEvents = useTableControllerTableValues(controller.calendarEvents) as CalendarEvent[];
  const assignmentEvents = useAssignmentsAsEvents();
  const labMeetingEvents = useLabSectionMeetingsAsEvents();

  return useMemo(() => {
    // Merge all event sources
    return [...calendarEvents, ...assignmentEvents, ...labMeetingEvents];
  }, [calendarEvents, assignmentEvents, labMeetingEvents]);
}

/**
 * Hook to get office hours schedule events only
 * For students, this is what they see (filtered by RLS + TableController query)
 */
export function useOfficeHoursSchedule() {
  const events = useCalendarEvents();

  const officeHoursEvents = useMemo(() => {
    return events.filter((e) => e.calendar_type === "office_hours");
  }, [events]);

  return officeHoursEvents;
}

/**
 * Hook to get office hours events for a specific week
 */
export function useWeekSchedule(weekStart: Date) {
  const events = useOfficeHoursSchedule();

  const weekEnd = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 7);
    return end;
  }, [weekStart]);

  const filteredEvents = useMemo(() => {
    const startTs = weekStart.getTime();
    const endTs = weekEnd.getTime();

    return events.filter((event) => {
      const eventStart = new Date(event.start_time).getTime();
      const eventEnd = new Date(event.end_time).getTime();
      // Event overlaps with week if it starts before week ends AND ends after week starts
      return eventStart < endTs && eventEnd > startTs;
    });
  }, [events, weekStart, weekEnd]);

  return filteredEvents;
}

/**
 * Hook to get all calendar events (both types) for instructor dashboard
 * Staff-only (students will get empty array due to RLS)
 */
export function useAllCalendarEvents() {
  const events = useCalendarEvents();
  return events;
}

/**
 * Hook to get calendar events for a specific day
 */
export function useDaySchedule(date: Date) {
  const events = useAllCalendarEvents();

  // Use date string as dependency to avoid object reference issues
  const dateStr = date.toDateString();

  const dayStart = useMemo(() => {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    return start;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr]);

  const dayEnd = useMemo(() => {
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return end;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr]);

  const filteredEvents = useMemo(() => {
    const startTs = dayStart.getTime();
    const endTs = dayEnd.getTime();

    return events.filter((event: CalendarEvent) => {
      const eventStart = new Date(event.start_time).getTime();
      const eventEnd = new Date(event.end_time).getTime();
      // Event overlaps with day if it starts before day ends AND ends after day starts
      return eventStart < endTs && eventEnd > startTs;
    });
  }, [events, dayStart, dayEnd]);

  return filteredEvents;
}

/**
 * Hook to get class staff settings using TableController
 */
export function useClassStaffSettings() {
  const controller = useCourseController();
  const settings = useTableControllerTableValues(controller.classStaffSettings) as ClassStaffSetting[];
  return settings;
}
