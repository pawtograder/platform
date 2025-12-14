"use client";

import { CalendarEvent, useCalendarEditUrls, useWeekSchedule } from "@/hooks/useCalendarEvents";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Box, Button, Card, Grid, Heading, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { addDays, format, isSameDay, parseISO, startOfWeek } from "date-fns";
import Link from "next/link";
import { useMemo, useState } from "react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsPencil } from "react-icons/bs";

interface EventsByDay {
  [dateKey: string]: CalendarEvent[];
}

function getWeekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 0 }); // Sunday
}

function formatTime(dateStr: string): string {
  const date = parseISO(dateStr);
  return format(date, "h:mm a");
}

function formatDateRange(start: string, end: string): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

interface DayColumnProps {
  date: Date;
  events: CalendarEvent[];
  isToday: boolean;
}

function DayColumn({ date, events, isToday }: DayColumnProps) {
  const dayName = format(date, "EEE");
  const dayNumber = format(date, "d");
  const monthName = format(date, "MMM");

  return (
    <VStack align="stretch" minH="120px">
      <VStack gap={0} pb={2} borderBottomWidth="1px" borderColor={isToday ? "blue.400" : "border.muted"}>
        <Text fontSize="xs" color="fg.muted" textTransform="uppercase">
          {dayName}
        </Text>
        <HStack gap={1}>
          <Text fontSize="lg" fontWeight={isToday ? "bold" : "medium"} color={isToday ? "blue.500" : "fg.default"}>
            {dayNumber}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {monthName}
          </Text>
        </HStack>
      </VStack>

      <VStack align="stretch" gap={1} pt={1}>
        {events.length === 0 ? (
          <Text fontSize="xs" color="fg.muted" fontStyle="italic" py={2}>
            No office hours
          </Text>
        ) : (
          events.map((event) => (
            <Box
              key={event.id}
              bg="blue.50"
              _dark={{ bg: "blue.900" }}
              borderRadius="md"
              p={2}
              borderLeftWidth="3px"
              borderLeftColor="blue.400"
            >
              <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                {event.organizer_name || event.title}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {formatDateRange(event.start_time, event.end_time)}
              </Text>
              {event.location && (
                <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                  📍 {event.location}
                </Text>
              )}
              {event.queue_name && (
                <Text fontSize="xs" color="blue.500">
                  {event.queue_name}
                </Text>
              )}
            </Box>
          ))
        )}
      </VStack>
    </VStack>
  );
}

interface OfficeHoursScheduleProps {
  showTitle?: boolean;
  compact?: boolean;
}

export default function OfficeHoursSchedule({ showTitle = true }: OfficeHoursScheduleProps) {
  const [weekOffset, setWeekOffset] = useState(0);

  const isStaff = useIsGraderOrInstructor();
  const { officeHoursEditUrl } = useCalendarEditUrls();

  const weekStart = useMemo(() => {
    const today = new Date();
    const start = getWeekStart(today);
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset]);

  const events = useWeekSchedule(weekStart);

  // Group events by day
  const eventsByDay = useMemo(() => {
    const grouped: EventsByDay = {};

    // Initialize all days of the week
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const dateKey = format(date, "yyyy-MM-dd");
      grouped[dateKey] = [];
    }

    // Group events into their respective days
    events.forEach((event) => {
      const eventDate = parseISO(event.start_time);
      const dateKey = format(eventDate, "yyyy-MM-dd");
      if (grouped[dateKey]) {
        grouped[dateKey].push(event);
      }
    });

    // Sort events within each day by start time
    Object.keys(grouped).forEach((dateKey) => {
      grouped[dateKey].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    });

    return grouped;
  }, [events, weekStart]);

  const today = useMemo(() => new Date(), []);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [weekStart]);

  const weekRangeText = useMemo(() => {
    const weekEnd = addDays(weekStart, 6);
    const startMonth = format(weekStart, "MMM d");
    const endMonth = format(weekEnd, "MMM d, yyyy");
    return `${startMonth} - ${endMonth}`;
  }, [weekStart]);

  return (
    <Card.Root>
      <Card.Body>
        <VStack align="stretch" gap={4}>
          {/* Header */}
          <HStack justify="space-between" wrap="wrap" gap={2}>
            <HStack gap={2}>
              <Icon as={BsCalendar} color="blue.500" />
              {showTitle && <Heading size="sm">Office Hours Schedule</Heading>}
            </HStack>

            <HStack gap={2}>
              {/* Edit button for staff */}
              {isStaff && officeHoursEditUrl && (
                <Button size="xs" variant="ghost" colorPalette="blue" asChild>
                  <Link href={officeHoursEditUrl}>
                    <Icon as={BsPencil} mr={1} />
                    Edit Calendar
                  </Link>
                </Button>
              )}

              {/* Week navigation */}
              <HStack gap={1}>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setWeekOffset(weekOffset - 1)}
                  aria-label="Previous week"
                >
                  <Icon as={BsChevronLeft} />
                </Button>
                <Button size="xs" variant="outline" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>
                  Today
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setWeekOffset(weekOffset + 1)} aria-label="Next week">
                  <Icon as={BsChevronRight} />
                </Button>
              </HStack>
            </HStack>
          </HStack>

          {/* Week range */}
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            {weekRangeText}
          </Text>

          {/* Week grid */}
          <Grid templateColumns="repeat(7, 1fr)" gap={2}>
            {weekDays.map((date) => {
              const dateKey = format(date, "yyyy-MM-dd");
              const dayEvents = eventsByDay[dateKey] || [];
              const isToday = isSameDay(date, today);

              return <DayColumn key={dateKey} date={date} events={dayEvents} isToday={isToday} />;
            })}
          </Grid>

          {/* Show more button */}
          {events.length === 0 && (
            <Text fontSize="sm" color="fg.muted" textAlign="center" py={4}>
              No office hours scheduled for this week
            </Text>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
