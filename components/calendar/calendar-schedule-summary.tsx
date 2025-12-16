"use client";

import { CalendarEvent, useAllCalendarEvents } from "@/hooks/useCalendarEvents";
import { Box, Button, Card, Flex, Heading, HStack, Icon, Link, Text, VStack } from "@chakra-ui/react";
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
  eachDayOfInterval,
  eachWeekOfInterval,
  isSameDay
} from "date-fns";
import { useMemo, useState, useEffect, useRef } from "react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsCameraVideo } from "react-icons/bs";
import { isUrl, CalendarColorPalette } from "./calendar-utils";
import { useCalendarColorsFromEvents } from "./CalendarColorContext";

type ViewMode = "today" | "week" | "month";

const HOUR_HEIGHT = 60; // pixels per hour
const START_HOUR = 8; // 8 AM
const END_HOUR = 22; // 10 PM
const TOTAL_HOURS = END_HOUR - START_HOUR;
const LEFT_OFFSET = 60; // Space for time labels
const RIGHT_PADDING = 8; // Right padding
const EVENT_GAP = 2; // Gap between side-by-side events

interface EventLayout {
  top: number;
  height: number;
  left: number;
  width: number;
  column: number;
}

function getEventTimeRange(event: CalendarEvent): { start: number; end: number } {
  const start = parseISO(event.start_time);
  const end = parseISO(event.end_time);

  const startHour = start.getHours() + start.getMinutes() / 60;
  const endHour = end.getHours() + end.getMinutes() / 60;

  return {
    start: Math.max(startHour, START_HOUR),
    end: Math.min(endHour, END_HOUR)
  };
}

