"use client";
import type { DiscussionThread as DiscussionThreadType, DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Button, Flex, HStack, Icon, Spacer, Stack, Status, Text, VStack } from "@chakra-ui/react";
import excerpt from "@stefanprobst/remark-excerpt";

import Markdown from "@/components/ui/markdown";
import { useDiscussionThreadLikes } from "@/hooks/useDiscussionThreadLikes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import type { ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { formatRelative } from "date-fns";
import { useCallback } from "react";
import { BsChat } from "react-icons/bs";
import { FaCheckCircle, FaRegHeart, FaRegStickyNote } from "react-icons/fa";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { Skeleton } from "./skeleton";
import { useClassProfiles } from "@/hooks/useClassProfiles";
export function DiscussionThreadLikeButton({ thread }: { thread: DiscussionThreadType | ThreadWithChildren }) {
  const supabase = createClient();
  const { private_profile_id } = useClassProfiles();
  const likeStatus = useDiscussionThreadLikes(thread.id);
  const toggleLike = useCallback(async () => {
    if (likeStatus) {
      await supabase.from("discussion_thread_likes").delete().eq("id", likeStatus.id);
    } else {
      await supabase
        .from("discussion_thread_likes")
        .insert({ discussion_thread: thread.id, creator: private_profile_id!, emoji: "👍" });
    }
  }, [thread.id, likeStatus, private_profile_id, supabase]);

  return (
    <Button variant="ghost" size="sm" onClick={toggleLike}>
      {likeStatus ? <Icon as={FaRegHeart} /> : <Icon as={FaRegHeart} />}
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
          <DiscussionThreadLikeButton thread={thread} />
          <Text textStyle="sm" fontWeight="semibold">
            {thread.likes_count}
          </Text>
        </VStack>
      </Flex>
    </Box>
  );
}
