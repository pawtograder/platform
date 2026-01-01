import { parseISO, format } from "date-fns";
import { CalendarEvent } from "@/hooks/useCalendarEvents";

export interface EventLayout {
  top: number;
  height: number;
  left: number;
  width: number;
  column: number;
}

// Constants used by the layout functions
const HOUR_HEIGHT = 60; // pixels per hour
const RIGHT_PADDING = 8; // Right padding
const EVENT_GAP = 2; // Gap between side-by-side events

/**
 * Calculates the time range for an event within the specified hour bounds.
 * @param event - The calendar event
 * @param startHour - The start hour of the visible range (e.g., 8 for 8 AM)
 * @param endHour - The end hour of the visible range (e.g., 22 for 10 PM)
 * @returns Object with start and end times in hours (as decimal numbers)
 */
export function getEventTimeRange(
  event: CalendarEvent,
  startHour: number,
  endHour: number
): { start: number; end: number } {
  const start = parseISO(event.start_time);
  const end = parseISO(event.end_time);

  const startHourDecimal = start.getHours() + start.getMinutes() / 60;
  const endHourDecimal = end.getHours() + end.getMinutes() / 60;

  return {
    start: Math.max(startHourDecimal, startHour),
    end: Math.min(endHourDecimal, endHour)
  };
}

/**
 * Calculates layout positions and sizes for calendar events.
 * Handles overlapping events by placing them side-by-side.
 * @param events - Array of calendar events
 * @param containerWidth - Width of the container in pixels
 * @param startHour - The start hour of the visible range (e.g., 8 for 8 AM)
 * @param endHour - The end hour of the visible range (e.g., 22 for 10 PM)
 * @param leftOffset - Left offset for time labels (default: 60)
 * @param minHeight - Minimum height for events in pixels (default: 20)
 * @returns Map of event IDs to their layout information
 */
export function calculateEventLayouts(
  events: CalendarEvent[],
  containerWidth: number,
  startHour: number,
  endHour: number,
  leftOffset: number = 60,
  minHeight: number = 20
): Map<number, EventLayout> {
  const layouts = new Map<number, EventLayout>();

  if (events.length === 0) {
    return layouts;
  }

  // Sort events by start time, then by duration (shorter first for better packing)
  const sortedEvents = [...events].sort((a, b) => {
    const rangeA = getEventTimeRange(a, startHour, endHour);
    const rangeB = getEventTimeRange(b, startHour, endHour);
    if (rangeA.start !== rangeB.start) {
      return rangeA.start - rangeB.start;
    }
    return rangeB.end - rangeB.start - (rangeA.end - rangeA.start); // Shorter events first
  });

  // Track which events are in which columns
  const eventColumns = new Map<number, number>();
  const columns: Array<Array<{ start: number; end: number }>> = []; // Each column contains event time ranges

  // Assign columns to events
  for (const event of sortedEvents) {
    const range = getEventTimeRange(event, startHour, endHour);

    // Find the first column where this event doesn't overlap with any existing event
    let assignedColumn = -1;
    for (let colIdx = 0; colIdx < columns.length; colIdx++) {
      const column = columns[colIdx];
      // Check if this event overlaps with any event in this column
      // Two events overlap if: event1.start < event2.end AND event1.end > event2.start
      const overlaps = column.some((existingRange) => {
        return range.start < existingRange.end && range.end > existingRange.start;
      });

      if (!overlaps) {
        assignedColumn = colIdx;
        break;
      }
    }

    // If no suitable column found, create a new one
    if (assignedColumn === -1) {
      assignedColumn = columns.length;
      columns.push([]);
    }

    // Add event to the assigned column
    columns[assignedColumn].push({ start: range.start, end: range.end });
    eventColumns.set(event.id, assignedColumn);
  }

  // Calculate available width for events
  const availableWidth = containerWidth - leftOffset - RIGHT_PADDING;

  // First pass: calculate width for each event based on max concurrent events during its time range
  const eventWidths = new Map<number, number>();

  for (const event of sortedEvents) {
    const range = getEventTimeRange(event, startHour, endHour);

    // Find all events that overlap with this event
    const overlappingEvents = sortedEvents.filter((otherEvent) => {
      if (otherEvent.id === event.id) return false;
      const otherRange = getEventTimeRange(otherEvent, startHour, endHour);
      return range.start < otherRange.end && range.end > otherRange.start;
    });

    // Calculate maximum concurrent events at any point during this event's time range
    // Sample at start, end, and midpoints to find the maximum
    const samplePoints = [
      range.start,
      range.end,
      (range.start + range.end) / 2,
      range.start + (range.end - range.start) * 0.25,
      range.start + (range.end - range.start) * 0.75
    ];

    let maxConcurrent = 1; // At least this event itself
    for (const sampleTime of samplePoints) {
      const concurrent =
        overlappingEvents.filter((otherEvent) => {
          const otherRange = getEventTimeRange(otherEvent, startHour, endHour);
          return sampleTime >= otherRange.start && sampleTime < otherRange.end;
        }).length + 1; // +1 for the current event
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }

    // Calculate width based on maximum concurrent events during this event's time range
    const eventWidth =
      maxConcurrent > 0 ? (availableWidth - (maxConcurrent - 1) * EVENT_GAP) / maxConcurrent : availableWidth;

    eventWidths.set(event.id, eventWidth);
  }

  // Second pass: calculate positions using the calculated widths
  for (const event of sortedEvents) {
    const range = getEventTimeRange(event, startHour, endHour);
    const column = eventColumns.get(event.id) || 0;
    const eventWidth = eventWidths.get(event.id) || availableWidth;

    const top = (range.start - startHour) * HOUR_HEIGHT;
    const height = Math.max((range.end - range.start) * HOUR_HEIGHT, minHeight);

    // Calculate left position: sum widths of events in previous columns that overlap with this event
    let leftOffsetForColumn = 0;
    for (let colIdx = 0; colIdx < column; colIdx++) {
      const columnEvents = columns[colIdx];
      // Check if any event in this column overlaps with current event
      const hasOverlap = columnEvents.some((colRange) => {
        return range.start < colRange.end && range.end > colRange.start;
      });
      if (hasOverlap) {
        // Find the event in this column that overlaps and use its width
        const overlappingEventInColumn = sortedEvents.find((otherEvent) => {
          const otherRange = getEventTimeRange(otherEvent, startHour, endHour);
          const otherColumn = eventColumns.get(otherEvent.id) || -1;
          return otherColumn === colIdx && range.start < otherRange.end && range.end > otherRange.start;
        });
        if (overlappingEventInColumn) {
          const otherWidth = eventWidths.get(overlappingEventInColumn.id) || eventWidth;
          leftOffsetForColumn += otherWidth + EVENT_GAP;
        } else {
          // Fallback: use current event's width
          leftOffsetForColumn += eventWidth + EVENT_GAP;
        }
      }
    }

    const left = leftOffset + leftOffsetForColumn;

    layouts.set(event.id, {
      top,
      height,
      left,
      width: eventWidth,
      column
    });
  }

  return layouts;
}

/**
 * Formats a date string to a time string (e.g., "2:30 PM").
 * @param dateStr - ISO date string
 * @returns Formatted time string
 */
export function formatTime(dateStr: string): string {
  const date = parseISO(dateStr);
  return format(date, "h:mm a");
}
