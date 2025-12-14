"use client";

import { useMemo } from "react";
import { useCourseController } from "./useCourseController";
import { useIsGraderOrInstructor } from "./useClassProfiles";
import { useTableControllerTableValues } from "@/lib/TableController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// Use database types for calendar events and staff settings
export type CalendarEvent = Database["public"]["Tables"]["calendar_events"]["Row"];
export type ClassStaffSetting = Database["public"]["Tables"]["class_staff_settings"]["Row"];

/**
 * Hook to get all calendar events using TableController
 * Automatically handles realtime updates via ClassRealTimeController
 */
export function useCalendarEvents() {
  const controller = useCourseController();
  const events = useTableControllerTableValues(controller.calendarEvents) as CalendarEvent[];
  return events;
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

/**
 * Hook to fetch calendar edit URLs from class_staff_settings
 * Only returns data for staff members (RLS enforced)
 */
export function useCalendarEditUrls() {
  const isStaff = useIsGraderOrInstructor();
  const settings = useClassStaffSettings();

  const urls = useMemo(() => {
    if (!isStaff) {
      return { officeHoursEditUrl: null, eventsEditUrl: null };
    }

    const ohSetting = settings.find((s) => s.setting_key === "office_hours_calendar_edit_url");
    const evSetting = settings.find((s) => s.setting_key === "events_calendar_edit_url");

    return {
      officeHoursEditUrl: ohSetting?.setting_value || null,
      eventsEditUrl: evSetting?.setting_value || null
    };
  }, [isStaff, settings]);

  return { ...urls };
}
