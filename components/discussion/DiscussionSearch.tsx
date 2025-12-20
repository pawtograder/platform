"use client";

import { useDiscussionThreadTeasers, useDiscussionTopics } from "@/hooks/useCourseController";
import { TopicIcon } from "@/components/discussion/TopicIcon";
import { PopoverRoot, PopoverContent } from "@/components/ui/popover";
import { Badge, Box, HStack, Input, Popover, Spinner, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaThumbtack } from "react-icons/fa";

const DEBOUNCE_MS = 250;
const MAX_RESULTS = 8;

interface DiscussionSearchProps {
  onChangeAction: (value: string) => void;
}

export function DiscussionSearch({ onChangeAction }: DiscussionSearchProps) {
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

  const teasers = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();

  // Debounce the search query for filtering results (local only, doesn't update URL)
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

  // Filter teasers based on debounced query
  const searchResults = useMemo(() => {
    if (!debouncedQuery) return [];

    const query = debouncedQuery.toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);

    return teasers
      .filter((teaser) => {
        // Only search root-level threads (not replies)
        if (teaser.draft) return false;

        const subject = (teaser.subject ?? "").toLowerCase();
        const body = (teaser.body ?? "").toLowerCase();
        const topic = topics.find((t) => t.id === teaser.topic_id);
        const topicName = (topic?.topic ?? "").toLowerCase();

        // Match if all words appear in subject, body, or topic name
        return words.every((word) => subject.includes(word) || body.includes(word) || topicName.includes(word));
      })
      .sort((a, b) => {
        // Prioritize subject matches, then pinned, then recency
        const aSubjectMatch = words.some((w) => (a.subject ?? "").toLowerCase().includes(w));
        const bSubjectMatch = words.some((w) => (b.subject ?? "").toLowerCase().includes(w));
        if (aSubjectMatch && !bSubjectMatch) return -1;
        if (!aSubjectMatch && bSubjectMatch) return 1;

        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, teasers, topics]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setFocusedIndex(-1);

    // Open popover when typing
    if (newValue.trim()) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const handleFocus = () => {
    // Cancel any pending blur timeout
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    if (inputValue.trim() && (searchResults.length > 0 || isSearching)) {
      setIsOpen(true);
    }
  };

  const handleBlur = () => {
    // Delay closing to allow clicks on results
    blurTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || searchResults.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        setIsOpen(false);
        onChangeAction(inputValue);
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
          const thread = searchResults[focusedIndex];
          setIsOpen(false);
          router.push(`/course/${course_id}/discussion/${thread.id}`);
        } else {
          setIsOpen(false);
          onChangeAction(inputValue);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setFocusedIndex(-1);
        break;
    }
  };

  const handleResultClick = (threadId: number) => {
    // Cancel blur timeout since we're clicking a result
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsOpen(false);
    router.push(`/course/${course_id}/discussion/${threadId}`);
  };

  const handleClear = () => {
    setInputValue("");
    setDebouncedQuery("");
    setIsOpen(false);
    onChangeAction("");
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
        <Text as="mark" key={i} bg="yellow.200" color="inherit" px="0.5">
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
        <Box position="relative" maxW={{ base: "100%", md: "360px" }} flex="1">
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Search posts"
            size="sm"
            bg="bg"
            pr={inputValue ? "8" : undefined}
          />
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
              No posts found for &quot;{debouncedQuery}&quot;
            </Text>
          </Box>
        ) : (
          <Stack gap="0">
            {searchResults.map((thread, index) => {
              const topic = topics.find((t) => t.id === thread.topic_id);
              const topicColor = topic?.color ? `${topic.color}.500` : "gray.400";

              return (
                <Box
                  key={thread.id}
                  px="3"
                  py="2"
                  cursor="pointer"
                  bg={focusedIndex === index ? "bg.muted" : "transparent"}
                  _hover={{ bg: "bg.subtle" }}
                  borderBottomWidth={index < searchResults.length - 1 ? "1px" : 0}
                  borderColor="border.muted"
                  onClick={() => handleResultClick(thread.id)}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  <HStack gap="2" align="flex-start">
                    <Box pt="0.5" flexShrink={0}>
                      <TopicIcon name={topic?.icon} color={topicColor} boxSize="3.5" />
                    </Box>
                    <Stack gap="0.5" flex="1" minW={0}>
                      <HStack gap="2" wrap="wrap">
                        {thread.pinned && <Box as={FaThumbtack} color="fg.info" boxSize="2.5" flexShrink={0} />}
                        <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                          {highlightMatch(thread.subject ?? "")}
                        </Text>
                      </HStack>
                      <HStack gap="2" fontSize="xs" color="fg.muted">
                        {topic && (
                          <Badge colorPalette={topic.color} variant="subtle" size="sm">
                            {topic.topic}
                          </Badge>
                        )}
                        <Text>{formatRelative(new Date(thread.created_at), new Date())}</Text>
                        <Text>{thread.children_count ?? 0} replies</Text>
                      </HStack>
                      {thread.body && (
                        <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                          {highlightMatch(thread.body, 120)}
                        </Text>
                      )}
                    </Stack>
                  </HStack>
                </Box>
              );
            })}
            {searchResults.length === MAX_RESULTS && (
              <Box px="3" py="2" borderTopWidth="1px" borderColor="border.muted">
                <Text fontSize="xs" color="fg.muted" textAlign="center">
                  Showing first {MAX_RESULTS} results. Press Enter to search all.
                </Text>
              </Box>
            )}
          </Stack>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
