"use client";

import { Box, Button, Card, Heading, HStack, Icon, Link, Text, VStack } from "@chakra-ui/react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsCameraVideo } from "react-icons/bs";
import { useMemo, useState, useEffect, useRef } from "react";
import { useDaySchedule, useAllCalendarEvents, CalendarEvent } from "@/hooks/useCalendarEvents";
import { format, isSameDay } from "date-fns";
import { isUrl, CalendarColorPalette } from "./calendar-utils";
import { useCalendarColorsFromEvents } from "./CalendarColorContext";
import { calculateEventLayouts, formatTime, EventLayout } from "./calendar-layout-utils";

const HOUR_HEIGHT = 60; // pixels per hour
const START_HOUR = 8; // 8 AM
const END_HOUR = 22; // 10 PM
const TOTAL_HOURS = END_HOUR - START_HOUR;
const LEFT_OFFSET = 60; // Space for time labels

interface EventBlockProps {
  event: CalendarEvent;
  layout: EventLayout;
  getOfficeHoursColor: (queueName: string | null | undefined) => CalendarColorPalette;
}

function EventBlock({ event, layout, getOfficeHoursColor }: EventBlockProps) {
  const { top, height, left, width } = layout;
  const colors = getOfficeHoursColor(event.queue_name);

  // Ensure we have valid colors (fallback to semantic colors)
  const bgColor = colors.bg || "blue.subtle";
  const bgDarkColor = colors.bgDark || "blue.muted";
  const borderColor = colors.border || "blue.500";
  const accentColor = colors.accent || borderColor;

  // Adaptive layout based on event height
  // Very short events (< 35px): Single line with name only, minimal padding
  // Short events (35-50px): Name and time stacked tightly
  // Normal events (50-75px): Name, time
  // Tall events (> 75px): Full details including location
  const isVeryShort = height < 35;
  const isShort = height >= 35 && height < 50;
  const isTall = height >= 75;

  // Adaptive padding: less padding for shorter events
  const padding = isVeryShort ? 1 : isShort ? 1.5 : 2;

  // Calculate right padding for queue badge
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
      _hover={{
        opacity: 0.95,
        boxShadow: "sm"
      }}
      zIndex={1}
      display="flex"
      flexDirection="column"
      boxSizing="border-box"
      title={`${event.title}${event.organizer_name && event.uid?.startsWith("lab-meeting-") ? `\n👤 ${event.organizer_name}` : ""}\n${formatTime(event.start_time)} - ${formatTime(event.end_time)}${event.queue_name ? `\n${event.queue_name}` : ""}${event.location ? `\n📍 ${event.location}` : ""}`}
    >
      {/* Floating queue badge at top-right */}
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
        // Very short events: Single line with name and time
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
        // Short events: Name and time stacked tightly
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
          {event.organizer_name && event.uid?.startsWith("lab-meeting-") && (
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
          {event.location && (
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
              📍 {event.location}
            </Text>
          )}
        </VStack>
      ) : (
        // Normal and tall events: Full layout
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
          {event.organizer_name && event.uid?.startsWith("lab-meeting-") && (
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
          {/* 15-minute markers */}
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

function CurrentTimeIndicator() {
  const [now, setNow] = useState(new Date());
  const indicatorRef = useRef<HTMLDivElement>(null);

  // Update time every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // Scroll into view on mount
  useEffect(() => {
    if (indicatorRef.current) {
      indicatorRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  const currentHour = now.getHours() + now.getMinutes() / 60;

  // Only show if within visible range
  if (currentHour < START_HOUR || currentHour > END_HOUR) {
    return null;
  }

  const top = (currentHour - START_HOUR) * HOUR_HEIGHT;

  return (
    <Box
      ref={indicatorRef}
      position="absolute"
      top={`${top}px`}
      left="0"
      right="0"
      height="2px"
      bg="red.500"
      zIndex={10}
    >
      <Box
        position="absolute"
        left="50px"
        top="-10px"
        bg="red.500"
        color="white"
        fontSize="xs"
        px={2}
        py={0.5}
        borderRadius="full"
        fontWeight="medium"
      >
        {format(now, "h:mm a")}
      </Box>
    </Box>
  );
}

interface CalendarDayViewProps {
  showTitle?: boolean;
}

export default function CalendarDayView({ showTitle = true }: CalendarDayViewProps) {
  const [dayOffset, setDayOffset] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const cardBodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800); // Default width

  const selectedDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    return date;
  }, [dayOffset]);

  // Get all events for color assignment (ensures consistent colors across days)
  const allEvents = useAllCalendarEvents();
  const events = useDaySchedule(selectedDate);

  // Get color functions from the hook - use office hours color scheme for all events (per-queue)
  const { getOfficeHoursColor, officeHoursColorMap } = useCalendarColorsFromEvents(allEvents);

  const isToday = useMemo(() => isSameDay(selectedDate, new Date()), [selectedDate]);

  const dateText = useMemo(() => {
    if (isToday) {
      return `Today: ${format(selectedDate, "EEEE, MMMM d, yyyy")}`;
    }
    return format(selectedDate, "EEEE, MMMM d, yyyy");
  }, [selectedDate, isToday]);

  // Calculate event layouts with side-by-side overlapping
  const eventLayouts = useMemo(() => {
    return calculateEventLayouts(events, containerWidth, START_HOUR, END_HOUR, LEFT_OFFSET, 30);
  }, [events, containerWidth]);

  // Get unique queues for legend with event counts for the selected day
  const queueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    events.forEach((event) => {
      if (event.queue_name) {
        counts.set(event.queue_name, (counts.get(event.queue_name) || 0) + 1);
      }
    });
    return counts;
  }, [events]);

  // Get unique queues for legend (in color assignment order, filtered to only show queues with events today)
  const uniqueQueues = useMemo(() => {
    // Filter to only queues that have events on the selected day
    return Array.from(officeHoursColorMap.keys()).filter((queueName) => queueCounts.has(queueName));
  }, [officeHoursColorMap, queueCounts]);

  // Update container width on resize - measure the Card.Body to get full available width
  useEffect(() => {
    const updateWidth = () => {
      // Measure the Card.Body width to get the full available space
      // This accounts for any padding/margins on the Card
      if (cardBodyRef.current) {
        const bodyWidth = cardBodyRef.current.clientWidth;
        // Use the body width as it represents the full available space
        setContainerWidth(bodyWidth);
      } else if (containerRef.current) {
        // Fallback: use the scrollable container's clientWidth
        setContainerWidth(containerRef.current.clientWidth);
      }
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    if (cardBodyRef.current) {
      resizeObserver.observe(cardBodyRef.current);
    }
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Auto-scroll to current time on mount
  useEffect(() => {
    if (containerRef.current && isToday) {
      const now = new Date();
      const currentHour = now.getHours() + now.getMinutes() / 60;
      if (currentHour >= START_HOUR && currentHour <= END_HOUR) {
        const scrollTop = (currentHour - START_HOUR - 2) * HOUR_HEIGHT; // Show 2 hours before
        containerRef.current.scrollTop = Math.max(0, scrollTop);
      }
    }
  }, [isToday]);

  return (
    <Card.Root width="100%">
      <Card.Body ref={cardBodyRef} width="100%">
        <VStack align="stretch" gap={4}>
          {/* Header */}
          <HStack justify="space-between" wrap="wrap" gap={2}>
            <HStack gap={2}>
              <Icon as={BsCalendar} color="blue.500" />
              {showTitle && <Heading size="sm">{isToday ? "Today's Schedule" : "Schedule"}</Heading>}
            </HStack>

            <HStack gap={2}>
              {/* Day navigation */}
              <HStack gap={1}>
                <Button size="xs" variant="ghost" onClick={() => setDayOffset(dayOffset - 1)} aria-label="Previous day">
                  <Icon as={BsChevronLeft} />
                </Button>
                <Button size="xs" variant="outline" onClick={() => setDayOffset(0)} disabled={dayOffset === 0}>
                  Today
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setDayOffset(dayOffset + 1)} aria-label="Next day">
                  <Icon as={BsChevronRight} />
                </Button>
              </HStack>
            </HStack>
          </HStack>

          {/* Date */}
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            {dateText}
          </Text>

          {/* Legend */}
          <HStack justify="center" wrap="wrap" gap={3} fontSize="xs">
            {uniqueQueues.length > 0 ? (
              uniqueQueues.map((queueName) => {
                const colors = getOfficeHoursColor(queueName);
                const count = queueCounts.get(queueName) || 0;
                return (
                  <HStack key={queueName} gap={1}>
                    <Box w={3} h={3} bg={colors.legend || colors.border} borderRadius="sm" />
                    <Text color="fg.muted">
                      {queueName} {count > 1 && `(${count})`}
                    </Text>
                  </HStack>
                );
              })
            ) : (
              <Text color="fg.muted" fontSize="xs" fontStyle="italic">
                No events scheduled for this day
              </Text>
            )}
          </HStack>

          {/* Timeline */}
          <Box
            ref={containerRef}
            position="relative"
            width="100%"
            height="400px"
            overflowY="auto"
            borderWidth="1px"
            borderRadius="md"
          >
            <Box
              ref={timelineRef}
              position="relative"
              width="100%"
              height={`${TOTAL_HOURS * HOUR_HEIGHT}px`}
              bg="bg.panel"
            >
              <TimeAxis />
              {isToday && <CurrentTimeIndicator />}

              {events.map((event) => {
                const layout = eventLayouts.get(event.id);
                if (!layout) return null;
                return (
                  <EventBlock key={event.id} event={event} layout={layout} getOfficeHoursColor={getOfficeHoursColor} />
                );
              })}

              {events.length === 0 && (
                <VStack position="absolute" top="50%" left="50%" transform="translate(-50%, -50%)">
                  <Text color="fg.muted" fontSize="sm">
                    No events scheduled for this day
                  </Text>
                </VStack>
              )}
            </Box>
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
