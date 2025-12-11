"use client";

import { Box, Button, Card, Heading, HStack, Icon, Spinner, Text, VStack } from "@chakra-ui/react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsPencil } from "react-icons/bs";
import { useMemo, useState, useEffect, useRef } from "react";
import { useDaySchedule, useCalendarEditUrls, CalendarEvent } from "@/hooks/useCalendarEvents";
import { format, parseISO, isSameDay } from "date-fns";

const HOUR_HEIGHT = 60; // pixels per hour
const START_HOUR = 8; // 8 AM
const END_HOUR = 22; // 10 PM
const TOTAL_HOURS = END_HOUR - START_HOUR;

function getEventPosition(event: CalendarEvent) {
  const start = parseISO(event.start_time);
  const end = parseISO(event.end_time);

  const startHour = start.getHours() + start.getMinutes() / 60;
  const endHour = end.getHours() + end.getMinutes() / 60;

  // Clamp to visible range
  const clampedStart = Math.max(startHour, START_HOUR);
  const clampedEnd = Math.min(endHour, END_HOUR);

  const top = (clampedStart - START_HOUR) * HOUR_HEIGHT;
  const height = (clampedEnd - clampedStart) * HOUR_HEIGHT;

  return { top, height: Math.max(height, 30) }; // Minimum height of 30px
}

function formatTime(dateStr: string): string {
  const date = parseISO(dateStr);
  return format(date, "h:mm a");
}

interface EventBlockProps {
  event: CalendarEvent;
}

function EventBlock({ event }: EventBlockProps) {
  const { top, height } = getEventPosition(event);
  const isOfficeHours = event.calendar_type === "office_hours";

  return (
    <Box
      position="absolute"
      top={`${top}px`}
      height={`${height}px`}
      left="60px"
      right="8px"
      bg={isOfficeHours ? "blue.100" : "orange.100"}
      _dark={{ bg: isOfficeHours ? "blue.800" : "orange.800" }}
      borderRadius="md"
      borderLeftWidth="4px"
      borderLeftColor={isOfficeHours ? "blue.500" : "orange.500"}
      p={2}
      overflow="hidden"
      cursor="default"
      _hover={{ opacity: 0.9 }}
    >
      <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
        {event.organizer_name || event.title}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {formatTime(event.start_time)} - {formatTime(event.end_time)}
      </Text>
      {event.location && height > 50 && (
        <Text fontSize="xs" color="fg.muted" lineClamp={1}>
          📍 {event.location}
        </Text>
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

  const { officeHoursEditUrl, eventsEditUrl } = useCalendarEditUrls();

  const selectedDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    return date;
  }, [dayOffset]);

  const { events, isLoading, error } = useDaySchedule(selectedDate);

  const isToday = useMemo(() => isSameDay(selectedDate, new Date()), [selectedDate]);

  const dateText = useMemo(() => {
    if (isToday) {
      return `Today: ${format(selectedDate, "EEEE, MMMM d, yyyy")}`;
    }
    return format(selectedDate, "EEEE, MMMM d, yyyy");
  }, [selectedDate, isToday]);

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
  }, [isToday, isLoading]);

  if (isLoading) {
    return (
      <Card.Root>
        <Card.Body>
          <VStack py={8}>
            <Spinner />
            <Text color="fg.muted">Loading schedule...</Text>
          </VStack>
        </Card.Body>
      </Card.Root>
    );
  }

  if (error) {
    return (
      <Card.Root>
        <Card.Body>
          <Text color="red.500">Error loading schedule: {error}</Text>
        </Card.Body>
      </Card.Root>
    );
  }

  return (
    <Card.Root>
      <Card.Body>
        <VStack align="stretch" gap={4}>
          {/* Header */}
          <HStack justify="space-between" wrap="wrap" gap={2}>
            <HStack gap={2}>
              <Icon as={BsCalendar} color="blue.500" />
              {showTitle && <Heading size="sm">Today&apos;s Schedule</Heading>}
            </HStack>

            <HStack gap={2}>
              {/* Edit buttons */}
              {officeHoursEditUrl && (
                <Button
                  as="a"
                  href={officeHoursEditUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  variant="ghost"
                  colorPalette="blue"
                >
                  <Icon as={BsPencil} mr={1} />
                  Edit OH
                </Button>
              )}
              {eventsEditUrl && (
                <Button
                  as="a"
                  href={eventsEditUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  variant="ghost"
                  colorPalette="orange"
                >
                  <Icon as={BsPencil} mr={1} />
                  Edit Events
                </Button>
              )}

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
          <HStack justify="center" gap={4} fontSize="xs">
            <HStack gap={1}>
              <Box w={3} h={3} bg="blue.500" borderRadius="sm" />
              <Text color="fg.muted">Office Hours</Text>
            </HStack>
            <HStack gap={1}>
              <Box w={3} h={3} bg="orange.500" borderRadius="sm" />
              <Text color="fg.muted">Events</Text>
            </HStack>
          </HStack>

          {/* Timeline */}
          <Box
            ref={containerRef}
            position="relative"
            height="400px"
            overflowY="auto"
            borderWidth="1px"
            borderRadius="md"
          >
            <Box position="relative" height={`${TOTAL_HOURS * HOUR_HEIGHT}px`} bg="bg.panel">
              <TimeAxis />
              {isToday && <CurrentTimeIndicator />}

              {events.map((event) => (
                <EventBlock key={event.id} event={event} />
              ))}

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
