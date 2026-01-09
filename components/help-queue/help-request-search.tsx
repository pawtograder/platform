"use client";

import { useHelpRequests, useHelpQueues, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { useStudentRoster } from "@/hooks/useCourseController";
import { PopoverRoot, PopoverContent } from "@/components/ui/popover";
import { Badge, Box, HStack, Input, Popover, Spinner, Stack, Text, Avatar, Icon } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BsSearch, BsCameraVideo, BsChatText, BsGeoAlt, BsCheckCircle, BsClock } from "react-icons/bs";
import { InputGroup } from "@/components/ui/input-group";
import { getQueueTypeColor } from "@/lib/utils";
import { useUserProfile } from "@/hooks/useUserProfiles";
import type { HelpRequest, HelpQueue } from "@/utils/supabase/DatabaseTypes";

const DEBOUNCE_MS = 200;
const MAX_RESULTS = 6;

interface HelpRequestSearchProps {
  isManageMode?: boolean;
}

type EnhancedHelpRequest = HelpRequest & {
  queue?: HelpQueue;
  students: string[];
};

/**
 * Get icon for queue type
 */
const getQueueIcon = (type: string) => {
  switch (type) {
    case "video":
      return BsCameraVideo;
    case "in_person":
      return BsGeoAlt;
    default:
      return BsChatText;
  }
};

/**
 * Get status color for help request
 */
const getStatusColor = (status: string) => {
  switch (status) {
    case "open":
      return "yellow";
    case "in_progress":
      return "blue";
    case "resolved":
      return "green";
    case "closed":
      return "gray";
    default:
      return "gray";
  }
};

/**
 * Simple component to display student name from profile ID
 */
function StudentName({ profileId, fallbackCreatedBy }: { profileId: string; fallbackCreatedBy?: string }) {
  const profile = useUserProfile(profileId);
  const fallbackProfile = fallbackCreatedBy ? useUserProfile(fallbackCreatedBy) : null;
  return <>{profile?.name || fallbackProfile?.name || "Unknown Student"}</>;
}

