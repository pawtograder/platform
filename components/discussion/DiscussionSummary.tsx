import { createClient } from "@/utils/supabase/server";
import { Badge, Box, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import Link from "next/link";
import { DiscussionPinnedHeader } from "./DiscussionPinnedHeader";
import { DiscussionStatusIndicator } from "./DiscussionStatusIndicator";
import { TopicIcon } from "./TopicIcon";

type DiscussionSummaryProps = {
  courseId: number;
  userId: string;
};

export async function DiscussionSummary({ courseId, userId }: DiscussionSummaryProps) {
  const supabase = await createClient();

  // Get user's private profile ID
  const { data: userRole } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", courseId)
    .eq("user_id", userId)
    .eq("disabled", false)
    .single();

  if (!userRole?.private_profile_id) {
    return null;
  }

  // Query pinned threads
  const { data: pinnedThreadsRaw } = await supabase
    .from("discussion_threads")
    .select(
      `
      id,
      subject,
      pinned,
      created_at,
      children_count,
      is_question,
      answer,
      topic_id,
      discussion_topics(topic, color, icon)
    `
    )
    .eq("root_class_id", courseId)
    .eq("pinned", true)
    .order("created_at", { ascending: false })
    .limit(5);

  // Get read statuses for pinned threads
  const pinnedThreadIds = pinnedThreadsRaw?.map((t) => t.id) ?? [];
  let pinnedThreads: Array<{
    id: number;
    subject: string;
    pinned: boolean;
    created_at: string;
    children_count: number;
    is_question: boolean;
    answer: number | null;
    topic_id: number;
    discussion_topics: { topic: string; color: string; icon: string | null } | null;
    read_at: string | null;
    unread_replies_count: number;
    has_unread_replies: boolean;
  }> = [];

  if (pinnedThreadIds.length > 0) {
    // Get read statuses for pinned threads
    const { data: pinnedReadStatuses } = await supabase
      .from("discussion_thread_read_status")
      .select("discussion_thread_id, read_at")
      .eq("user_id", userId)
      .in("discussion_thread_id", pinnedThreadIds);

    const pinnedReadAtByThreadId = new Map<number, string | null>();
    pinnedReadStatuses?.forEach((s) => {
      pinnedReadAtByThreadId.set(s.discussion_thread_id, s.read_at);
    });

    // Get child threads for pinned posts to check for unread replies
    const { data: pinnedChildThreads } = await supabase
      .from("discussion_threads")
      .select("id, root")
      .in("root", pinnedThreadIds);

    const pinnedChildThreadIdsByRoot = new Map<number, number[]>();
    pinnedChildThreads?.forEach((t) => {
      if (t.root && t.id !== t.root) {
        const existing = pinnedChildThreadIdsByRoot.get(t.root) ?? [];
        existing.push(t.id);
        pinnedChildThreadIdsByRoot.set(t.root, existing);
      }
    });

    // Get read statuses for child threads
    const pinnedChildThreadIds = Array.from(pinnedChildThreadIdsByRoot.values()).flat();
    const { data: pinnedChildReadStatuses } =
      pinnedChildThreadIds.length > 0
        ? await supabase
            .from("discussion_thread_read_status")
            .select("discussion_thread_id, read_at")
            .eq("user_id", userId)
            .in("discussion_thread_id", pinnedChildThreadIds)
        : { data: null };

    const pinnedChildReadAtByThreadId = new Map<number, string | null>();
    pinnedChildReadStatuses?.forEach((s) => {
      pinnedChildReadAtByThreadId.set(s.discussion_thread_id, s.read_at);
    });

    // Count unread replies for pinned threads
    const pinnedUnreadRepliesByRoot = new Map<number, number>();
    pinnedChildThreadIdsByRoot.forEach((childIds, rootId) => {
      const unreadCount = childIds.filter((childId) => {
        const readAt = pinnedChildReadAtByThreadId.get(childId);
        return readAt === null;
      }).length;
      if (unreadCount > 0) {
        pinnedUnreadRepliesByRoot.set(rootId, unreadCount);
      }
    });

    pinnedThreads =
      pinnedThreadsRaw?.map((thread) => {
        const readAt = pinnedReadAtByThreadId.get(thread.id) ?? null;
        const isUnread = readAt === null;
        const unreadReplies = pinnedUnreadRepliesByRoot.get(thread.id) ?? 0;
        const hasUnreadReplies = !isUnread && unreadReplies > 0;

        return {
          ...thread,
          read_at: readAt,
          unread_replies_count: unreadReplies,
          has_unread_replies: hasUnreadReplies
        };
      }) ?? [];
  }

  // Query followed threads with unread status
  const { data: followedWatches } = await supabase
    .from("discussion_thread_watchers")
    .select("discussion_thread_root_id")
    .eq("class_id", courseId)
    .eq("user_id", userId)
    .eq("enabled", true);

  const followedThreadIds = followedWatches?.map((w) => w.discussion_thread_root_id) ?? [];

  let followedThreadsWithUnread: Array<{
    id: number;
    subject: string;
    created_at: string;
    children_count: number;
    is_question: boolean;
    answer: number | null;
    topic_id: number;
    discussion_topics: { topic: string; color: string; icon: string | null } | null;
    read_at: string | null;
    has_unread_replies: boolean;
    unread_replies_count: number;
  }> = [];

  if (followedThreadIds.length > 0) {
    const { data: followedThreads } = await supabase
      .from("discussion_threads")
      .select(
        `
        id,
        subject,
        created_at,
        children_count,
        is_question,
        answer,
        topic_id,
        discussion_topics(topic, color, icon)
      `
      )
      .eq("root_class_id", courseId)
      .in("id", followedThreadIds)
      .order("created_at", { ascending: false })
      .limit(10);

    // Get all child threads (replies) for followed threads
    const { data: childThreads } = await supabase
      .from("discussion_threads")
      .select("id, root")
      .in("root", followedThreadIds);

    const childThreadIds = childThreads?.filter((t) => t.root && t.id !== t.root).map((t) => t.id) ?? [];
    const childThreadIdsByRoot = new Map<number, number[]>();
    childThreads?.forEach((t) => {
      if (t.root && t.id !== t.root) {
        // Only count actual replies, not the root thread itself
        const existing = childThreadIdsByRoot.get(t.root) ?? [];
        existing.push(t.id);
        childThreadIdsByRoot.set(t.root, existing);
      }
    });

    // Get read statuses for followed threads and their children
    const allThreadIdsToCheck = [...followedThreadIds, ...childThreadIds];
    const { data: readStatuses } = await supabase
      .from("discussion_thread_read_status")
      .select("discussion_thread_id, read_at")
      .eq("user_id", userId)
      .in("discussion_thread_id", allThreadIdsToCheck);

    const readAtByThreadId = new Map<number, string | null>();
    readStatuses?.forEach((s) => {
      readAtByThreadId.set(s.discussion_thread_id, s.read_at);
    });

    // Count unread replies for each followed thread
    const unreadRepliesByRoot = new Map<number, number>();
    childThreadIdsByRoot.forEach((childIds, rootId) => {
      const unreadCount = childIds.filter((childId) => {
        const readAt = readAtByThreadId.get(childId);
        return readAt === null;
      }).length;
      if (unreadCount > 0) {
        unreadRepliesByRoot.set(rootId, unreadCount);
      }
    });

    followedThreadsWithUnread =
      followedThreads?.map((thread) => {
        const readAt = readAtByThreadId.get(thread.id) ?? null;
        const isUnread = readAt === null;
        const unreadReplies = unreadRepliesByRoot.get(thread.id) ?? 0;
        const hasUnreadReplies = !isUnread && unreadReplies > 0;

        return {
          ...thread,
          read_at: readAt,
          has_unread_replies: hasUnreadReplies,
          unread_replies_count: unreadReplies
        };
      }) ?? [];

    // Filter to only show threads with unread updates
    followedThreadsWithUnread = followedThreadsWithUnread.filter((t) => t.read_at === null || t.has_unread_replies);
  }

  const hasPinned = pinnedThreads && pinnedThreads.length > 0;
  const hasUnreadFollowed = followedThreadsWithUnread.length > 0;
  const hasAnyContent = hasPinned || hasUnreadFollowed;

  if (!hasAnyContent) {
    return null;
  }

  return (
    <Box>
      <HStack justify="space-between" align="center" mb={4}>
        <Heading size="lg">Discussion Activity</Heading>
        <Link href={`/course/${courseId}/discussion`}>View all →</Link>
      </HStack>

      <Stack spaceY={4}>
        {/* Pinned Posts */}
        {hasPinned && (
          <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
            <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
              <DiscussionPinnedHeader />
            </Box>
            <Stack spaceY="0">
              {pinnedThreads.map((thread) => {
                const topic = thread.discussion_topics;
                const topicColor = topic?.color ? `${topic.color}.500` : "gray.400";
                const isUnread = thread.read_at === null;
                return (
                  <Link key={thread.id} href={`/course/${courseId}/discussion/${thread.id}`}>
                    <Box
                      px="4"
                      py="3"
                      borderBottomWidth="1px"
                      borderColor="border.muted"
                      bg={isUnread ? "bg.info" : "bg"}
                      _hover={{ bg: "bg.subtle" }}
                      _last={{ borderBottomWidth: "0" }}
                    >
                      <HStack gap="2" align="flex-start">
                        <Box pt="1">
                          <DiscussionStatusIndicator isUnread={isUnread} hasUnreadReplies={thread.has_unread_replies} />
                        </Box>
                        <Box pt="0.5">
                          <TopicIcon name={topic?.icon} color={topicColor} boxSize="4" />
                        </Box>
                        <Stack spaceY="1" flex="1" minW={0}>
                          <HStack gap="2" minW={0} wrap="wrap">
                            {topic && (
                              <Badge colorPalette={topic.color} variant="subtle" flexShrink={0}>
                                {topic.topic}
                              </Badge>
                            )}
                            <Text fontWeight="semibold" truncate>
                              {thread.subject}
                            </Text>
                            {thread.is_question && !thread.answer && (
                              <Badge colorPalette="red" variant="subtle">
                                Unanswered
                              </Badge>
                            )}
                            {thread.is_question && thread.answer && (
                              <Badge colorPalette="green" variant="subtle">
                                Answered
                              </Badge>
                            )}
                          </HStack>
                          <HStack gap="3" fontSize="xs" color="fg.muted" wrap="wrap">
                            <Text>{formatRelative(new Date(thread.created_at), new Date())}</Text>
                            <Text>•</Text>
                            <Text>{thread.children_count ?? 0} replies</Text>
                            {isUnread && (
                              <>
                                <Text>•</Text>
                                <Badge colorPalette="blue" variant="subtle" size="sm">
                                  Unread
                                </Badge>
                              </>
                            )}
                            {thread.has_unread_replies && (
                              <>
                                <Text>•</Text>
                                <Badge colorPalette="orange" variant="subtle" size="sm">
                                  {thread.unread_replies_count} new{" "}
                                  {thread.unread_replies_count === 1 ? "reply" : "replies"}
                                </Badge>
                              </>
                            )}
                          </HStack>
                        </Stack>
                      </HStack>
                    </Box>
                  </Link>
                );
              })}
            </Stack>
          </Box>
        )}

        {/* Followed Posts with Unread Updates */}
        {hasUnreadFollowed && (
          <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
            <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
              <Heading size="sm">Unread Updates</Heading>
            </Box>
            <Stack spaceY="0">
              {followedThreadsWithUnread.map((thread) => {
                const topic = thread.discussion_topics;
                const topicColor = topic?.color ? `${topic.color}.500` : "gray.400";
                const isUnread = thread.read_at === null;

                return (
                  <Link key={thread.id} href={`/course/${courseId}/discussion/${thread.id}`}>
                    <Box
                      px="4"
                      py="3"
                      borderBottomWidth="1px"
                      borderColor="border.muted"
                      bg={isUnread ? "bg.info" : "bg"}
                      _hover={{ bg: "bg.subtle" }}
                      _last={{ borderBottomWidth: "0" }}
                    >
                      <HStack gap="3" align="flex-start">
                        <Box pt="1">
                          <DiscussionStatusIndicator isUnread={isUnread} hasUnreadReplies={thread.has_unread_replies} />
                        </Box>
                        <Box pt="0.5">
                          <TopicIcon name={topic?.icon} color={topicColor} boxSize="4" />
                        </Box>
                        <Stack spaceY="1" flex="1" minW={0}>
                          <HStack gap="2" minW={0} wrap="wrap">
                            {topic && (
                              <Badge colorPalette={topic.color} variant="subtle" flexShrink={0}>
                                {topic.topic}
                              </Badge>
                            )}
                            <Text fontWeight="semibold" truncate>
                              {thread.subject}
                            </Text>
                            {thread.is_question && !thread.answer && (
                              <Badge colorPalette="red" variant="subtle">
                                Unanswered
                              </Badge>
                            )}
                            {thread.is_question && thread.answer && (
                              <Badge colorPalette="green" variant="subtle">
                                Answered
                              </Badge>
                            )}
                          </HStack>
                          <HStack gap="3" fontSize="xs" color="fg.muted" wrap="wrap">
                            <Text>{formatRelative(new Date(thread.created_at), new Date())}</Text>
                            <Text>•</Text>
                            <Text>{thread.children_count ?? 0} replies</Text>
                            {isUnread && (
                              <>
                                <Text>•</Text>
                                <Badge colorPalette="blue" variant="subtle" size="sm">
                                  Unread
                                </Badge>
                              </>
                            )}
                            {thread.has_unread_replies && (
                              <>
                                <Text>•</Text>
                                <Badge colorPalette="orange" variant="subtle" size="sm">
                                  {thread.unread_replies_count} new{" "}
                                  {thread.unread_replies_count === 1 ? "reply" : "replies"}
                                </Badge>
                              </>
                            )}
                          </HStack>
                        </Stack>
                      </HStack>
                    </Box>
                  </Link>
                );
              })}
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  );
}
