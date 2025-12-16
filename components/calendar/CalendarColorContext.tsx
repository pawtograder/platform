"use client";

import { createContext, useContext, useMemo, ReactNode } from "react";
import { CalendarEvent } from "@/hooks/useCalendarEvents";
import { CalendarColorPalette, OFFICE_HOURS_COLORS, EVENTS_COLORS } from "./calendar-utils";

interface CalendarColorContextValue {
  /** Get the color for an event based on its queue name and type */
  getEventColor: (queueName: string | null | undefined, isOfficeHours: boolean) => CalendarColorPalette;
  /** Get the color for office hours only (convenience method) */
  getOfficeHoursColor: (queueName: string | null | undefined) => CalendarColorPalette;
  /** Map of office hours queue names to their assigned colors */
  officeHoursColorMap: Map<string, CalendarColorPalette>;
  /** Map of events queue names to their assigned colors */
  eventsColorMap: Map<string, CalendarColorPalette>;
}

const CalendarColorContext = createContext<CalendarColorContextValue | null>(null);

interface CalendarColorProviderProps {
  children: ReactNode;
  events: CalendarEvent[];
}

/**
 * Assigns colors to queue names in order of first appearance.
 * Returns a map of queue name -> color palette.
 */
function buildColorMap(
  events: CalendarEvent[],
  calendarType: "office_hours" | "events",
  colorPalette: CalendarColorPalette[]
): Map<string, CalendarColorPalette> {
  const colorMap = new Map<string, CalendarColorPalette>();
  let colorIndex = 0;

  // Sort events by start_time to ensure consistent ordering
  const sortedEvents = [...events]
    .filter((e) => e.calendar_type === calendarType)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  for (const event of sortedEvents) {
    const queueName = event.queue_name;
    if (queueName && !colorMap.has(queueName)) {
      // Assign next color in order (cycle if we run out)
      colorMap.set(queueName, colorPalette[colorIndex % colorPalette.length]);
      colorIndex++;
    }
  }

  return colorMap;
}

/**
 * Provider that pre-assigns colors to calendar queues in order.
 * No hashing - colors are assigned based on order of first appearance.
 */
export function CalendarColorProvider({ children, events }: CalendarColorProviderProps) {
  // Build color maps for both calendar types
  const officeHoursColorMap = useMemo(() => buildColorMap(events, "office_hours", OFFICE_HOURS_COLORS), [events]);

  const eventsColorMap = useMemo(() => buildColorMap(events, "events", EVENTS_COLORS), [events]);

  // Get color for an event
  const getEventColor = useMemo(() => {
    return (queueName: string | null | undefined, isOfficeHours: boolean): CalendarColorPalette => {
      const colorMap = isOfficeHours ? officeHoursColorMap : eventsColorMap;
      const defaultPalette = isOfficeHours ? OFFICE_HOURS_COLORS : EVENTS_COLORS;

      if (!queueName) {
        return defaultPalette[0];
      }

      const assignedColor = colorMap.get(queueName);
      if (assignedColor) {
        return assignedColor;
      }

      // Fallback: if queue wasn't in the initial events, use first available color
      return defaultPalette[0];
    };
  }, [officeHoursColorMap, eventsColorMap]);

  // Convenience method for office hours
  const getOfficeHoursColor = useMemo(() => {
    return (queueName: string | null | undefined): CalendarColorPalette => {
      return getEventColor(queueName, true);
    };
  }, [getEventColor]);

  const value: CalendarColorContextValue = {
    getEventColor,
    getOfficeHoursColor,
    officeHoursColorMap,
    eventsColorMap
  };

  return <CalendarColorContext.Provider value={value}>{children}</CalendarColorContext.Provider>;
}

/**
 * Hook to access calendar color functions.
 * Must be used within a CalendarColorProvider.
 */
export function useCalendarColors() {
  const context = useContext(CalendarColorContext);
  if (!context) {
    throw new Error("useCalendarColors must be used within a CalendarColorProvider");
  }
  return context;
}

/**
 * Hook that provides both the events and the color context.
 * Use this to wrap calendar components that need color support.
 */
export function useCalendarColorsFromEvents(events: CalendarEvent[]) {
  // Build color maps for both calendar types
  const officeHoursColorMap = useMemo(() => buildColorMap(events, "office_hours", OFFICE_HOURS_COLORS), [events]);

  const eventsColorMap = useMemo(() => buildColorMap(events, "events", EVENTS_COLORS), [events]);

  // Get color for an event
  const getEventColor = useMemo(() => {
    return (queueName: string | null | undefined, isOfficeHours: boolean): CalendarColorPalette => {
      const colorMap = isOfficeHours ? officeHoursColorMap : eventsColorMap;
      const defaultPalette = isOfficeHours ? OFFICE_HOURS_COLORS : EVENTS_COLORS;

      if (!queueName) {
        return defaultPalette[0];
      }

      const assignedColor = colorMap.get(queueName);
      if (assignedColor) {
        return assignedColor;
      }

      // Fallback: if queue wasn't in the initial events, use first available color
      return defaultPalette[0];
    };
  }, [officeHoursColorMap, eventsColorMap]);

  // Convenience method for office hours
  const getOfficeHoursColor = useMemo(() => {
    return (queueName: string | null | undefined): CalendarColorPalette => {
      return getEventColor(queueName, true);
    };
  }, [getEventColor]);

  return {
    getEventColor,
    getOfficeHoursColor,
    officeHoursColorMap,
    eventsColorMap
  };
}
