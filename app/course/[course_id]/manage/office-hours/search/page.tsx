"use client";

import { useHelpRequests, useHelpQueues, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { useStudentRoster } from "@/hooks/useCourseController";
import { Box, Heading, HStack, Input, Stack, Text, Badge, Spinner, Flex } from "@chakra-ui/react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import { BsSearch, BsArrowLeft } from "react-icons/bs";
import { InputGroup } from "@/components/ui/input-group";
import { RequestRow } from "@/components/help-queue/request-row";
import type { HelpRequest, HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Button } from "@/components/ui/button";
import NextLink from "next/link";

const DEBOUNCE_MS = 300;

type EnhancedHelpRequest = HelpRequest & {
  queue?: HelpQueue;
  students: string[];
};

export default function ManageOfficeHoursSearchPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";

  const [inputValue, setInputValue] = useState(initialQuery);
  const [searchQuery, setSearchQuery] = useState(initialQuery.toLowerCase());
  const [isTyping, setIsTyping] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<number | null>(null);

  // Get data from hooks
  const allHelpRequests = useHelpRequests();
  const helpQueues = useHelpQueues();
  const helpRequestStudents = useHelpRequestStudents();
  const studentRoster = useStudentRoster();

  // Build mappings
  const queueMap = useMemo(() => {
    return helpQueues.reduce(
      (acc, queue) => {
        acc[queue.id] = queue;
        return acc;
      },
      {} as Record<number, HelpQueue>
    );
  }, [helpQueues]);

  const requestStudentsMap = useMemo(() => {
    return helpRequestStudents.reduce(
      (acc, student) => {
        if (!acc[student.help_request_id]) {
          acc[student.help_request_id] = [];
        }
        acc[student.help_request_id].push(student.profile_id);
        return acc;
      },
      {} as Record<number, string[]>
    );
  }, [helpRequestStudents]);

  const studentNameMap = useMemo(() => {
    return (studentRoster || []).reduce(
      (acc, student) => {
        acc[student.id] = student.name || student.short_name || student.sortable_name || "Unknown Student";
        return acc;
      },
      {} as Record<string, string>
    );
  }, [studentRoster]);

  // Debounce only while user is actively typing
  useEffect(() => {
    if (inputValue.trim() === "") {
      setSearchQuery("");
      setIsTyping(false);
      return;
    }

    // Only show typing indicator if value changed from current search
    if (inputValue.trim().toLowerCase() !== searchQuery) {
      setIsTyping(true);
    }

    const timer = setTimeout(() => {
      setSearchQuery(inputValue.trim().toLowerCase());
      setIsTyping(false);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [inputValue, searchQuery]);

  // Update URL when query changes
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery) params.set("q", searchQuery);
    if (statusFilter) params.set("status", statusFilter);
    if (queueFilter) params.set("queue", queueFilter.toString());
    const qs = params.toString();
    router.replace(`/course/${course_id}/manage/office-hours/search${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchQuery, statusFilter, queueFilter, router, course_id]);

  // Filter and enhance help requests
  const searchResults = useMemo((): EnhancedHelpRequest[] => {
    let results = allHelpRequests;

    // Apply text search if query exists
    if (searchQuery) {
      const words = searchQuery.split(/\s+/).filter(Boolean);

      results = results.filter((request) => {
        // Search in request text
        const requestTextMatch = words.every((word) => request.request.toLowerCase().includes(word));

        // Search in student names
        const requestStudents = requestStudentsMap[request.id] || [];
        const studentNameMatch = requestStudents.some((profileId) => {
          const studentName = studentNameMap?.[profileId];
          return studentName && words.every((word) => studentName.toLowerCase().includes(word));
        });

        // Search in queue name
        const queue = queueMap[request.help_queue];
        const queueNameMatch = queue && words.every((word) => queue.name.toLowerCase().includes(word));

        // Search by request ID
        const idMatch = words.some((word) => request.id.toString().includes(word));

        return requestTextMatch || studentNameMatch || queueNameMatch || idMatch;
      });
    }

    // Apply status filter
    if (statusFilter) {
      results = results.filter((request) => request.status === statusFilter);
    }

    // Apply queue filter
    if (queueFilter) {
      results = results.filter((request) => request.help_queue === queueFilter);
    }

    // Enhance with queue and students info
    return results
      .map((request): EnhancedHelpRequest => {
        const associatedStudents = requestStudentsMap[request.id] || [];
        const students =
          associatedStudents.length > 0 ? associatedStudents : ([request.created_by!].filter(Boolean) as string[]);
        return {
          ...request,
          queue: queueMap[request.help_queue],
          students
        };
      })
      .sort((a, b) => {
        // Prioritize active requests, then by recency
        const statusOrder = { in_progress: 0, open: 1, resolved: 2, closed: 3 };
        const aOrder = statusOrder[a.status as keyof typeof statusOrder] ?? 4;
        const bOrder = statusOrder[b.status as keyof typeof statusOrder] ?? 4;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [searchQuery, allHelpRequests, requestStudentsMap, studentNameMap, queueMap, statusFilter, queueFilter]);

  // Get counts for filters
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    allHelpRequests.forEach((r) => {
      if (counts[r.status] !== undefined) counts[r.status]++;
    });
    return counts;
  }, [allHelpRequests]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  return (
    <Box>
      <Flex align="center" gap="4" mb="6">
        <Button asChild variant="ghost" size="sm">
          <NextLink href={`/course/${course_id}/manage/office-hours`}>
            <BsArrowLeft />
            Back
          </NextLink>
        </Button>
        <Heading size="lg">Search Help Requests</Heading>
      </Flex>

      <Stack gap="6">
        {/* Search Input */}
        <Box maxW="600px">
          <InputGroup startElement={<BsSearch />} w="full">
            <Input
              value={inputValue}
              onChange={handleInputChange}
              placeholder="Search by student name, request content, queue, or ID..."
              size="lg"
              bg="bg"
            />
          </InputGroup>
        </Box>

        {/* Filters */}
        <HStack gap="4" flexWrap="wrap">
          <Text fontSize="sm" fontWeight="medium" color="fg.muted">
            Status:
          </Text>
          <HStack gap="2" flexWrap="wrap">
            <Badge
              colorPalette={!statusFilter ? "blue" : "gray"}
              variant={!statusFilter ? "solid" : "subtle"}
              cursor="pointer"
              onClick={() => setStatusFilter(null)}
            >
              All
            </Badge>
            {["open", "in_progress", "resolved", "closed"].map((status) => (
              <Badge
                key={status}
                colorPalette={statusFilter === status ? "blue" : "gray"}
                variant={statusFilter === status ? "solid" : "subtle"}
                cursor="pointer"
                onClick={() => setStatusFilter(statusFilter === status ? null : status)}
              >
                {status.replace("_", " ")} ({statusCounts[status]})
              </Badge>
            ))}
          </HStack>
        </HStack>

        {helpQueues.length > 1 && (
          <HStack gap="4" flexWrap="wrap">
            <Text fontSize="sm" fontWeight="medium" color="fg.muted">
              Queue:
            </Text>
            <HStack gap="2" flexWrap="wrap">
              <Badge
                colorPalette={!queueFilter ? "blue" : "gray"}
                variant={!queueFilter ? "solid" : "subtle"}
                cursor="pointer"
                onClick={() => setQueueFilter(null)}
              >
                All Queues
              </Badge>
              {helpQueues.map((queue) => (
                <Badge
                  key={queue.id}
                  colorPalette={queueFilter === queue.id ? "blue" : "gray"}
                  variant={queueFilter === queue.id ? "solid" : "subtle"}
                  cursor="pointer"
                  onClick={() => setQueueFilter(queueFilter === queue.id ? null : queue.id)}
                >
                  {queue.name.replace(/ Queue$/, "")}
                </Badge>
              ))}
            </HStack>
          </HStack>
        )}

        {/* Results */}
        <Box>
          {isTyping ? (
            <HStack justify="center" py="8">
              <Spinner size="md" />
              <Text color="fg.muted">Searching...</Text>
            </HStack>
          ) : (
            <>
              <Text fontSize="sm" color="fg.muted" mb="4">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
                {searchQuery && ` for "${searchQuery}"`}
              </Text>

              {searchResults.length === 0 ? (
                <Box textAlign="center" py="12" bg="bg.muted" rounded="lg" borderWidth="1px" borderColor="border.muted">
                  <Text fontSize="lg" color="fg.muted" mb="2">
                    No requests found
                  </Text>
                  <Text fontSize="sm" color="fg.muted">
                    Try adjusting your search or filters
                  </Text>
                </Box>
              ) : (
                <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
                  {searchResults.map((request) => (
                    <RequestRow
                      key={request.id}
                      request={request}
                      href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                      queue={request.queue}
                      students={request.students}
                    />
                  ))}
                </Box>
              )}
            </>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
