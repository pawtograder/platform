"use client";

import DiscordDiscussionMessageLink from "@/components/discord/discord-discussion-message-link";
import { DiscussionThreadLikeButton } from "@/components/ui/discussion-post-summary";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Radio } from "@/components/ui/radio";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton";
import StudentSummaryTrigger from "@/components/ui/student-summary";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourseController, useDiscussionThreadReadStatus, useDiscussionTopics } from "@/hooks/useCourseController";
import useDiscussionThreadChildren, {
  DiscussionThreadsControllerProvider
} from "@/hooks/useDiscussionThreadRootController";
import { useDiscussionThreadFollowStatus } from "@/hooks/useDiscussionThreadWatches";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useTableControllerValueById } from "@/lib/TableController";
import { DiscussionThread as DiscussionThreadType, DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Button, Flex, Heading, HStack, Link, RadioGroup, Text, VStack } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FaExclamationCircle, FaPencilAlt, FaRegStar, FaReply, FaStar, FaThumbtack } from "react-icons/fa";
import { DiscussionThread, DiscussionThreadReply } from "../discussion_thread";
import { ErrorPinModal } from "@/components/discussion/ErrorPinModal";
import { ErrorPinIndicator } from "@/components/discussion/ErrorPinIndicator";
import { useModalManager } from "@/hooks/useModalManager";

function ThreadHeader({ thread, topic }: { thread: DiscussionThreadType; topic: DiscussionTopic | undefined }) {
  const userProfile = useUserProfile(thread.author);
  const { course_id } = useParams();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  return (
    <Box>
      <VStack gap="0" align="start">
        <HStack align="start" gap="2" alignSelf="flex-start">
          {userProfile ? (
            <Avatar.Root size="xs">
              <Avatar.Image src={userProfile?.avatar_url} />
              <Avatar.Fallback>{userProfile?.name?.charAt(0) || "?"}</Avatar.Fallback>
            </Avatar.Root>
          ) : (
            <SkeletonCircle width="20px" height="20px" />
          )}
          <VStack gap="1" alignSelf="flex-start" align="start">
            {thread.instructors_only && <Badge colorPalette="blue">Viewable by poster and staff only</Badge>}
            <Flex wrap="wrap">
              {userProfile ? (
                <Heading size="sm">
                  {userProfile?.name}
                  {userProfile?.real_name && " (" + userProfile?.real_name + " to self and instructors)"}
                </Heading>
              ) : (
                <Skeleton width="100px" />
              )}
              {isGraderOrInstructor && userProfile?.private_profile_id && (
                <StudentSummaryTrigger student_id={userProfile.private_profile_id} course_id={Number(course_id)} />
              )}
              <Text fontSize="sm" color="text.muted" px="1">
                {thread.is_question ? "Asked question" : "Posted note"} #{thread.ordinal} to{" "}
              </Text>
              {topic ? (
                <Badge colorPalette={topic.color}>{topic.topic}</Badge>
              ) : (
                <Skeleton width="100px" height="20px" />
              )}
            </Flex>
            <Text fontSize="sm" color="text.muted">
              {formatRelative(new Date(thread.created_at), new Date())}
            </Text>
            {thread.edited_at && (
              <Text fontSize="sm" color="text.muted">
                Edited {formatRelative(new Date(thread.edited_at), new Date())}
              </Text>
            )}
          </VStack>
        </HStack>
        <Heading size="xl" pt="4" pb="4">
          {thread.subject}
        </Heading>
      </VStack>
    </Box>
  );
}

function ThreadActions({
  thread,
  editing,
  setEditing
}: {
  thread: DiscussionThreadType;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const [replyVisible, setReplyVisible] = useState(false);
  const errorPinModal = useModalManager<number>();
  const { public_profile_id, private_profile_id, role } = useClassProfiles();
  const { discussionThreadTeasers } = useCourseController();
  const canEdit =
    thread.author === public_profile_id ||
    thread.author === private_profile_id ||
    role.role === "instructor" ||
    role.role === "grader";
  const canPin = role.role === "instructor" || role.role === "grader";

  const handleTogglePin = useCallback(async () => {
    const newPinnedStatus = !thread.pinned;

    await discussionThreadTeasers.update(thread.id, {
      pinned: newPinnedStatus
    });
  }, [thread.id, thread.pinned, discussionThreadTeasers]);

  return (
    <Box borderBottom="1px solid" borderColor="border.emphasized" pb="2" pt="4">
      <Tooltip content="Follow">
        <ThreadFollowButton thread={thread} />
      </Tooltip>
      <Tooltip content="Like">
        <DiscussionThreadLikeButton thread={thread} />
      </Tooltip>
      {canEdit && (
        <Tooltip content="Edit">
          <Button aria-label="Edit" onClick={() => setEditing(!editing)} variant="ghost" size="sm">
            <FaPencilAlt />
          </Button>
        </Tooltip>
      )}
      {canPin && (
        <Tooltip content={thread.pinned ? "Unpin from top of feed" : "Pin to top of feed"}>
          <Button
            aria-label={thread.pinned ? "Unpin" : "Pin"}
            onClick={handleTogglePin}
            variant="ghost"
            size="sm"
            color={thread.pinned ? "orange.fg" : "inherit"}
          >
            <FaThumbtack />
          </Button>
        </Tooltip>
      )}
      {canPin && (
        <Tooltip content="Manage Error Pins">
          <HStack gap={1}>
            <ErrorPinIndicator
              discussion_thread_id={thread.id}
              onClick={() => errorPinModal.open(thread.id)}
            />
            <Button
              aria-label="Manage Error Pins"
              onClick={() => errorPinModal.open(thread.id)}
              variant="ghost"
              size="sm"
            >
              <FaExclamationCircle />
            </Button>
          </HStack>
        </Tooltip>
      )}
      <Tooltip content="Reply">
        <Button aria-label="Reply" onClick={() => setReplyVisible(true)} variant="ghost" size="sm">
          <FaReply />
        </Button>
      </Tooltip>
      {/* Discord link - shown if thread has a Discord message (staff only see it) */}
      <DiscordDiscussionMessageLink threadId={thread.id} />
      {/* <Tooltip content="Emote">
        <Button aria-label="Emote" variant="ghost" size="sm">
          <FaSmile />
        </Button>
      </Tooltip> */}
      <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
      {errorPinModal.isOpen && (
        <ErrorPinModal
          isOpen={errorPinModal.isOpen}
          onClose={errorPinModal.close}
          onSuccess={() => {
            errorPinModal.close();
            // Refetch error pins
          }}
          discussion_thread_id={errorPinModal.data || thread.id}
        />
      )}
    </Box>
  );
}

function ThreadFollowButton({ thread }: { thread: DiscussionThreadType }) {
  const { status, setThreadWatchStatus } = useDiscussionThreadFollowStatus(thread.id);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        setThreadWatchStatus(!status);
      }}
    >
      {status ? "Unfollow" : "Follow"}
      {status ? <FaStar /> : <FaRegStar />}
    </Button>
  );
}