export function HelpRequestSearch({ isManageMode = false }: HelpRequestSearchProps) {
  const { course_id } = useParams();
  const router = useRouter();
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
    };
  }, []);

  // Debounce the search query
  useEffect(() => {
    if (inputValue.trim() === "") {
      setDebouncedQuery("");
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(() => {
      setDebouncedQuery(inputValue.trim().toLowerCase());
      setIsSearching(false);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [inputValue]);

  // Filter and enhance help requests based on debounced query
  const searchResults = useMemo((): EnhancedHelpRequest[] => {
    if (!debouncedQuery) return [];

    const query = debouncedQuery.toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);

    return allHelpRequests
      .filter((request) => {
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
      })
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
      })
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, allHelpRequests, requestStudentsMap, studentNameMap, queueMap]);

  const basePath = isManageMode ? `/course/${course_id}/manage/office-hours` : `/course/${course_id}/office-hours`;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setFocusedIndex(-1);

    if (newValue.trim()) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const handleFocus = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    if (inputValue.trim() && (searchResults.length > 0 || isSearching)) {
      setIsOpen(true);
    }
  };

  const handleBlur = () => {
    blurTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  const navigateToRequest = (request: EnhancedHelpRequest) => {
    const requestPath = isManageMode
      ? `${basePath}/request/${request.id}`
      : `${basePath}/${request.help_queue}/${request.id}`;
    router.push(requestPath);
  };

  const navigateToSearchResults = () => {
    if (inputValue.trim()) {
      router.push(`${basePath}/search?q=${encodeURIComponent(inputValue.trim())}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || searchResults.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        setIsOpen(false);
        navigateToSearchResults();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((prev) => (prev < searchResults.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : searchResults.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < searchResults.length) {
          setIsOpen(false);
          navigateToRequest(searchResults[focusedIndex]);
        } else {
          setIsOpen(false);
          navigateToSearchResults();
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setFocusedIndex(-1);
        break;
    }
  };

  const handleResultClick = (request: EnhancedHelpRequest) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsOpen(false);
    navigateToRequest(request);
  };

  const handleClear = () => {
    setInputValue("");
    setDebouncedQuery("");
    setIsOpen(false);
    inputRef.current?.focus();
  };

  // Highlight matching text
  const highlightMatch = (text: string, maxLength = 80) => {
    if (!debouncedQuery || !text) return text;

    const truncated = text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
    const words = debouncedQuery.split(/\s+/).filter(Boolean);
    const regex = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");

    const parts = truncated.split(regex);
    return parts.map((part, i) =>
      words.some((w) => part.toLowerCase() === w.toLowerCase()) ? (
        <Text as="mark" key={i} bg="yellow.200" color="inherit" px="0.5" rounded="sm">
          {part}
        </Text>
      ) : (
        part
      )
    );
  };

  const showResults =
    isOpen && (searchResults.length > 0 || isSearching || (debouncedQuery.length > 0 && !isSearching));

  return (
    <PopoverRoot
      open={showResults}
      onOpenChange={({ open }) => {
        if (!open) setIsOpen(false);
      }}
      positioning={{ placement: "bottom-start", sameWidth: true }}
      lazyMount
      autoFocus={false}
    >
      <Popover.Anchor asChild>
        <Box position="relative" maxW={{ base: "100%", md: "320px" }} flex="1">
          <InputGroup startElement={<BsSearch />}>
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={handleInputChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="Search requests..."
              size="sm"
              bg="bg"
              pr={inputValue ? "8" : undefined}
            />
          </InputGroup>
          {inputValue && (
            <Box
              position="absolute"
              right="2"
              top="50%"
              transform="translateY(-50%)"
              cursor="pointer"
              onClick={handleClear}
              color="fg.muted"
              fontSize="xs"
              _hover={{ color: "fg" }}
              zIndex={1}
            >
              ✕
            </Box>
          )}
        </Box>
      </Popover.Anchor>

      <PopoverContent
        ref={resultsRef}
        w="full"
        maxH="400px"
        overflow="auto"
        p="0"
        shadow="lg"
        borderRadius="md"
        bg="bg"
      >
        {isSearching ? (
          <HStack p="4" justify="center">
            <Spinner size="sm" />
            <Text fontSize="sm" color="fg.muted">
              Searching…
            </Text>
          </HStack>
        ) : searchResults.length === 0 ? (
          <Box p="4">
            <Text fontSize="sm" color="fg.muted" textAlign="center">
              No requests found for &quot;{debouncedQuery}&quot;
            </Text>
            <Text fontSize="xs" color="fg.muted" textAlign="center" mt="2">
              Press Enter to see all results
            </Text>
          </Box>
        ) : (
          <Stack gap="0">
            {searchResults.map((request, index) => {
              const primaryStudent = request.students[0];

              return (
                <Box
                  key={request.id}
                  px="3"
                  py="2.5"
                  cursor="pointer"
                  bg={focusedIndex === index ? "bg.muted" : "transparent"}
                  _hover={{ bg: "bg.subtle" }}
                  borderBottomWidth={index < searchResults.length - 1 ? "1px" : 0}
                  borderColor="border.muted"
                  onClick={() => handleResultClick(request)}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  <HStack gap="3" align="flex-start">
                    <Avatar.Root size="sm" flexShrink={0}>
                      <Avatar.Fallback>
                        {primaryStudent ? (
                          <StudentName profileId={primaryStudent} fallbackCreatedBy={request.created_by || undefined} />
                        ) : (
                          "?"
                        )}
                      </Avatar.Fallback>
                    </Avatar.Root>
                    <Stack gap="1" flex="1" minW={0}>
                      <HStack gap="2" wrap="wrap">
                        <Badge colorPalette={getStatusColor(request.status)} variant="subtle" size="sm">
                          <Icon
                            as={request.status === "open" || request.status === "in_progress" ? BsClock : BsCheckCircle}
                            fontSize="xs"
                            mr="1"
                          />
                          {request.status}
                        </Badge>
                        {request.queue && (
                          <Badge colorPalette={getQueueTypeColor(request.queue.queue_type)} variant="surface" size="sm">
                            <Icon as={getQueueIcon(request.queue.queue_type)} fontSize="xs" mr="1" />
                            {request.queue.name.replace(/ Queue$/, "")}
                          </Badge>
                        )}
                        <Text fontSize="xs" color="fg.muted">
                          #{request.id}
                        </Text>
                      </HStack>
                      <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                        {primaryStudent && (
                          <StudentName profileId={primaryStudent} fallbackCreatedBy={request.created_by || undefined} />
                        )}
                        {request.students.length > 1 && ` + ${request.students.length - 1} others`}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                        {highlightMatch(request.request, 120)}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {formatRelative(new Date(request.created_at), new Date())}
                      </Text>
                    </Stack>
                  </HStack>
                </Box>
              );
            })}
            {searchResults.length === MAX_RESULTS && (
              <Box px="3" py="2" borderTopWidth="1px" borderColor="border.muted" bg="bg.subtle">
                <Text fontSize="xs" color="fg.muted" textAlign="center">
                  Showing first {MAX_RESULTS} results. Press Enter to see all.
                </Text>
              </Box>
            )}
          </Stack>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
