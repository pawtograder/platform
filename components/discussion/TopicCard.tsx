"use client";

import { TopicIcon } from "@/components/discussion/TopicIcon";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import Markdown from "@/components/ui/markdown";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { FaRegStar, FaStar } from "react-icons/fa";

export function TopicCard({
  topic,
  postCount,
  unreadCount,
  selected,
  onClickAction,
  showFollowStar = false,
  isFollowed = false,
  followDisabled = false,
  onToggleFollowAction
}: {
  topic: DiscussionTopic;
  postCount: number;
  unreadCount: number;
  selected: boolean;
  onClickAction: () => void;
  showFollowStar?: boolean;
  isFollowed?: boolean;
  followDisabled?: boolean;
  onToggleFollowAction?: () => void;
}) {
  const topicColor = topic?.color ? `${topic.color}.500` : "gray.400";

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClickAction}
      onMouseDown={(e) => {
        // Prevent mouse-focus causing scroll jumps in scroll containers.
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClickAction();
        }
      }}
      px="2"
      py="1"
      borderWidth="1px"
      borderColor={selected ? "border.emphasized" : "border.muted"}
      bg={selected ? "bg.muted" : "bg.panel"}
      _hover={{ bg: "bg.subtle" }}
      rounded="md"
      cursor="pointer"
    >
      <HStack gap="3" align="flex-start">
        <Box pt="0.5">
          <TopicIcon name={topic.icon} color={topicColor} boxSize="5" />
        </Box>
        <Stack spaceY="0" flex="1" minW={0}>
          <HStack justify="space-between" align="flex-start" gap="2">
            <Text fontWeight="semibold" truncate mb={0}>
              {topic.topic}
            </Text>
            <HStack gap="1" align="center">
              {showFollowStar && (
                <Tooltip
                  content={
                    isFollowed
                      ? "Unfollow topic - You'll stop receiving notifications for new posts in this topic and new posts from this topic will be removed from My Feed"
                      : "Follow topic - You'll receive email notifications for new posts in this topic (not replies) and new posts will appear in My Feed"
                  }
                  showArrow
                >
                  <Button
                    aria-label={isFollowed ? "Unfollow topic" : "Follow topic"}
                    variant="ghost"
                    size="xs"
                    disabled={followDisabled}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleFollowAction?.();
                    }}
                  >
                    <Icon as={isFollowed ? FaStar : FaRegStar} color={isFollowed ? "yellow.400" : "fg.muted"} />
                  </Button>
                </Tooltip>
              )}
              {unreadCount > 0 && (
                <Badge colorPalette="blue" variant="solid">
                  {unreadCount}
                </Badge>
              )}
            </HStack>
          </HStack>
          <Markdown>{topic.description}</Markdown>
          <Text fontSize="xs" color="fg.muted">
            {postCount} post{postCount === 1 ? "" : "s"}
          </Text>
        </Stack>
      </HStack>
    </Box>
  );
}