function DiscussionPost({ root_id }: { root_id: number }) {
  const discussion_topics = useDiscussionTopics();
  const { discussionThreadTeasers } = useCourseController();
  const rootThread = useTableControllerValueById(discussionThreadTeasers, root_id);
  const [editing, setEditing] = useState(false);
  const [visibility, setVisibility] = useState(rootThread?.instructors_only ? "instructors_only" : "all");
  useEffect(() => {
    setVisibility(rootThread?.instructors_only ? "instructors_only" : "all");
  }, [rootThread?.instructors_only]);

  const { readStatus, setUnread } = useDiscussionThreadReadStatus(root_id);

  useEffect(() => {
    if (!readStatus?.read_at) {
      setUnread(root_id, root_id, false);
    }
  }, [readStatus, setUnread, root_id]);
  const sendMessage = useCallback(
    async (message: string) => {
      await discussionThreadTeasers.update(root_id, {
        body: message,
        edited_at: new Date().toISOString(),
        instructors_only: visibility === "instructors_only"
      });
      setEditing(false);
    },
    [root_id, discussionThreadTeasers, visibility]
  );
  const onClose = useCallback(() => {
    setEditing(false);
  }, [setEditing]);

  if (!discussion_topics || !rootThread) {
    return <Skeleton height="100px" />;
  }
  return (
    <>
      <ThreadHeader thread={rootThread} topic={discussion_topics.find((t) => t.id === rootThread.topic_id)} />
      <Box>
        {editing ? (
          <>
            <HStack>
              <Heading size="sm">Thread visibility:</Heading>
              <RadioGroup.Root
                value={visibility}
                onValueChange={(value) => {
                  setVisibility(value.value as unknown as "instructors_only" | "all");
                }}
              >
                <Radio value="instructors_only">Staff only</Radio>
                <Radio value="all">Entire Class</Radio>
              </RadioGroup.Root>
            </HStack>
            <MessageInput
              sendMessage={sendMessage}
              enableEmojiPicker={true}
              enableFilePicker={true}
              enableGiphyPicker={true}
              sendButtonText="Edit"
              closeButtonText="Cancel"
              onClose={onClose}
              value={rootThread.body}
            />
          </>
        ) : (
          <Markdown>{rootThread.body}</Markdown>
        )}
      </Box>
      {rootThread.answer && <DiscussionThreadAnswer answer_id={rootThread.answer} />}
      <ThreadActions thread={rootThread} editing={editing} setEditing={setEditing} />
    </>
  );
}

function DiscussionThreadAnswer({ answer_id }: { answer_id: number }) {
  const answer = useDiscussionThreadChildren(answer_id);
  const userProfile = useUserProfile(answer?.author);
  if (!answer || !userProfile) {
    return <Skeleton height="100px" />;
  }
  return (
    <Link href={`/course/${answer.class_id}/discussion/${answer.root}#post-${answer.ordinal}`}>
      <Box m="2" p="2" border="1px solid" borderColor="border.info" rounded="l3" bg="bg.info" minW="xl">
        Answered in #{answer.ordinal} by {userProfile.name}{" "}
        {userProfile.flair && <Badge colorPalette={userProfile.flair_color}>{userProfile.flair}</Badge>}
      </Box>
    </Link>
  );
}

function DiscussionPostWithChildren({ root_id }: { root_id: number }) {
  const thread = useDiscussionThreadChildren(root_id);
  const courseController = useCourseController();
  useEffect(() => {
    document.title = `${courseController.course.name} - Discussion - ${thread?.subject}`;
  }, [courseController.course.name, thread?.subject]);
  return (
    <>
      <DiscussionPost root_id={root_id} />
      {thread &&
        thread.children.map((child, index) => (
          <DiscussionThread
            key={child.id}
            thread_id={child.id}
            indent={false}
            outerSiblings={thread.children.length > 1 && index !== thread.children.length - 1 ? "1" : "0"}
            isFirstDescendantOfParent={index === 0}
            originalPoster={thread.author}
          />
        ))}
    </>
  );
}

export default function ThreadView() {
  const { root_id } = useParams();
  const rootId = Number.parseInt(root_id as string);
  return (
    <Box width="100%">
      <DiscussionThreadsControllerProvider root_id={rootId}>
        <DiscussionPostWithChildren root_id={rootId} />
      </DiscussionThreadsControllerProvider>
    </Box>
  );
}
