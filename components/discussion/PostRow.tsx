"use client";

import { toaster } from "@/components/ui/toaster";
import {
  useDiscussionThreadReadStatus,
  useDiscussionThreadTeaser,
  useDiscussionTopics,
  useRootDiscussionThreadReadStatuses,
  useCourseController
} from "@/hooks/useCourseController";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useDiscussionThreadFollowStatus } from "@/hooks/useDiscussionThreadWatches";
import { useDiscussionThreadLikes } from "@/hooks/useDiscussionThreadLikes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { TopicIcon } from "@/components/discussion/TopicIcon";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge, Box, HStack, Icon, Spacer, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  FaCheck,
  FaCheckCircle,
  FaCircle,
  FaHeart,
  FaQuestionCircle,
  FaRegHeart,
  FaRegStar,
  FaStar,
  FaThumbtack
} from "react-icons/fa";

export function PostRow({
  threadId,
  href,
  selected,
  showTopicBadge = true,
  variant = "default"
}: {
  threadId: number;
  href: string;
  selected?: boolean;
  showTopicBadge?: boolean;
  variant?: "default" | "compact";
}) {
  const thread = useDiscussionThreadTeaser(threadId);
  const topics = useDiscussionTopics();
  const topic = useMemo(() => topics?.find((t) => t.id === thread?.topic_id), [topics, thread?.topic_id]);
  const userProfile = useUserProfile(thread?.author);
  const { private_profile_id } = useClassProfiles();

  const { readStatus } = useDiscussionThreadReadStatus(threadId);
  const childrenReadStatuses = useRootDiscussionThreadReadStatuses(threadId);
  const numReadDescendants = useMemo(
    () => childrenReadStatuses?.filter((s) => s.read_at != null).length ?? 0,
    [childrenReadStatuses]
  );

  const isUnread = readStatus === null || readStatus?.read_at === null;
  const hasUnreadReplies = !isUnread && numReadDescendants < (thread?.children_count ?? 0);

  const statusIndicator = isUnread ? (
    <Icon as={FaCircle} color="blue.500" boxSize="2" />
  ) : hasUnreadReplies ? (
    <Icon as={FaCircle} color="orange.400" boxSize="2" />
  ) : (
    <Icon as={FaCheck} color="gray.400" boxSize="3" />
  );

  const topicColor = topic?.color ? `${topic.color}.500` : "gray.400";

  const likeStatus = useDiscussionThreadLikes(threadId);
  const { discussionThreadLikes, discussionThreadTeasers } = useCourseController();
  const [likeLoading, setLikeLoading] = useState(false);

  const { status: isFollowing, setThreadWatchStatus: setThreadFollowStatus } =
    useDiscussionThreadFollowStatus(threadId);

  const toggleLike = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!thread) return;
    if (!private_profile_id) return;
    setLikeLoading(true);
    try {
      if (likeStatus) {
        await discussionThreadLikes.hardDelete(likeStatus.id);
      } else {
        // Emoji is fixed today; UI uses heart but underlying record is still a like.
        await discussionThreadLikes.create({ discussion_thread: thread.id, creator: private_profile_id, emoji: "👍" });
      }
      await discussionThreadTeasers.refetchByIds([thread.id]);
    } catch {
      toaster.error({ title: "Error", description: "Could not update like. Please try again." });
      await discussionThreadTeasers.refetchByIds([thread.id]);
    } finally {
      setLikeLoading(false);
    }
  };

  const toggleFollow = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await setThreadFollowStatus(!isFollowing);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to toggle follow status:", error);
      toaster.error({
        title: "Error",
        description: "Could not update follow status. Please try again."
      });
    }
  };

  if (!thread) {
    return (
      <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
        <Text color="fg.muted" fontSize="sm">
          Loading…
        </Text>
      </Box>
    );
  }

  if (variant === "compact") {
    return (
      <Box asChild>
        <Link href={href}>
          <Box
            px="4"
            py="2"
            borderBottomWidth="1px"
            borderColor="border.muted"
            bg={selected ? "bg.muted" : isUnread ? "bg.info" : "bg"}
            _hover={{ bg: "bg.subtle" }}
          >
            <Stack spaceY="1">
              <HStack gap="2" align="flex-start">
                <Box pt="0.5">{statusIndicator}</Box>
                <Box pt="0.5">
                  <TopicIcon name={topic?.icon} color={topicColor} boxSize="3" />
                </Box>
                <Stack spaceY="0.5" flex="1" minW={0}>
                  <HStack gap="1.5" minW={0} wrap="wrap">
                    {thread.pinned && <Icon as={FaThumbtack} color="fg.info" boxSize="2.5" />}
                    <Text fontWeight="semibold" fontSize="sm" truncate>
                      {thread.subject}
                    </Text>
                    {thread.is_question && !thread.answer && (
                      <Icon as={FaQuestionCircle} color="red.500" boxSize="3" aria-label="Unanswered" />
                    )}
                    {thread.is_question && thread.answer && (
                      <Icon as={FaCheckCircle} color="green.500" boxSize="3" aria-label="Answered" />
                    )}
                  </HStack>
                  <HStack gap="2" fontSize="xs" color="fg.muted" wrap="wrap">
                    <Text color="fg.muted" fontWeight="medium">
                      {userProfile?.name ?? ""}
                    </Text>
                    <Text>•</Text>
                    <Text>{formatRelative(new Date(thread.created_at), new Date())}</Text>
                    <Text>•</Text>
                    <Text>{thread.children_count ?? 0} replies</Text>
                    <Text>•</Text>
                    <Text>{thread.likes_count ?? 0} likes</Text>
                  </HStack>
                </Stack>
              </HStack>
            </Stack>
          </Box>
        </Link>
      </Box>
    );
  }

  return (
    <Box asChild>
      <Link href={href}>
        <HStack
          gap="3"
          px="4"
          py="3"
          borderBottomWidth="1px"
          borderColor="border.muted"
          align="flex-start"
          bg={selected ? "bg.muted" : isUnread ? "bg.info" : "bg"}
          _hover={{ bg: "bg.subtle" }}
        >
          <Box pt="1">{statusIndicator}</Box>

          <Box pt="0.5">
            <TopicIcon name={topic?.icon} color={topicColor} boxSize="4" />
          </Box>

          <Stack spaceY="1" flex="1" minW={0}>
            <HStack gap="2" minW={0}>
              {thread.pinned && <Icon as={FaThumbtack} color="fg.info" boxSize="3" />}
              {showTopicBadge && topic && (
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
              <Spacer />
            </HStack>

            <HStack gap="3" fontSize="xs" color="fg.muted" wrap="wrap">
              <Text color="fg.muted" fontWeight="medium">
                {userProfile?.name ?? ""}
              </Text>
              <Text>{formatRelative(new Date(thread.created_at), new Date())}</Text>
              <Text>{thread.children_count ?? 0} replies</Text>
              <Text>{thread.likes_count ?? 0} likes</Text>
            </HStack>
          </Stack>

          <HStack gap="1" flexShrink={0}>
            <Button
              aria-label={likeStatus ? "Unlike" : "Like"}
              variant="ghost"
              size="sm"
              loading={likeLoading}
              onClick={toggleLike}
            >
              <Icon as={likeStatus ? FaHeart : FaRegHeart} />
            </Button>
            <Tooltip
              content={
                isFollowing
                  ? "Unfollow post - You'll stop receiving notifications for replies to this post and it will be removed from My Feed"
                  : "Follow post - You'll receive email notifications for all replies to this post and it will appear in My Feed"
              }
              showArrow
            >
              <Button aria-label={isFollowing ? "Unfollow" : "Follow"} variant="ghost" size="sm" onClick={toggleFollow}>
                <Icon as={isFollowing ? FaStar : FaRegStar} />
              </Button>
            </Tooltip>
          </HStack>
        </HStack>
      </Link>
    </Box>
  );
}
