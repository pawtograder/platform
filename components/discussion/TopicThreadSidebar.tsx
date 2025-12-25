"use client";

import { PostRow } from "@/components/discussion/PostRow";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useCourseController, useDiscussionTopics } from "@/hooks/useCourseController";
import { useTableControllerValueById } from "@/lib/TableController";
import { Box, HStack, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";

export function TopicThreadSidebar({
  rootId,
  isOpen,
  onToggle
}: {
  rootId: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { course_id } = useParams();
  const controller = useCourseController();
  const topics = useDiscussionTopics();

  const allThreads = controller.discussionThreadTeasers.rows;
  const rootThread = useTableControllerValueById(controller.discussionThreadTeasers, rootId);

  const topic = useMemo(() => topics?.find((t) => t.id === rootThread?.topic_id), [topics, rootThread?.topic_id]);

  const threadsForTopic = useMemo(() => {
    if (!rootThread) return [];
    const topicId = rootThread.topic_id;
    return [...allThreads]
      .filter((t) => t.topic_id === topicId)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [allThreads, rootThread]);

  // Preserve scroll when switching threads within same topic
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastTopicIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);

  useEffect(() => {
    const currentTopicId = rootThread?.topic_id ?? null;
    const lastTopicId = lastTopicIdRef.current;

    // Update scroll for next time
    lastTopicIdRef.current = currentTopicId;

    // Restore only when topic is unchanged
    if (currentTopicId != null && lastTopicId != null && currentTopicId === lastTopicId) {
      const el = scrollRef.current;
      if (!el) return;
      // Wait for list to render
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = lastScrollTopRef.current;
        }
      });
    } else {
      // New topic: reset remembered scroll
      lastScrollTopRef.current = 0;
      const el = scrollRef.current;
      if (el) el.scrollTop = 0;
    }
  }, [rootId, rootThread?.topic_id, threadsForTopic.length]);

  if (!isOpen) {
    return (
      <Box
        borderWidth="1px"
        borderColor="border.emphasized"
        bg="bg.panel"
        rounded="md"
        overflow="hidden"
        position={{ base: "relative", lg: "sticky" }}
        top="0"
        alignSelf="flex-start"
        width={{ base: "52px", lg: "52px" }}
      >
        <Box px="2" py="2">
          <Tooltip content="Show topic threads">
            <Button aria-label="Show topic threads" variant="ghost" size="sm" onClick={onToggle} width="100%">
              <FaChevronRight />
            </Button>
          </Tooltip>
          <Text mt="2" fontSize="xs" color="fg.muted" textAlign="center">
            {threadsForTopic.length}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderWidth="1px"
      borderColor="border.emphasized"
      bg="bg.panel"
      rounded="md"
      overflow="hidden"
      position={{ base: "relative", lg: "sticky" }}
      top="0"
      alignSelf="flex-start"
      maxH={{ base: "calc(100dvh - 120px)", lg: "calc(100dvh - 120px)" }}
    >
      <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
        <HStack justify="space-between" align="start" gap="2">
          <Box>
            <Text fontWeight="semibold" fontSize="sm">
              {topic ? `More in ${topic.topic}` : "More in this topic"}
            </Text>
            <Text color="fg.muted" fontSize="xs">
              {threadsForTopic.length} thread{threadsForTopic.length === 1 ? "" : "s"}
            </Text>
          </Box>
          <Tooltip content="Hide sidebar">
            <Button aria-label="Hide sidebar" variant="ghost" size="sm" onClick={onToggle}>
              <FaChevronLeft />
            </Button>
          </Tooltip>
        </HStack>
      </Box>

      <Box
        ref={scrollRef}
        overflowY="auto"
        maxH={{ base: "calc(100dvh - 180px)", lg: "calc(100dvh - 180px)" }}
        onScroll={(e) => {
          lastScrollTopRef.current = (e.target as HTMLDivElement).scrollTop;
        }}
      >
        {threadsForTopic.map((t) => (
          <PostRow
            key={t.id}
            threadId={t.id}
            href={`/course/${course_id}/discussion/${t.id}`}
            selected={t.id === rootId}
            showTopicBadge={false}
          />
        ))}
      </Box>
    </Box>
  );
}
