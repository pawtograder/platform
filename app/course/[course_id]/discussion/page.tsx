"use client";
import { PinnedPostsSidebar } from "@/components/discussion/PinnedPostsSidebar";
import { VirtualizedPostRowList } from "@/components/discussion/VirtualizedPostRowList";
import { TopPostsSidebar } from "@/components/discussion/TopPostsSidebar";
import { TopicCard } from "@/components/discussion/TopicCard";
import { TopicFollowMultiSelect } from "@/components/discussion/TopicFollowMultiSelect";
import { useFollowedDiscussionTopicIds, useTopicFollowActions } from "@/hooks/useDiscussionTopicFollow";
import { useCourseController, useDiscussionThreadTeasers, useDiscussionTopics } from "@/hooks/useCourseController";
import { useTableControllerTableValues } from "@/lib/TableController";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, Flex, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function DiscussionPage() {
  const { course_id } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = searchParams.get("view") === "browse" ? "browse" : "feed";
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();
  const topicParam = searchParams.get("topic");
  const topicFromUrl = topicParam ? Number.parseInt(topicParam) : null;

  const controller = useCourseController();
  const topics = useDiscussionTopics();
  const threads = useDiscussionThreadTeasers();

  const [discussionDataReady, setDiscussionDataReady] = useState(
    () => controller.discussionTopics.ready && controller.discussionThreadTeasers.ready
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all([controller.discussionTopics.readyPromise, controller.discussionThreadTeasers.readyPromise])
      .then(() => {
        if (!cancelled) setDiscussionDataReady(true);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console -- surface load failures; page must not stay on skeleton forever
        console.error("DiscussionPage: failed waiting for discussion data", err);
        if (!cancelled) setDiscussionDataReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [controller]);

  const followedTopicIds = useFollowedDiscussionTopicIds();
  const { setTopicFollowStatusForId } = useTopicFollowActions();
  const watches = useTableControllerTableValues(controller.discussionThreadWatchers);
  const followedThreadIds = useMemo(() => {
    const ws = watches ?? [];
    return new Set(ws.filter((w) => w.enabled).map((w) => w.discussion_thread_root_id));
  }, [watches]);

  const readStatuses = useTableControllerTableValues(controller.discussionThreadReadStatus);
  const readAtByThreadId = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const s of readStatuses ?? []) map.set(s.discussion_thread_id, s.read_at);
    return map;
  }, [readStatuses]);

  const sortedTopics = useMemo(() => {
    return [...(topics ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  }, [topics]);

  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  useEffect(() => {
    if (view !== "browse") return;

    // If URL specifies a topic, honor it (if valid).
    if (topicFromUrl && sortedTopics.some((t) => t.id === topicFromUrl)) {
      setSelectedTopicId(topicFromUrl);
      return;
    }

    // Otherwise, default to the first topic and write it to the URL.
    if (sortedTopics.length > 0) {
      const first = sortedTopics[0].id;
      setSelectedTopicId(first);
      const next = new URLSearchParams(searchParams.toString());
      next.set("view", "browse");
      next.set("topic", first.toString());
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }
  }, [pathname, router, searchParams, sortedTopics, topicFromUrl, view]);

  const topicCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of threads) counts.set(t.topic_id, (counts.get(t.topic_id) ?? 0) + 1);
    return counts;
  }, [threads]);

  const topicUnreadCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of threads) {
      const readAt = readAtByThreadId.get(t.id);
      const isUnread = readAt == null;
      if (!isUnread) continue;
      counts.set(t.topic_id, (counts.get(t.topic_id) ?? 0) + 1);
    }
    return counts;
  }, [readAtByThreadId, threads]);

  const feedThreads = useMemo(() => {
    return threads
      .filter((t) => followedThreadIds.has(t.id) || followedTopicIds.has(t.topic_id))
      .filter((t) => {
        if (!q) return true;
        return (t.subject ?? "").toLowerCase().includes(q) || (t.body ?? "").toLowerCase().includes(q);
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [followedThreadIds, followedTopicIds, q, threads]);

  const selectedTopic = useMemo(
    () => (selectedTopicId != null ? sortedTopics.find((t) => t.id === selectedTopicId) : undefined),
    [selectedTopicId, sortedTopics]
  );

  const browseThreads = useMemo(() => {
    if (!selectedTopicId) return [];
    return threads
      .filter((t) => t.topic_id === selectedTopicId)
      .filter((t) => {
        if (!q) return true;
        return (t.subject ?? "").toLowerCase().includes(q) || (t.body ?? "").toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Keep pinned at top within topic list
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [q, selectedTopicId, threads]);

  if (!discussionDataReady) {
    return (
      <Box flex="1" minH={0} display="flex" flexDirection="column" aria-busy="true" aria-live="polite">
        <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} flex="1" minH={0} align="stretch">
          <Box flex={{ lg: 4 }} minW={0}>
            <Stack spaceY={2}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} height="72px" borderRadius="md" />
              ))}
            </Stack>
          </Box>
          <Box flex={{ base: 1, lg: 8 }} minW={0} display="flex" flexDirection="column">
            <Skeleton height="32px" width="min(240px, 55%)" mb="4" borderRadius="md" />
            <Box
              flex="1"
              minH="min(320px, 50dvh)"
              borderWidth="1px"
              borderColor="border.emphasized"
              rounded="md"
              overflow="hidden"
            >
              <Skeleton height="100%" minH="200px" borderRadius="md" />
            </Box>
          </Box>
        </Flex>
      </Box>
    );
  }

  if (view === "browse") {
    return (
      <Box flex="1" minH={0} display="flex" flexDirection="column">
        <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch" flex="1" minH={0}>
          <Box flex={{ lg: 4 }} minW={0} overflowY={{ base: "visible", lg: "auto" }} minH={0}>
            <Stack spaceY={1}>
              {sortedTopics.map((t) => (
                <TopicCard
                  key={t.id}
                  topic={t}
                  postCount={topicCounts.get(t.id) ?? 0}
                  unreadCount={topicUnreadCounts.get(t.id) ?? 0}
                  selected={t.id === selectedTopicId}
                  showFollowStar
                  isFollowed={followedTopicIds.has(t.id)}
                  onToggleFollowAction={() => setTopicFollowStatusForId(t.id, !followedTopicIds.has(t.id))}
                  onClickAction={() => {
                    setSelectedTopicId(t.id);
                    const next = new URLSearchParams(searchParams.toString());
                    next.set("view", "browse");
                    next.set("topic", t.id.toString());
                    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
                  }}
                />
              ))}
            </Stack>
          </Box>

          <Box flex={{ base: 1, lg: 8 }} minW={0} minH={0} display="flex" flexDirection="column">
            <HStack justify="space-between" align="center" mb="4" flexShrink={0}>
              <Heading size="md">{selectedTopic?.topic ?? "Select a topic"}</Heading>
            </HStack>

            <Box
              borderWidth="1px"
              borderColor="border.emphasized"
              bg="bg.panel"
              rounded="md"
              overflow="hidden"
              minH={0}
              flex="1"
              display="flex"
              flexDirection="column"
            >
              {browseThreads.length === 0 ? (
                <Text px="4" py="3" color="fg.muted" fontSize="sm">
                  No posts match your criteria.
                </Text>
              ) : (
                <VirtualizedPostRowList
                  threadIds={browseThreads.map((t) => t.id)}
                  courseId={Number(course_id)}
                  fillHeight
                />
              )}
            </Box>
          </Box>
        </Flex>
      </Box>
    );
  }

  // My Feed
  return (
    <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch" flex="1" minH={0}>
      <Box flex={{ base: 1, lg: 8 }} minW={0} minH={0} display="flex" flexDirection="column">
        <Stack spaceY={4} flex="1" minH={0}>
          <HStack justify="space-between" align="center" flexShrink={0}>
            <Heading size="md">My Feed</Heading>
            <TopicFollowMultiSelect
              topics={sortedTopics}
              followedTopicIds={followedTopicIds}
              onSetTopicFollowStatusAction={setTopicFollowStatusForId}
            />
          </HStack>

          <Box
            borderWidth="1px"
            borderColor="border.emphasized"
            bg="bg.panel"
            rounded="md"
            overflow="hidden"
            flex="1"
            minH={0}
            display="flex"
            flexDirection="column"
          >
            {feedThreads.length === 0 ? (
              <Text px="4" py="3" color="fg.muted" fontSize="sm">
                Your feed is empty. Follow a topic (Browse Topics) or follow a post to see it here. Followed posts and
                topics will appear in My Feed.
              </Text>
            ) : (
              <VirtualizedPostRowList
                threadIds={feedThreads.map((t) => t.id)}
                courseId={Number(course_id)}
                fillHeight
              />
            )}
          </Box>
        </Stack>
      </Box>

      <Box flex={{ lg: 4 }} minW={0}>
        <Stack spaceY={4}>
          <PinnedPostsSidebar threads={threads} courseId={Number(course_id)} />
          <TopPostsSidebar threads={threads} courseId={Number(course_id)} />
        </Stack>
      </Box>
    </Flex>
  );
}
