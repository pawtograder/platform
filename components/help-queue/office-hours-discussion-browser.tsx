"use client";

import { PostRow } from "@/components/discussion/PostRow";
import { Button } from "@/components/ui/button";
import { useDiscussionThreadTeasers, useDiscussionTopics } from "@/hooks/useCourseController";
import { Box, Button as ChakraButton, Flex, Heading, Icon, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { BsChevronDown, BsChevronUp } from "react-icons/bs";

export function OfficeHoursDiscussionBrowser() {
  const { course_id } = useParams();
  const courseId = Number(course_id);
  const threads = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();

  // Get topics marked for office hours
  const officeHoursTopics = useMemo(() => {
    return topics?.filter((t) => t.show_in_office_hours && t.class_id === courseId) || [];
  }, [topics, courseId]);

  // Get all threads from office hours topics
  // Separate pinned from all posts
  const { pinnedPosts, allPosts } = useMemo(() => {
    if (officeHoursTopics.length === 0) return { pinnedPosts: [], allPosts: [] };

    const officeHoursTopicIds = new Set(officeHoursTopics.map((t) => t.id));

    const allOfficeHoursThreads = threads.filter(
      (t) =>
        t.topic_id && officeHoursTopicIds.has(t.topic_id) && t.class_id === courseId && !t.draft && !t.instructors_only
    );

    // Separate pinned and non-pinned
    const pinned = allOfficeHoursThreads
      .filter((t) => !!t.pinned)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const all = allOfficeHoursThreads.sort((a, b) => {
      // Sort by updated_at if available (from database), otherwise created_at
      const aTime = (a as typeof a & { updated_at?: string }).updated_at
        ? new Date((a as typeof a & { updated_at?: string }).updated_at!).getTime()
        : new Date(a.created_at).getTime();
      const bTime = (b as typeof b & { updated_at?: string }).updated_at
        ? new Date((b as typeof b & { updated_at?: string }).updated_at!).getTime()
        : new Date(b.created_at).getTime();
      return bTime - aTime; // Latest first
    });

    return { pinnedPosts: pinned, allPosts: all };
  }, [threads, officeHoursTopics, courseId]);

  const hasContent = pinnedPosts.length > 0 || allPosts.length > 0;
  const [isExpanded, setIsExpanded] = useState(false);

  if (!hasContent) {
    return null;
  }

  return (
    <Box borderWidth="1px" borderColor="border.muted" p={2} rounded="md">
      <Flex alignItems="center" justifyContent="space-between" mb={2} gap={2}>
        <Box>
          <Heading size="md">Before you request help...</Heading>
          <Text fontSize="sm" color="fg.muted" mt={0.5}>
            Check these relevant discussion topics - you might find your answer here!
          </Text>
        </Box>
        <Button asChild variant="outline" size="sm">
          <Link href={`/course/${courseId}/discussion`}>Browse All Discussion Posts</Link>
        </Button>
      </Flex>

      <Stack spaceY="0">
        {/* Show all pinned posts */}
        {pinnedPosts.length > 0 && (
          <>
            {pinnedPosts.map((thread, index) => {
              const isLastPinned = index === pinnedPosts.length - 1;
              const shouldShowButton = isLastPinned && allPosts.length > pinnedPosts.length && !isExpanded;

              if (shouldShowButton) {
                return (
                  <Box key={thread.id} position="relative">
                    <PostRow
                      threadId={thread.id}
                      href={`/course/${courseId}/discussion/${thread.id}`}
                      variant="compact"
                      showTopicBadge={true}
                    />
                    <Box position="absolute" bottom="2" right="3" zIndex={10}>
                      <ChakraButton variant="ghost" size="xs" onClick={() => setIsExpanded(true)}>
                        <Icon as={BsChevronDown} mr={1} />
                        Show All Related Posts ({allPosts.length - pinnedPosts.length})
                      </ChakraButton>
                    </Box>
                  </Box>
                );
              }

              return (
                <PostRow
                  key={thread.id}
                  threadId={thread.id}
                  href={`/course/${courseId}/discussion/${thread.id}`}
                  variant="compact"
                  showTopicBadge={true}
                />
              );
            })}
          </>
        )}

        {/* Expandable section for all posts */}
        {allPosts.length > pinnedPosts.length && (
          <>
            {isExpanded ? (
              <>
                {/* Show non-pinned posts */}
                {allPosts
                  .filter((t) => !t.pinned)
                  .map((thread, index, filtered) => {
                    const isLast = index === filtered.length - 1;

                    if (isLast) {
                      return (
                        <Box key={thread.id} position="relative">
                          <PostRow
                            threadId={thread.id}
                            href={`/course/${courseId}/discussion/${thread.id}`}
                            variant="compact"
                            showTopicBadge={true}
                          />
                          <Box position="absolute" bottom="2" right="3" zIndex={10}>
                            <ChakraButton variant="ghost" size="xs" onClick={() => setIsExpanded(false)}>
                              <Icon as={BsChevronUp} mr={1} />
                              Show Less
                            </ChakraButton>
                          </Box>
                        </Box>
                      );
                    }

                    return (
                      <PostRow
                        key={thread.id}
                        threadId={thread.id}
                        href={`/course/${courseId}/discussion/${thread.id}`}
                        variant="compact"
                        showTopicBadge={true}
                      />
                    );
                  })}
              </>
            ) : (
              pinnedPosts.length === 0 &&
              allPosts.length > 0 && (
                <Box position="relative">
                  <PostRow
                    key={allPosts[0].id}
                    threadId={allPosts[0].id}
                    href={`/course/${courseId}/discussion/${allPosts[0].id}`}
                    variant="compact"
                    showTopicBadge={true}
                  />
                  {allPosts.length > 1 && (
                    <Box position="absolute" bottom="2" right="3" zIndex={10}>
                      <ChakraButton variant="ghost" size="xs" onClick={() => setIsExpanded(true)}>
                        <Icon as={BsChevronDown} mr={1} />
                        Show All ({allPosts.length})
                      </ChakraButton>
                    </Box>
                  )}
                </Box>
              )
            )}
          </>
        )}
      </Stack>
    </Box>
  );
}