function calculateEventLayouts(
  events: CalendarEvent[],
  containerWidth: number,
  leftOffset: number = LEFT_OFFSET
): Map<number, EventLayout> {
  const layouts = new Map<number, EventLayout>();

  if (events.length === 0) {
    return layouts;
  }

  // Sort events by start time, then by duration (shorter first for better packing)
  const sortedEvents = [...events].sort((a, b) => {
    const rangeA = getEventTimeRange(a);
    const rangeB = getEventTimeRange(b);
    if (rangeA.start !== rangeB.start) {
      return rangeA.start - rangeB.start;
    }
    return rangeB.end - rangeB.start - (rangeA.end - rangeA.start); // Longer events first
  });

  // Track which events are in which columns
  const eventColumns = new Map<number, number>();
  const columns: Array<Array<{ start: number; end: number }>> = []; // Each column contains event time ranges

  // Assign columns to events
  for (const event of sortedEvents) {
    const range = getEventTimeRange(event);

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
    const range = getEventTimeRange(event);

    // Find all events that overlap with this event
    const overlappingEvents = sortedEvents.filter((otherEvent) => {
      if (otherEvent.id === event.id) return false;
      const otherRange = getEventTimeRange(otherEvent);
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
          const otherRange = getEventTimeRange(otherEvent);
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
    const range = getEventTimeRange(event);
    const column = eventColumns.get(event.id) || 0;
    const eventWidth = eventWidths.get(event.id) || availableWidth;

    const top = (range.start - START_HOUR) * HOUR_HEIGHT;
    const height = Math.max((range.end - range.start) * HOUR_HEIGHT, 20); // Minimum height of 20px for compact view

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
          const otherRange = getEventTimeRange(otherEvent);
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

function formatTime(dateStr: string): string {
  const date = parseISO(dateStr);
  return format(date, "h:mm a");
}

interface TimelineEventBlockProps {
  event: CalendarEvent;
  layout: EventLayout;
  getEventColor: (queueName: string | null | undefined, isOfficeHours: boolean) => CalendarColorPalette;
}

function TimelineEventBlock({ event, layout, getEventColor }: TimelineEventBlockProps) {
  const { top, height, left, width } = layout;
  const isOfficeHours = event.calendar_type === "office_hours";
  const colors = getEventColor(event.queue_name, isOfficeHours);

  const bgColor = colors.bg || (isOfficeHours ? "blue.subtle" : "orange.subtle");
  const bgDarkColor = colors.bgDark || (isOfficeHours ? "blue.muted" : "orange.muted");
  const borderColor = colors.border || (isOfficeHours ? "blue.500" : "orange.500");
  const accentColor = colors.accent || borderColor;

  const isVeryShort = height < 35;
  const isShort = height >= 35 && height < 50;
  const isTall = height >= 75;
  const padding = isVeryShort ? 1 : isShort ? 1.5 : 2;
  const hasQueueBadge = !!event.queue_name;
  const contentPaddingRight = hasQueueBadge && !isVeryShort ? "50px" : undefined;

  return (
    <Box
      position="absolute"
      top={`${top}px`}
      left={`${left}px`}
      width={`${width}px`}
      height={`${height}px`}
      bg={bgColor}
      _dark={{ bg: bgDarkColor }}
      borderRadius="md"
      borderWidth="1px"
      borderColor={borderColor}
      borderLeftWidth="4px"
      borderLeftColor={accentColor}
      p={padding}
      overflow="hidden"
      cursor="default"
      _hover={{ opacity: 0.95, boxShadow: "sm" }}
      zIndex={1}
      display="flex"
      flexDirection="column"
      boxSizing="border-box"
      title={`${event.organizer_name || event.title}\n${formatTime(event.start_time)} - ${formatTime(event.end_time)}${event.queue_name ? `\n${event.queue_name}` : ""}${event.location ? `\n📍 ${event.location}` : ""}`}
    >
      {event.queue_name && !isVeryShort && (
        <Box
          position="absolute"
          top="4px"
          right="4px"
          bg={accentColor}
          color="white"
          fontSize="2xs"
          fontWeight="semibold"
          px={1.5}
          py={0.5}
          borderRadius="sm"
          maxW="45%"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          lineHeight="1.2"
          title={event.queue_name}
        >
          {event.queue_name}
        </Box>
      )}

      {isVeryShort ? (
        <Text
          fontSize="xs"
          fontWeight="medium"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          lineHeight="1.3"
          width="100%"
        >
          {event.title}
        </Text>
      ) : isShort ? (
        <VStack align="stretch" gap={0} flex={1} minH={0} overflow="hidden" width="100%" pr={contentPaddingRight}>
          <Text
            fontSize="xs"
            fontWeight="medium"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.2"
            width="100%"
            flexShrink={0}
          >
            {event.title}
          </Text>
          {event.organizer_name && (
            <Text
              fontSize="2xs"
              color="fg.muted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              lineHeight="1.2"
              width="100%"
              flexShrink={0}
            >
              👤 {event.organizer_name}
            </Text>
          )}
          <Text
            fontSize="2xs"
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.2"
            width="100%"
            flexShrink={0}
          >
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
        </VStack>
      ) : (
        <VStack align="stretch" gap={0.5} flex={1} minH={0} overflow="hidden" width="100%" pr={contentPaddingRight}>
          <Text
            fontSize="sm"
            fontWeight="medium"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.2"
            width="100%"
            flexShrink={0}
          >
            {event.title}
          </Text>
          {event.organizer_name && (
            <Text
              fontSize="xs"
              color="fg.muted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              lineHeight="1.2"
              width="100%"
              flexShrink={0}
            >
              👤 {event.organizer_name}
            </Text>
          )}
          <Text
            fontSize="xs"
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.2"
            width="100%"
            flexShrink={0}
          >
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
          {event.location &&
            isTall &&
            (isUrl(event.location) ? (
              <Link
                href={event.location}
                target="_blank"
                rel="noopener noreferrer"
                fontSize="xs"
                color={accentColor}
                fontWeight="medium"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                lineHeight="1.2"
                width="100%"
                display="flex"
                alignItems="center"
                gap={1}
                flexShrink={0}
                _hover={{ textDecoration: "underline" }}
                onClick={(e) => e.stopPropagation()}
              >
                <Icon as={BsCameraVideo} boxSize={3} />
                Join virtual call
              </Link>
            ) : (
              <Text
                fontSize="xs"
                color="fg.muted"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                lineHeight="1.2"
                width="100%"
                flexShrink={0}
              >
                📍 {event.location}
              </Text>
            ))}
        </VStack>
      )}
    </Box>
  );
}

function TimeAxis() {
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => START_HOUR + i);

  return (
    <>
      {hours.map((hour) => (
        <Box
          key={hour}
          position="absolute"
          top={`${(hour - START_HOUR) * HOUR_HEIGHT}px`}
          left="0"
          right="0"
          height={`${HOUR_HEIGHT}px`}
          borderTopWidth="1px"
          borderColor="border.muted"
        >
          <Text position="absolute" left="4px" top="-10px" fontSize="xs" color="fg.muted" bg="bg.panel" px={1}>
            {format(new Date().setHours(hour, 0), "h a")}
          </Text>
          {[15, 30, 45].map((minutes) => (
            <Box
              key={minutes}
              position="absolute"
              top={`${(minutes / 60) * HOUR_HEIGHT}px`}
              left={LEFT_OFFSET}
              right="0"
              height="1px"
              borderTopWidth="1px"
              borderColor="border.muted"
              opacity={0.3}
            />
          ))}
        </Box>
      ))}
    </>
  );
}

interface CompactDayColumnProps {
  date: Date;
  events: CalendarEvent[];
  getEventColor: (queueName: string | null | undefined, isOfficeHours: boolean) => CalendarColorPalette;
  isToday: boolean;
  useTimeline?: boolean;
  containerWidth?: number;
  eventLayouts?: Map<number, EventLayout>;
}

// Compact timeline event block for week view
function CompactTimelineEventBlock({ event, layout, getEventColor }: TimelineEventBlockProps) {
  const { top, height, left, width } = layout;
  const isOfficeHours = event.calendar_type === "office_hours";
  const colors = getEventColor(event.queue_name, isOfficeHours);

  const bgColor = colors.bg || (isOfficeHours ? "blue.subtle" : "orange.subtle");
  const bgDarkColor = colors.bgDark || (isOfficeHours ? "blue.muted" : "orange.muted");
  const borderColor = colors.border || (isOfficeHours ? "blue.500" : "orange.500");
  const accentColor = colors.accent || borderColor;

  const isVeryShort = height < 25;
  const isShort = height >= 25 && height < 40;
  const padding = isVeryShort ? 0.5 : isShort ? 1 : 1;
  const hasQueueBadge = !!event.queue_name && !isVeryShort;
  const contentPaddingRight = hasQueueBadge ? "35px" : undefined;

  return (
    <Box
      position="absolute"
      top={`${top}px`}
      left={`${left}px`}
      width={`${width}px`}
      height={`${height}px`}
      bg={bgColor}
      _dark={{ bg: bgDarkColor }}
      borderRadius="sm"
      borderWidth="1px"
      borderColor={borderColor}
      borderLeftWidth="3px"
      borderLeftColor={accentColor}
      p={padding}
      overflow="hidden"
      cursor="default"
      _hover={{ opacity: 0.95 }}
      zIndex={1}
      display="flex"
      flexDirection="column"
      boxSizing="border-box"
      title={`${event.title}${event.organizer_name ? `\n👤 ${event.organizer_name}` : ""}\n${formatTime(event.start_time)} - ${formatTime(event.end_time)}${event.queue_name ? `\n${event.queue_name}` : ""}${event.location ? `\n📍 ${event.location}` : ""}`}
    >
      {event.queue_name && !isVeryShort && (
        <Box
          position="absolute"
          top="2px"
          right="2px"
          bg={accentColor}
          color="white"
          fontSize="2xs"
          fontWeight="semibold"
          px={1}
          py={0}
          borderRadius="xs"
          maxW="35%"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          lineHeight="1.1"
          title={event.queue_name}
        >
          {event.queue_name}
        </Box>
      )}

      {isVeryShort ? (
        <Text
          fontSize="2xs"
          fontWeight="medium"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          lineHeight="1.2"
          width="100%"
        >
          {event.title}
        </Text>
      ) : isShort ? (
        <VStack align="stretch" gap={0} flex={1} minH={0} overflow="hidden" width="100%" pr={contentPaddingRight}>
          <Text
            fontSize="2xs"
            fontWeight="medium"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.1"
            width="100%"
            flexShrink={0}
          >
            {event.title}
          </Text>
          {event.organizer_name && (
            <Text
              fontSize="2xs"
              color="fg.muted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              lineHeight="1.1"
              width="100%"
              flexShrink={0}
            >
              👤 {event.organizer_name}
            </Text>
          )}
          <Text
            fontSize="2xs"
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.1"
            width="100%"
            flexShrink={0}
          >
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
        </VStack>
      ) : (
        <VStack align="stretch" gap={0} flex={1} minH={0} overflow="hidden" width="100%" pr={contentPaddingRight}>
          <Text
            fontSize="2xs"
            fontWeight="medium"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.1"
            width="100%"
            flexShrink={0}
          >
            {event.title}
          </Text>
          {event.organizer_name && (
            <Text
              fontSize="2xs"
              color="fg.muted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              lineHeight="1.1"
              width="100%"
              flexShrink={0}
            >
              👤 {event.organizer_name}
            </Text>
          )}
          <Text
            fontSize="2xs"
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            lineHeight="1.1"
            width="100%"
            flexShrink={0}
          >
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </Text>
          {event.location && (
            <Text
              fontSize="2xs"
              color="fg.muted"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              lineHeight="1.1"
              width="100%"
              flexShrink={0}
            >
              📍 {event.location}
            </Text>
          )}
        </VStack>
      )}
    </Box>
  );
}

// Compact timeline axis for week view - smaller left offset
const COMPACT_LEFT_OFFSET = 35; // Smaller space for time labels in compact view (exported for use in calculations)

function CompactTimeAxis() {
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => START_HOUR + i);

  return (
    <>
      {hours.map((hour) => (
        <Box
          key={hour}
          position="absolute"
          top={`${(hour - START_HOUR) * HOUR_HEIGHT}px`}
          left="0"
          width={`${COMPACT_LEFT_OFFSET}px`}
          height={`${HOUR_HEIGHT}px`}
          borderTopWidth="1px"
          borderColor="border.muted"
        >
          <Text position="absolute" left="2px" top="-8px" fontSize="2xs" color="fg.muted" bg="bg.panel" px={0.5}>
            {format(new Date().setHours(hour, 0), "h a")}
          </Text>
        </Box>
      ))}
    </>
  );
}

// Compact day column for week/month view - shows events in a vertical list OR timeline
// When useTimeline is true, this is just the day column (no time axis - that's shared)
function CompactDayColumn({
  date,
  events,
  getEventColor,
  isToday,
  useTimeline,
  containerWidth,
  eventLayouts
}: CompactDayColumnProps) {
  const dayName = format(date, "EEE");
  const dayNumber = format(date, "d");
  const monthName = format(date, "MMM");

  return (
    <VStack align="stretch" minH="200px" flex={1} gap={1}>
      {/* Day header */}
      <VStack gap={0} pb={1} borderBottomWidth="2px" borderColor={isToday ? "blue.500" : "border.muted"}>
        <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" fontWeight="medium">
          {dayName}
        </Text>
        <HStack gap={1} align="baseline">
          <Text fontSize="md" fontWeight={isToday ? "bold" : "semibold"} color={isToday ? "blue.500" : "fg.default"}>
            {dayNumber}
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            {monthName}
          </Text>
        </HStack>
      </VStack>

      {/* Events - timeline or list */}
      {useTimeline && eventLayouts && containerWidth ? (
        <Box
          position="relative"
          height={`${TOTAL_HOURS * HOUR_HEIGHT}px`}
          borderWidth="1px"
          borderRadius="sm"
          bg="bg.panel"
          flex={1}
        >
          {/* No CompactTimeAxis here - it's shared on the left */}
          {events.map((event) => {
            const layout = eventLayouts.get(event.id);
            if (!layout) return null;
            return (
              <CompactTimelineEventBlock key={event.id} event={event} layout={layout} getEventColor={getEventColor} />
            );
          })}
        </Box>
      ) : (
        <VStack align="stretch" gap={1} flex={1} overflowY="auto" maxH="400px">
          {events.length === 0 ? (
            <Text fontSize="2xs" color="fg.muted" fontStyle="italic" py={2} textAlign="center">
              No events
            </Text>
          ) : (
            events.map((event) => {
              const colors = getEventColor(event.queue_name, event.calendar_type === "office_hours");
              const start = parseISO(event.start_time);
              const end = parseISO(event.end_time);
              const accentColor = colors.accent || colors.border;

              return (
                <Box
                  key={event.id}
                  p={1.5}
                  borderRadius="sm"
                  borderWidth="1px"
                  borderColor={colors.border}
                  borderLeftWidth="3px"
                  borderLeftColor={accentColor}
                  bg={colors.bg}
                  _dark={{ bg: colors.bgDark }}
                  fontSize="2xs"
                >
                  <Text fontWeight="medium" fontSize="2xs" lineClamp={1} mb={0.5}>
                    {event.title}
                  </Text>
                  {event.organizer_name && (
                    <Text fontSize="2xs" color="fg.muted" lineClamp={1} mb={0.5}>
                      👤 {event.organizer_name}
                    </Text>
                  )}
                  <Text fontSize="2xs" color="fg.muted" lineHeight="1.2">
                    {format(start, "h:mm a")} - {format(end, "h:mm a")}
                  </Text>
                  {event.location && (
                    <Text fontSize="2xs" color="fg.muted" mt={0.5} lineClamp={1}>
                      📍 {event.location}
                    </Text>
                  )}
                  {event.queue_name && (
                    <Text fontSize="2xs" color={accentColor} fontWeight="medium" mt={0.5} lineClamp={1}>
                      {event.queue_name}
                    </Text>
                  )}
                </Box>
              );
            })
          )}
        </VStack>
      )}
    </VStack>
  );
}

interface EventsListProps {
  events: CalendarEvent[];
  viewMode: ViewMode;
  emptyMessage: string;
  getEventColor: (queueName: string | null | undefined, isOfficeHours: boolean) => CalendarColorPalette;
  startDate: Date;
  endDate: Date;
  containerRef?: React.RefObject<HTMLDivElement>;
}

function EventsList({
  events,
  viewMode,
  emptyMessage,
  getEventColor,
  startDate,
  endDate,
  containerRef: parentContainerRef
}: EventsListProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const weekContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Update container width on resize - measure the parent container for full available width
  useEffect(() => {
    const updateWidth = () => {
      // Prefer measuring the parent container (Card.Body) for full available width
      if (parentContainerRef?.current) {
        setContainerWidth(parentContainerRef.current.clientWidth);
      } else if (viewMode === "today" && containerRef.current) {
        // For today view, measure the scrollable container
        setContainerWidth(containerRef.current.clientWidth);
      } else if (viewMode === "week" && weekContainerRef.current) {
        // For week view, measure the HStack container
        setContainerWidth(weekContainerRef.current.clientWidth);
      } else if (containerRef.current) {
        // Fallback
        setContainerWidth(containerRef.current.clientWidth);
      }
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);

    if (parentContainerRef?.current) {
      resizeObserver.observe(parentContainerRef.current);
    }
    if (viewMode === "today" && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    } else if (viewMode === "week" && weekContainerRef.current) {
      resizeObserver.observe(weekContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [viewMode, parentContainerRef]);

  // Sort events by start time
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [events]);

  // Group by date for week/month views
  const groupedEvents = useMemo(() => {
    if (viewMode === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return { [format(today, "yyyy-MM-dd")]: sortedEvents };
    }

    const groups: Record<string, CalendarEvent[]> = {};
    for (const event of sortedEvents) {
      const dateKey = format(parseISO(event.start_time), "yyyy-MM-dd");
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(event);
    }
    return groups;
  }, [sortedEvents, viewMode]);

  // Calculate layouts for today view (always compute, but only use if viewMode === "today")
  const todayDate = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }, []);
  const dayEvents = sortedEvents;
  const eventLayouts = useMemo(() => {
    return calculateEventLayouts(dayEvents, containerWidth);
  }, [dayEvents, containerWidth]);

  // Generate all days in the week (always compute, but only use if viewMode === "week")
  const weekDays = useMemo(() => {
    const days: Date[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return days;
  }, [startDate, endDate]);

  // Filter week days: only show weekends if they have events (always compute)
  const filteredWeekDays = useMemo(() => {
    return weekDays.filter((day) => {
      const dateKey = format(day, "yyyy-MM-dd");
      const dayEvents = groupedEvents[dateKey] || [];
      const dayOfWeek = day.getDay(); // 0 = Sunday, 6 = Saturday

      // Always show weekdays (Mon-Fri)
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        return true;
      }

      // Only show weekends if they have events
      return dayEvents.length > 0;
    });
  }, [weekDays, groupedEvents]);

  // Calculate column width for week view days (always compute)
  // Account for shared time axis on the left
  const weekDayColumnWidth = useMemo(() => {
    const numDays = filteredWeekDays.length;
    if (numDays === 0) return 200;
    const gapSpace = (numDays - 1) * 8; // 8px gap between columns
    const timeAxisWidth = COMPACT_LEFT_OFFSET;
    // Subtract time axis width from available width
    return Math.max(150, (containerWidth - timeAxisWidth - gapSpace) / numDays);
  }, [filteredWeekDays.length, containerWidth]);

  // Calculate layouts for each day in week view (always compute)
  // Use left offset of 0 since time axis is separate
  const weekDayLayouts = useMemo(() => {
    const layoutsMap = new Map<string, Map<number, EventLayout>>();
    filteredWeekDays.forEach((day) => {
      const dateKey = format(day, "yyyy-MM-dd");
      const dayEvents = groupedEvents[dateKey] || [];
      // Use left offset of 0 since the time axis is separate on the left
      const layouts = calculateEventLayouts(dayEvents, weekDayColumnWidth, 0);
      layoutsMap.set(dateKey, layouts);
    });

    return layoutsMap;
  }, [filteredWeekDays, groupedEvents, weekDayColumnWidth]);

  // Check if any weekends have events in the month (for month view)
  const hasWeekendEvents = useMemo(() => {
    for (const event of events) {
      const eventDate = parseISO(event.start_time);
      const dayOfWeek = eventDate.getDay();
      const eventMonth = eventDate.getMonth();
      const targetMonth = startDate.getMonth();

      // Check if it's a weekend (0 = Sunday, 6 = Saturday) in the target month
      if ((dayOfWeek === 0 || dayOfWeek === 6) && eventMonth === targetMonth) {
        return true;
      }
    }
    return false;
  }, [events, startDate]);

  // Generate weeks for month view with proper padding (always compute)
  const monthWeeks = useMemo(() => {
    const weeks = eachWeekOfInterval(
      { start: startDate, end: endDate },
      { weekStartsOn: 1 } // Monday
    );

    return weeks.map((weekStart) => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      let days = eachDayOfInterval({ start: weekStart, end: weekEnd });

      // Filter out weekends if no weekend events in the month
      if (!hasWeekendEvents) {
        days = days.filter((day) => {
          const dayOfWeek = day.getDay();
          return dayOfWeek >= 1 && dayOfWeek <= 5; // Only weekdays
        });
      }

      // Ensure each row has exactly 7 columns (or 5 if no weekends)
      // Pad with next month's days if needed
      const targetLength = hasWeekendEvents ? 7 : 5;
      while (days.length < targetLength) {
        const lastDay = days[days.length - 1];
        const nextDay = addDays(lastDay, 1);
        days.push(nextDay);
      }

      // Truncate if we have more than target (shouldn't happen, but safety check)
      return days.slice(0, targetLength);
    });
  }, [startDate, endDate, hasWeekendEvents]);

  if (events.length === 0) {
    return (
      <Box py={4} textAlign="center">
        <Text color="fg.muted" fontSize="sm">
          {emptyMessage}
        </Text>
      </Box>
    );
  }

  // Use timeline view for "today" mode
  if (viewMode === "today") {
    return (
      <Box
        ref={containerRef}
        position="relative"
        width="100%"
        height="300px"
        overflowY="auto"
        borderWidth="1px"
        borderRadius="md"
      >
        <Box ref={timelineRef} position="relative" width="100%" height={`${TOTAL_HOURS * HOUR_HEIGHT}px`} bg="bg.panel">
          <TimeAxis />
          {dayEvents.map((event) => {
            const layout = eventLayouts.get(event.id);
            if (!layout) return null;
            return <TimelineEventBlock key={event.id} event={event} layout={layout} getEventColor={getEventColor} />;
          })}
        </Box>
      </Box>
    );
  }

  // Week view - days side-by-side with compact timeline layout (shows overlapping events side-by-side)
  // Single shared time axis on the left
  if (viewMode === "week") {
    return (
      <HStack ref={weekContainerRef} align="flex-start" gap={0} overflowX="auto" width="100%">
        {/* Shared time axis on the left */}
        <Box
          position="relative"
          width={`${COMPACT_LEFT_OFFSET}px`}
          height={`${TOTAL_HOURS * HOUR_HEIGHT}px`}
          flexShrink={0}
          borderRightWidth="1px"
          borderColor="border.muted"
        >
          <CompactTimeAxis />
        </Box>

        {/* Day columns */}
        <HStack align="flex-start" gap={2} flex={1}>
          {filteredWeekDays.map((day) => {
            const dateKey = format(day, "yyyy-MM-dd");
            const dayEvents = groupedEvents[dateKey] || [];
            const dayEventLayouts = weekDayLayouts.get(dateKey) || new Map();
            const dayIsToday = isSameDay(day, todayDate);

            return (
              <CompactDayColumn
                key={dateKey}
                date={day}
                events={dayEvents}
                getEventColor={getEventColor}
                isToday={dayIsToday}
                useTimeline={true}
                containerWidth={weekDayColumnWidth}
                eventLayouts={dayEventLayouts}
              />
            );
          })}
        </HStack>
      </HStack>
    );
  }

  // Month view - rows of weeks with consistent column count
  // Single shared time axis on the left for each week row
  return (
    <VStack align="stretch" gap={3}>
      {monthWeeks.map((weekDays, weekIndex) => {
        // Calculate layouts for this week's events
        const weekEventLayouts = new Map<string, Map<number, EventLayout>>();
        const numDays = weekDays.length;
        const gapSpace = (numDays - 1) * 8; // 8px gap between columns
        const timeAxisWidth = COMPACT_LEFT_OFFSET;
        const dayColumnWidth = numDays > 0 ? Math.max(150, (containerWidth - timeAxisWidth - gapSpace) / numDays) : 200;

        weekDays.forEach((day) => {
          const dateKey = format(day, "yyyy-MM-dd");
          const dayEvents = groupedEvents[dateKey] || [];
          if (dayEvents.length > 0) {
            // Use left offset of 0 since the time axis is separate on the left
            weekEventLayouts.set(dateKey, calculateEventLayouts(dayEvents, dayColumnWidth, 0));
          }
        });

        return (
          <Box key={weekIndex}>
            <HStack align="flex-start" gap={0} overflowX="auto">
              {/* Shared time axis on the left */}
              <Box
                position="relative"
                width={`${COMPACT_LEFT_OFFSET}px`}
                height={`${TOTAL_HOURS * HOUR_HEIGHT}px`}
                flexShrink={0}
                borderRightWidth="1px"
                borderColor="border.muted"
              >
                <CompactTimeAxis />
              </Box>

              {/* Day columns */}
              <HStack align="flex-start" gap={2} flex={1}>
                {weekDays.map((day) => {
                  const dateKey = format(day, "yyyy-MM-dd");
                  const dayEvents = groupedEvents[dateKey] || [];
                  const dayIsToday = isSameDay(day, todayDate);

                  // Sort events by start time
                  const sortedDayEvents = [...dayEvents].sort(
                    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
                  );

                  const dayEventLayouts = weekEventLayouts.get(dateKey) || new Map();

                  return (
                    <CompactDayColumn
                      key={dateKey}
                      date={day}
                      events={sortedDayEvents}
                      getEventColor={getEventColor}
                      isToday={dayIsToday}
                      useTimeline={true}
                      containerWidth={dayColumnWidth}
                      eventLayouts={dayEventLayouts}
                    />
                  );
                })}
              </HStack>
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}

export default function CalendarScheduleSummary() {
  const [viewMode, setViewMode] = useState<ViewMode>("today");
  const [offset, setOffset] = useState(0);
  const cardBodyRef = useRef<HTMLDivElement>(null);

  const allEvents = useAllCalendarEvents();

  // Get color functions from the hook (colors assigned in order, no hashing)
  const { getEventColor, getOfficeHoursColor } = useCalendarColorsFromEvents(allEvents);

  // Calculate date range based on view mode and offset
  const { startDate, endDate, rangeLabel } = useMemo(() => {
    const today = new Date();
    let start: Date;
    let end: Date;
    let label: string;

    switch (viewMode) {
      case "today": {
        const targetDay = addDays(today, offset);
        start = new Date(targetDay);
        start.setHours(0, 0, 0, 0);
        end = new Date(targetDay);
        end.setHours(23, 59, 59, 999);
        label = offset === 0 ? "Today" : format(targetDay, "EEEE, MMMM d");
        break;
      }
      case "week": {
        const weekBase = addWeeks(today, offset);
        start = startOfWeek(weekBase, { weekStartsOn: 1 }); // Monday
        end = endOfWeek(weekBase, { weekStartsOn: 1 });
        label = offset === 0 ? "This Week" : `${format(start, "MMM d")} - ${format(end, "MMM d")}`;
        break;
      }
      case "month": {
        const monthBase = addMonths(today, offset);
        start = startOfMonth(monthBase);
        end = endOfMonth(monthBase);
        label = offset === 0 ? "This Month" : format(monthBase, "MMMM yyyy");
        break;
      }
    }

    return { startDate: start, endDate: end, rangeLabel: label };
  }, [viewMode, offset]);

  // Filter events for the selected date range
  const filteredEvents = useMemo(() => {
    return allEvents.filter((event) => {
      const eventStart = parseISO(event.start_time);
      const eventEnd = parseISO(event.end_time);
      // Event overlaps with range if it starts before range ends AND ends after range starts
      return eventStart <= endDate && eventEnd >= startDate;
    });
  }, [allEvents, startDate, endDate]);

  // Summary stats and legend data
  const stats = useMemo(() => {
    const officeHours = filteredEvents.filter((e) => e.calendar_type === "office_hours");
    const events = filteredEvents.filter((e) => e.calendar_type === "events");

    // Categorize events by source
    const assignments = filteredEvents.filter((e) => e.uid?.startsWith("assignment-"));
    const labMeetings = filteredEvents.filter((e) => e.uid?.startsWith("lab-meeting-"));
    const otherEvents = events.filter((e) => !e.uid?.startsWith("assignment-") && !e.uid?.startsWith("lab-meeting-"));

    // Get unique office hours queues
    const uniqueQueues = new Set<string>();
    officeHours.forEach((e) => {
      if (e.queue_name) {
        uniqueQueues.add(e.queue_name);
      }
    });

    return {
      total: filteredEvents.length,
      officeHoursCount: officeHours.length,
      eventsCount: events.length,
      assignmentsCount: assignments.length,
      labMeetingsCount: labMeetings.length,
      otherEventsCount: otherEvents.length,
      uniqueQueues: Array.from(uniqueQueues)
    };
  }, [filteredEvents]);

  const handlePrev = () => setOffset(offset - 1);
  const handleNext = () => setOffset(offset + 1);
  const handleReset = () => setOffset(0);
  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    setOffset(0);
  };

  const emptyMessage = useMemo(() => {
    switch (viewMode) {
      case "today":
        return "No events scheduled for today";
      case "week":
        return "No events scheduled this week";
      case "month":
        return "No events scheduled this month";
    }
  }, [viewMode]);

  return (
    <Card.Root width="100%">
      <Card.Header pb={2}>
        <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
          <HStack gap={2}>
            <Icon as={BsCalendar} color="blue.500" />
            <Heading size="sm">Schedule</Heading>
          </HStack>

          <HStack gap={2} />
        </Flex>
      </Card.Header>

      <Card.Body pt={0} ref={cardBodyRef}>
        <VStack align="stretch" gap={3}>
          {/* View mode tabs */}
          <HStack gap={1} justify="center">
            {(["today", "week", "month"] as ViewMode[]).map((mode) => (
              <Button
                key={mode}
                size="xs"
                variant={viewMode === mode ? "solid" : "ghost"}
                colorPalette={viewMode === mode ? "blue" : "gray"}
                onClick={() => handleViewChange(mode)}
                textTransform="capitalize"
              >
                {mode}
              </Button>
            ))}
          </HStack>

          {/* Navigation and range label */}
          <Flex justify="space-between" align="center">
            <Button size="xs" variant="ghost" onClick={handlePrev} aria-label="Previous">
              <Icon as={BsChevronLeft} />
            </Button>

            <HStack gap={2}>
              <Text fontSize="sm" fontWeight="medium">
                {rangeLabel}
              </Text>
              {offset !== 0 && (
                <Button size="xs" variant="outline" onClick={handleReset}>
                  {viewMode === "today" ? "Today" : viewMode === "week" ? "This Week" : "This Month"}
                </Button>
              )}
            </HStack>

            <Button size="xs" variant="ghost" onClick={handleNext} aria-label="Next">
              <Icon as={BsChevronRight} />
            </Button>
          </Flex>

          {/* Legend */}
          {stats.total > 0 && (
            <HStack justify="center" wrap="wrap" gap={3} fontSize="xs">
              {/* Office Hours Queues */}
              {stats.uniqueQueues.map((queueName) => {
                const colors = getOfficeHoursColor(queueName);
                return (
                  <HStack key={`queue-${queueName}`} gap={1}>
                    <Box w={3} h={3} bg={colors.legend || colors.border} borderRadius="sm" />
                    <Text color="fg.muted">{queueName}</Text>
                  </HStack>
                );
              })}

              {/* Assignments */}
              {stats.assignmentsCount > 0 && (
                <HStack gap={1}>
                  <Box w={3} h={3} bg="orange.500" borderRadius="sm" />
                  <Text color="fg.muted">
                    Assignments {stats.assignmentsCount > 1 && `(${stats.assignmentsCount})`}
                  </Text>
                </HStack>
              )}

              {/* Lab Sections */}
              {stats.labMeetingsCount > 0 && (
                <HStack gap={1}>
                  <Box w={3} h={3} bg="green.500" borderRadius="sm" />
                  <Text color="fg.muted">
                    Lab Sections {stats.labMeetingsCount > 1 && `(${stats.labMeetingsCount})`}
                  </Text>
                </HStack>
              )}

              {/* Other Events */}
              {stats.otherEventsCount > 0 && (
                <HStack gap={1}>
                  <Box w={3} h={3} bg="yellow.500" borderRadius="sm" />
                  <Text color="fg.muted">Events {stats.otherEventsCount > 1 && `(${stats.otherEventsCount})`}</Text>
                </HStack>
              )}
            </HStack>
          )}

          {/* Events list */}
          <Box maxH="600px" overflowY="auto" width="100%">
            <EventsList
              events={filteredEvents}
              viewMode={viewMode}
              emptyMessage={emptyMessage}
              getEventColor={getEventColor}
              startDate={startDate}
              endDate={endDate}
              containerRef={cardBodyRef}
            />
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
