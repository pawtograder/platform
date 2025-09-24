"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useDiscussionThreadTeasers } from "./useCourseController";

export interface MentionableThread {
  id: number;
  ordinal: number | null;
  subject: string;
  body: string;
  class_id: number;
}

export interface MentionState {
  isActive: boolean;
  query: string;
  position: number;
  filteredThreads: MentionableThread[];
  selectedIndex: number;
}

/**
 * Custom hook for handling @mentions in text input
 * Detects @number patterns and provides filtered discussion threads
 */
export function useMentions(text: string, cursorPosition: number) {
  const discussionThreads = useDiscussionThreadTeasers();
  const [mentionState, setMentionState] = useState<MentionState>({
    isActive: false,
    query: "",
    position: -1,
    filteredThreads: [],
    selectedIndex: 0
  });

  // Convert discussion threads to mentionable format
  const mentionableThreads = useMemo(() => {
    return discussionThreads
      .filter((thread) => thread.ordinal != null) // Only threads with ordinals can be mentioned
      .map((thread) => ({
        id: thread.id,
        ordinal: thread.ordinal,
        subject: thread.subject,
        body: thread.body,
        class_id: thread.class_id
      }));
  }, [discussionThreads]);

  // Detect mention pattern and extract query
  useEffect(() => {
    const textBeforeCursor = text.slice(0, cursorPosition);
    const mentionMatch = textBeforeCursor.match(/@(\d*)$/);

    if (mentionMatch) {
      const query = mentionMatch[1]; // The number after @
      const position = mentionMatch.index!;

      // Filter threads by ID or ordinal matching the query
      const filteredThreads = mentionableThreads.filter((thread) => {
        if (!query) return true; // Show all if no query yet

        const queryNum = parseInt(query);
        if (isNaN(queryNum)) return false;

        // Match by ID or ordinal
        return thread.ordinal && thread.ordinal.toString().startsWith(query);
      });

      setMentionState({
        isActive: true,
        query,
        position,
        filteredThreads: filteredThreads.slice(0, 10), // Limit to 10 results
        selectedIndex: 0
      });
    } else {
      setMentionState((prev) => ({
        ...prev,
        isActive: false,
        query: "",
        position: -1,
        filteredThreads: [],
        selectedIndex: 0
      }));
    }
  }, [text, cursorPosition, mentionableThreads]);

  // Navigation functions
  const selectNext = useCallback(() => {
    setMentionState((prev) => ({
      ...prev,
      selectedIndex: Math.min(prev.selectedIndex + 1, prev.filteredThreads.length - 1)
    }));
  }, []);

  const selectPrevious = useCallback(() => {
    setMentionState((prev) => ({
      ...prev,
      selectedIndex: Math.max(prev.selectedIndex - 1, 0)
    }));
  }, []);

  const selectThread = useCallback(
    (index?: number) => {
      const threadIndex = index !== undefined ? index : mentionState.selectedIndex;
      const selectedThread = mentionState.filteredThreads[threadIndex];
      if (!selectedThread) return null;

      // Look for existing mention pattern: [@number](link) that ends before or at cursor
      const mentionRegex = /\[@\d+\]\([^)]+\)\s*/g;
      const mentionMatches = Array.from(text.matchAll(mentionRegex));

      let replacementStart = mentionState.position;
      let replacementEnd = cursorPosition;

      if (mentionMatches.length > 0) {
        for (const match of mentionMatches) {
          const matchStart = match.index!;
          const matchEnd = matchStart + match[0].length;

          // If cursor is inside this existing mention
          if (cursorPosition >= matchStart && cursorPosition <= matchEnd) {
            replacementStart = matchStart;
            replacementEnd = matchEnd;
            break;
          }
        }
      }

      return {
        thread: selectedThread,
        replacement: {
          start: replacementStart,
          end: replacementEnd,
          text: `@${selectedThread.ordinal}`,
          link: `/course/${selectedThread.class_id}/discussion/${selectedThread.id}`
        }
      };
    },
    [mentionState.filteredThreads, mentionState.position, cursorPosition, mentionState.selectedIndex, text]
  );

  const dismissMentions = useCallback(() => {
    setMentionState((prev) => ({
      ...prev,
      isActive: false,
      query: "",
      position: -1,
      filteredThreads: [],
      selectedIndex: 0
    }));
  }, []);

  return {
    mentionState,
    selectNext,
    selectPrevious,
    selectThread,
    dismissMentions
  };
}
