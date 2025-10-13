"use client";
import { DiscussionThread as DiscussionThreadType, DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Button, Flex, HStack, Icon, Spacer, Stack, Status, Text, VStack } from "@chakra-ui/react";
import excerpt from "@stefanprobst/remark-excerpt";
import * as Sentry from "@sentry/nextjs";
import { toaster } from "@/components/ui/toaster";
import Markdown from "@/components/ui/markdown";
import { useDiscussionThreadLikes } from "@/hooks/useDiscussionThreadLikes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { formatRelative } from "date-fns";
import { useCallback, useState } from "react";
import { BsChat } from "react-icons/bs";
import { FaCheckCircle, FaRegHeart, FaRegStickyNote } from "react-icons/fa";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { Skeleton } from "./skeleton";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useDiscussionThreadsController } from "@/hooks/useDiscussionThreadRootController";
export function DiscussionThreadLikeButton({ thread }: { thread: DiscussionThreadType | ThreadWithChildren }) {
  const { private_profile_id } = useClassProfiles();
  const likeStatus = useDiscussionThreadLikes(thread.id);
  const trackEvent = useTrackEvent();
  const [loading, setLoading] = useState(false);
  const { discussionThreadLikes } = useCourseController();
  const threadController = useDiscussionThreadsController();

  const toggleLike = useCallback(async () => {
    setLoading(true);
    try {
      if (likeStatus) {
        // Unlike - use TableController hardDelete
        await discussionThreadLikes.hardDelete(likeStatus.id);
      } else {
        // Like - use TableController create
        await discussionThreadLikes.create({
          discussion_thread: thread.id,
          creator: private_profile_id!,
          emoji: "👍"
        });
        // Track discussion thread like
        trackEvent("discussion_thread_liked", {
          thread_id: thread.id,
          course_id: thread.class_id
        });
      }
      await threadController.tableController.refetchByIds([thread.id]);
    } catch (error) {
      Sentry.captureException(error);
      toaster.error({
        title: "Error",
        description: "Error in toggleLike",
        type: "error"
      });
      await threadController.tableController.refetchByIds([thread.id]);
    } finally {
      setLoading(false);
    }
  }, [thread.id, likeStatus, private_profile_id, discussionThreadLikes, thread.class_id, trackEvent, threadController]);

  return (
    <Button variant="ghost" size="sm" onClick={toggleLike} loading={loading}>
      {thread.likes_count} {likeStatus ? <Icon as={FaRegHeart} /> : <Icon as={FaRegHeart} />}
    </Button>
  );
}
export function DiscussionPostSummary({
  thread,
  topic
}: {
  thread: DiscussionThreadType | ThreadWithChildren;
  topic: DiscussionTopic;
}) {
  const userProfile = useUserProfile(thread.author);
  const getIcon = () => {
    if (thread.is_question) {
      if (thread.answer) {
        return <Icon as={FaCheckCircle} />;
      }
      return <Icon as={RxQuestionMarkCircled} />;
    }
    return <Icon as={FaRegStickyNote} />;
  };
  const comments = (
    <HStack>
      {" "}
      <BsChat />
      <Text textStyle="sm" color="fg.muted">
        {thread.children_count}
      </Text>
    </HStack>
  );
  return (
    <Box minWidth={"fit-content"} width="auto">
      <Flex borderWidth="1px" divideX="1px" borderRadius="l3" bg="bg" _hover={{ bg: "bg.subtle" }}>
        <Stack p="6" flex="1">
          <Badge variant="surface" alignSelf="flex-start" colorPalette={topic.color}>
            {topic.topic}
            {getIcon()}
          </Badge>
          <Text textStyle="lg" fontWeight="semibold" mt="2">
            {thread.subject}
          </Text>
          <Markdown
            components={{
              a: ({ children }) => {
                return <>{children}</>;
              }
            }}
            remarkPlugins={[[excerpt, { maxLength: 500 }]]}
          >
            {thread.body}
          </Markdown>

          <HStack fontWeight="medium" mt="4">
            {userProfile ? (
              <HStack>
                <Avatar.Root size="sm" variant="outline" shape="square">
                  <Avatar.Fallback name={userProfile?.name} />
                  <Avatar.Image src={userProfile?.avatar_url} />
                </Avatar.Root>
                <Text textStyle="sm" hideBelow="sm">
                  {userProfile?.name}
                </Text>
              </HStack>
            ) : (
              <Skeleton width="100px" />
            )}
            <Flex wrap={{ base: "wrap", sm: "nowrap" }}>
              <Text textStyle="sm" color="fg.muted" ms="3">
                {formatRelative(thread.created_at, new Date())}
              </Text>
              <Spacer />

              <HStack gap="4">
                <HStack gap="1">
                  <Button variant="ghost">{comments}</Button>
                </HStack>
                <Status.Root hideBelow="sm">
                  <Status.Indicator />
                  {/* {thread.topic} */}
                </Status.Root>
              </HStack>
            </Flex>
          </HStack>
        </Stack>
        <VStack px="4" justify="center" flexShrink="0">
          {/* <Button variant="ghost" size="sm" ><BsChevronUp /></Button> */}
          {thread.likes_count} <Icon as={thread.likes_count > 0 ? FaRegHeart : FaRegHeart} />
        </VStack>
      </Flex>
    </Box>
  );
}
