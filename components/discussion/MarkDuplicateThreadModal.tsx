"use client";

import { toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { useDiscussionThreadTeasers, useDiscussionTopics } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_RESULTS = 20;
const DEBOUNCE_MS = 150;

function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(body: string | null | undefined, maxLength = 180): string {
  if (!body) return "";
  const cleaned = stripMarkdown(body);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trimEnd() + "…";
}

function highlight(text: string, words: string[]): React.ReactNode {
  if (!text || words.length === 0) return text;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (escaped.length === 0) return text;
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    words.some((w) => part.toLowerCase() === w.toLowerCase()) ? (
      <Text as="mark" key={i} bg="yellow.200" color="inherit" px="0.5">
        {part}
      </Text>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function MarkDuplicateThreadModal({
  isOpen,
  onClose,
  duplicateRootId,
  onMerged
}: {
  isOpen: boolean;
  onClose: () => void;
  duplicateRootId: number;
  onMerged: (originalRootId: number) => void;
}) {
  const { course_id } = useParams();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const teasers = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when the modal opens or duplicateRootId changes.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setDebouncedQuery("");
      setSelectedId(null);
      setFocusedIndex(0);
    }
  }, [isOpen, duplicateRootId]);

  // Debounce keystrokes so we don't re-filter on every character.
  useEffect(() => {
    if (query === "") {
      setDebouncedQuery("");
      return;
    }
    const handle = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const isSearching = query.trim() !== "" && query.trim().toLowerCase() !== debouncedQuery;

  const results = useMemo(() => {
    const candidates = teasers.filter((t) => !t.draft && t.id !== duplicateRootId);
    if (!debouncedQuery) {
      return [...candidates]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, MAX_RESULTS);
    }

    const ordinalToken = debouncedQuery.replace(/^#/, "");
    const ordinalNum = /^\d+$/.test(ordinalToken) ? Number(ordinalToken) : null;
    const words = debouncedQuery.split(/\s+/).filter(Boolean);

    return candidates
      .filter((t) => {
        if (ordinalNum !== null && t.ordinal === ordinalNum) return true;
        const subject = (t.subject ?? "").toLowerCase();
        const body = (t.body ?? "").toLowerCase();
        return words.every((w) => subject.includes(w) || body.includes(w));
      })
      .sort((a, b) => {
        if (ordinalNum !== null) {
          if (a.ordinal === ordinalNum && b.ordinal !== ordinalNum) return -1;
          if (b.ordinal === ordinalNum && a.ordinal !== ordinalNum) return 1;
        }
        const aSubjectMatch = words.some((w) => (a.subject ?? "").toLowerCase().includes(w));
        const bSubjectMatch = words.some((w) => (b.subject ?? "").toLowerCase().includes(w));
        if (aSubjectMatch && !bSubjectMatch) return -1;
        if (!aSubjectMatch && bSubjectMatch) return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, MAX_RESULTS);
  }, [teasers, debouncedQuery, duplicateRootId]);

  // Clamp focusedIndex into the current results window.
  useEffect(() => {
    if (results.length === 0) {
      setFocusedIndex(0);
      return;
    }
    setFocusedIndex((idx) => Math.min(Math.max(idx, 0), results.length - 1));
  }, [results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (results.length === 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((idx) => (idx + 1) % results.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((idx) => (idx - 1 + results.length) % results.length);
          break;
        case "Enter":
          e.preventDefault();
          setSelectedId(results[focusedIndex].id);
          break;
      }
    },
    [results, focusedIndex]
  );

  const handleSubmit = useCallback(async () => {
    if (selectedId === null) {
      toaster.error({
        title: "Pick a thread",
        description: "Select the original thread from the search results."
      });
      return;
    }
    if (selectedId === duplicateRootId) {
      toaster.error({ title: "Invalid", description: "The original cannot be the same thread." });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: duplicateRootId,
        p_original_root_id: selectedId
      });
      if (error) throw error;

      toaster.success({
        title: "Merged as duplicate",
        description:
          "This thread was moved under the original. Students were notified if they authored the duplicate."
      });
      onClose();
      onMerged(selectedId);
      router.push(`/course/${course_id}/discussion/${selectedId}`);
    } catch (e) {
      toaster.error({
        title: "Could not mark duplicate",
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      setSubmitting(false);
    }
  }, [course_id, duplicateRootId, selectedId, onClose, onMerged, router, supabase]);

  const selectedThread = useMemo(
    () => (selectedId !== null ? teasers.find((t) => t.id === selectedId) : undefined),
    [teasers, selectedId]
  );

  const searchWords = debouncedQuery ? debouncedQuery.split(/\s+/).filter(Boolean) : [];

  return (
    <DialogRoot open={isOpen} onOpenChange={(d) => !d.open && onClose()} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as duplicate of another thread</DialogTitle>
        </DialogHeader>
        <DialogCloseTrigger />
        <DialogBody>
          <Text fontSize="sm" color="fg.muted" mb="3">
            This post and all of its replies will become replies under the original thread you pick. The author
            receives a notification and a banner will show the former subject and who merged it.
          </Text>
          <Field
            label="Find the original thread"
            helperText="Search by title or post number (e.g. #42 or 42)."
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Title or #ordinal"
              disabled={submitting}
              autoFocus
              aria-label="Search original thread by title or ordinal"
              data-testid="mark-duplicate-search-input"
            />
          </Field>
          <Box mt="3" maxH="50vh" overflowY="auto" borderWidth="1px" rounded="md" ref={listRef}>
            {isSearching ? (
              <HStack p="3" justify="center">
                <Spinner size="sm" />
                <Text fontSize="sm" color="fg.muted">
                  Searching…
                </Text>
              </HStack>
            ) : results.length === 0 ? (
              <Text p="3" color="fg.muted" fontSize="sm">
                {teasers.length === 0
                  ? "No other threads available."
                  : debouncedQuery
                    ? `No threads match "${debouncedQuery}".`
                    : "No other threads in this course yet."}
              </Text>
            ) : (
              <Stack gap="0">
                {results.map((t, index) => {
                  const isSelected = t.id === selectedId;
                  const isFocused = index === focusedIndex;
                  const topic = topics.find((top) => top.id === t.topic_id);
                  return (
                    <Box
                      key={t.id}
                      as="button"
                      onClick={() => {
                        setSelectedId(t.id);
                        setFocusedIndex(index);
                      }}
                      onMouseEnter={() => setFocusedIndex(index)}
                      textAlign="left"
                      p="3"
                      bg={isSelected ? "bg.info" : isFocused ? "bg.muted" : "transparent"}
                      borderLeftWidth="3px"
                      borderLeftColor={isSelected ? "blue.500" : "transparent"}
                      borderBottomWidth={index < results.length - 1 ? "1px" : 0}
                      borderColor="border.muted"
                      _hover={{ bg: isSelected ? "bg.info" : "bg.muted" }}
                      w="100%"
                      aria-pressed={isSelected}
                      data-testid={`mark-duplicate-result-${t.id}`}
                    >
                      <HStack gap="2" mb="1" wrap="wrap">
                        <Badge variant="subtle">#{t.ordinal}</Badge>
                        {topic && (
                          <Badge colorPalette={topic.color} variant="subtle">
                            {topic.topic}
                          </Badge>
                        )}
                        {t.is_question && (
                          <Badge colorPalette={t.answer ? "green" : "red"} variant="subtle">
                            {t.answer ? "Answered" : "Question"}
                          </Badge>
                        )}
                        <Text fontWeight="semibold" fontSize="sm" lineClamp={1}>
                          {highlight(t.subject || "(no subject)", searchWords)}
                        </Text>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                        {highlight(snippet(t.body), searchWords)}
                      </Text>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </Box>
          {selectedThread && (
            <Box mt="3" p="2" rounded="md" bg="bg.subtle" borderWidth="1px" borderColor="border.muted">
              <Text fontSize="xs" color="fg.muted">
                Selected original
              </Text>
              <Text fontSize="sm" fontWeight="semibold" lineClamp={1}>
                #{selectedThread.ordinal} {selectedThread.subject}
              </Text>
            </Box>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={selectedId === null || submitting}
            data-testid="mark-duplicate-confirm"
          >
            Merge into original
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
