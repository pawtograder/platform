"use client";

import { CalendarEvent, useAllCalendarEvents, useCalendarEditUrls } from "@/hooks/useCalendarEvents";
import { Badge, Box, Button, Card, Flex, Heading, HStack, Icon, Spinner, Stack, Text, VStack } from "@chakra-ui/react";
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek
} from "date-fns";
import Link from "next/link";
import { useMemo, useState } from "react";
import { BsCalendar, BsChevronLeft, BsChevronRight, BsClock, BsGeoAlt, BsPencil } from "react-icons/bs";

type ViewMode = "today" | "week" | "month";

interface EventItemProps {
  event: CalendarEvent;
  showDate?: boolean;
}

function EventItem({ event, showDate = false }: EventItemProps) {
  const isOfficeHours = event.calendar_type === "office_hours";
  const startDate = parseISO(event.start_time);
  const endDate = parseISO(event.end_time);

  return (
    <Box
      p={2}
      borderRadius="md"
      borderLeftWidth="3px"
      borderLeftColor={isOfficeHours ? "blue.500" : "orange.500"}
      bg={isOfficeHours ? "blue.50" : "orange.50"}
      _dark={{ bg: isOfficeHours ? "blue.900/30" : "orange.900/30" }}
    >
      <Flex justify="space-between" align="start" gap={2}>
        <Box flex={1}>
          <Text fontSize="sm" fontWeight="medium">
            {event.organizer_name || event.title}
          </Text>
          <HStack gap={3} fontSize="xs" color="fg.muted" mt={0.5}>
            <HStack gap={1}>
              <Icon as={BsClock} />
              <Text>
                {showDate && `${format(startDate, "EEE, MMM d")} · `}
                {format(startDate, "h:mm a")} - {format(endDate, "h:mm a")}
              </Text>
            </HStack>
            {event.location && (
              <HStack gap={1}>
                <Icon as={BsGeoAlt} />
                <Text>{event.location}</Text>
              </HStack>
            )}
          </HStack>
        </Box>
        <Badge size="sm" colorPalette={isOfficeHours ? "blue" : "orange"}>
          {isOfficeHours ? "OH" : "Event"}
        </Badge>
      </Flex>
    </Box>
  );
}

interface EventsListProps {
  events: CalendarEvent[];
  viewMode: ViewMode;
  emptyMessage: string;
}

function EventsList({ events, viewMode, emptyMessage }: EventsListProps) {
  // Sort events by start time
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }, [events]);

  // Group by date for week/month views
  const groupedEvents = useMemo(() => {
    if (viewMode === "today") {
      return { [format(new Date(), "yyyy-MM-dd")]: sortedEvents };
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

  if (events.length === 0) {
    return (
      <Box py={4} textAlign="center">
        <Text color="fg.muted" fontSize="sm">
          {emptyMessage}
        </Text>
      </Box>
    );
  }

  if (viewMode === "today") {
    return (
      <Stack gap={2}>
        {sortedEvents.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
      </Stack>
    );
  }

  // Week/Month view - grouped by date
  return (
    <Stack gap={4}>
      {Object.entries(groupedEvents).map(([dateKey, dateEvents]) => {
        const date = new Date(dateKey + "T12:00:00"); // Noon to avoid timezone issues
        return (
          <Box key={dateKey}>
            <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2}>
              {format(date, "EEEE, MMMM d")}
            </Text>
            <Stack gap={2}>
              {dateEvents.map((event) => (
                <EventItem key={event.id} event={event} showDate={false} />
              ))}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

export default function CalendarScheduleSummary() {
  const [viewMode, setViewMode] = useState<ViewMode>("today");
  const [offset, setOffset] = useState(0);

  const { officeHoursEditUrl, eventsEditUrl } = useCalendarEditUrls();
  const { events: allEvents, isLoading } = useAllCalendarEvents();

  // Calculate date range based on view mode and offset
  const { startDate, endDate, rangeLabel } = useMemo(() => {
    const today = new Date();
    let start: Date;
    let end: Date;
    let label: string;

    switch (viewMode) {
      case "today":
        const targetDay = addDays(today, offset);
        start = new Date(targetDay);
        start.setHours(0, 0, 0, 0);
        end = new Date(targetDay);
        end.setHours(23, 59, 59, 999);
        label = offset === 0 ? "Today" : format(targetDay, "EEEE, MMMM d");
        break;
      case "week":
        const weekBase = addWeeks(today, offset);
        start = startOfWeek(weekBase, { weekStartsOn: 1 }); // Monday
        end = endOfWeek(weekBase, { weekStartsOn: 1 });
        label = offset === 0 ? "This Week" : `${format(start, "MMM d")} - ${format(end, "MMM d")}`;
        break;
      case "month":
        const monthBase = addMonths(today, offset);
        start = startOfMonth(monthBase);
        end = endOfMonth(monthBase);
        label = offset === 0 ? "This Month" : format(monthBase, "MMMM yyyy");
        break;
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

  // Summary stats
  const stats = useMemo(() => {
    const officeHours = filteredEvents.filter((e) => e.calendar_type === "office_hours");
    const events = filteredEvents.filter((e) => e.calendar_type === "events");
    return {
      total: filteredEvents.length,
      officeHoursCount: officeHours.length,
      eventsCount: events.length
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

  if (isLoading) {
    return (
      <Card.Root>
        <Card.Body>
          <VStack py={4}>
            <Spinner size="sm" />
            <Text color="fg.muted" fontSize="sm">
              Loading schedule...
            </Text>
          </VStack>
        </Card.Body>
      </Card.Root>
    );
  }

  return (
    <Card.Root>
      <Card.Header pb={2}>
        <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
          <HStack gap={2}>
            <Icon as={BsCalendar} color="blue.500" />
            <Heading size="sm">Schedule</Heading>
          </HStack>

          <HStack gap={2}>
            {/* Edit buttons */}
            {officeHoursEditUrl && (
              <Button size="xs" variant="ghost" colorPalette="blue" asChild>
                <Link href={officeHoursEditUrl} target="_blank" rel="noopener noreferrer">
                  <Icon as={BsPencil} mr={1} />
                  Edit OH
                </Link>
              </Button>
            )}
            {eventsEditUrl && (
              <Button size="xs" variant="ghost" colorPalette="orange" asChild>
                <Link href={eventsEditUrl} target="_blank" rel="noopener noreferrer">
                  <Icon as={BsPencil} mr={1} />
                  Edit Events
                </Link>
              </Button>
            )}
          </HStack>
        </Flex>
      </Card.Header>

      <Card.Body pt={0}>
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

          {/* Stats summary */}
          {stats.total > 0 && (
            <HStack justify="center" gap={4} fontSize="xs">
              <HStack gap={1}>
                <Box w={2} h={2} bg="blue.500" borderRadius="full" />
                <Text color="fg.muted">{stats.officeHoursCount} OH</Text>
              </HStack>
              <HStack gap={1}>
                <Box w={2} h={2} bg="orange.500" borderRadius="full" />
                <Text color="fg.muted">{stats.eventsCount} Events</Text>
              </HStack>
            </HStack>
          )}

          {/* Events list */}
          <Box maxH="300px" overflowY="auto">
            <EventsList events={filteredEvents} viewMode={viewMode} emptyMessage={emptyMessage} />
          </Box>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
