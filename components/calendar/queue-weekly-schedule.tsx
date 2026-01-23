"use client";

import { CalendarEvent, useWeekSchedule, useOfficeHoursSchedule } from "@/hooks/useCalendarEvents";
import { Box, Button, Card, Grid, Heading, HStack, Icon, Link, Text, VStack } from "@chakra-ui/react";
import { addDays, format, isSameDay, parseISO, startOfWeek } from "date-fns";
import { useMemo, useState, useEffect } from "react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsCameraVideo } from "react-icons/bs";
import { isUrl, CalendarColorPalette, isEventCurrentlyHappening } from "./calendar-utils";
import { useCalendarColorsFromEvents, getResolvedQueueName } from "./CalendarColorContext";
import { useHelpQueues } from "@/hooks/useOfficeHoursRealtime";

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
  getOfficeHoursColor: (queueName: string | null | undefined) => CalendarColorPalette;
}

function DayColumn({ date, events, isToday, getOfficeHoursColor }: DayColumnProps) {
  const dayName = format(date, "EEE");
  const dayNumber = format(date, "d");
  const monthName = format(date, "MMM");
  const helpQueues = useHelpQueues();
  const [now, setNow] = useState(new Date());

  // Update current time every minute to check if event is active
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

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
          events.map((event) => {
            const resolvedQueueName = getResolvedQueueName(event, helpQueues);
            const colors = getOfficeHoursColor(resolvedQueueName);
            const isCurrentlyHappening = isEventCurrentlyHappening(event.start_time, event.end_time, now);
            return (
              <Box
                key={event.id}
                bg={colors.bg}
                _dark={{ bg: colors.bgDark }}
                borderRadius="md"
                p={2}
                borderWidth={isCurrentlyHappening ? "2px" : "1px"}
                borderColor={isCurrentlyHappening ? "green.500" : colors.border}
                borderLeftWidth="3px"
                borderLeftColor={isCurrentlyHappening ? "green.600" : colors.accent}
                boxShadow={isCurrentlyHappening ? "0 0 0 2px rgba(34, 197, 94, 0.2)" : undefined}
              >
                <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                  {event.organizer_name || event.title}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {formatDateRange(event.start_time, event.end_time)}
                </Text>
                {event.location &&
                  (isUrl(event.location) ? (
                    <Link
                      href={event.location}
                      target="_blank"
                      rel="noopener noreferrer"
                      fontSize="xs"
                      color={colors.accent}
                      fontWeight="medium"
                      display="flex"
                      alignItems="center"
                      gap={1}
                      _hover={{ textDecoration: "underline" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Icon as={BsCameraVideo} boxSize={3} />
                      Join virtual call
                    </Link>
                  ) : (
                    <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                      📍 {event.location}
                    </Text>
                  ))}
              </Box>
            );
          })
        )}
      </VStack>
    </VStack>
  );
}

interface QueueWeeklyScheduleProps {
  queueId: number;
  queueName: string;
  showTitle?: boolean;
}

export default function QueueWeeklySchedule({ queueId, queueName, showTitle = true }: QueueWeeklyScheduleProps) {
  const [weekOffset, setWeekOffset] = useState(0);

  const weekStart = useMemo(() => {
    const today = new Date();
    const start = getWeekStart(today);
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset]);

  // Get all office hours events for consistent color assignment
  const allOfficeHoursEvents = useOfficeHoursSchedule();
  const weekEvents = useWeekSchedule(weekStart);

  // Filter events for this specific queue
  const queueEvents = useMemo(() => {
    return weekEvents.filter(
      (event) =>
        event.resolved_help_queue_id === queueId ||
        (event.resolved_help_queue_id === null &&
          event.queue_name &&
          event.queue_name.toLowerCase() === queueName.toLowerCase())
    );
  }, [weekEvents, queueId, queueName]);

  // Get color functions from the hook (colors assigned in order, no hashing)
  const { getOfficeHoursColor } = useCalendarColorsFromEvents(allOfficeHoursEvents);

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
    queueEvents.forEach((event) => {
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
  }, [queueEvents, weekStart]);

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
              {showTitle && <Heading size="sm">{queueName} Schedule</Heading>}
            </HStack>

            <HStack gap={2}>
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
              const isToday = isSameDay(date, new Date());

              return (
                <DayColumn
                  key={dateKey}
                  date={date}
                  events={dayEvents}
                  isToday={isToday}
                  getOfficeHoursColor={getOfficeHoursColor}
                />
              );
            })}
          </Grid>

          {/* Show more button */}
          {queueEvents.length === 0 && (
            <Text fontSize="sm" color="fg.muted" textAlign="center" py={4}>
              No office hours scheduled for this queue this week
            </Text>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
