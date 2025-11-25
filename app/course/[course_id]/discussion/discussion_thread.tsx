import { DiscussionThreadNotification } from "@/components/notifications/notification-teaser";
import { Button } from "@/components/ui/button";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton";
import StudentSummaryTrigger from "@/components/ui/student-summary";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useDiscussionThreadReadStatus,
  useDiscussionThreadTeaser,
  useUpdateThreadTeaser
} from "@/hooks/useCourseController";
import useDiscussionThreadChildren, { useDiscussionThreadsController } from "@/hooks/useDiscussionThreadRootController";
import { useNotifications } from "@/hooks/useNotifications";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useIntersection } from "@/hooks/useViewportIntersection";
import { DiscussionThread as DiscussionThreadType } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Container, Flex, HStack, Link, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

export function DiscussionThreadReply({
  thread,
  visible,
  setVisible
}: {
  thread: DiscussionThreadType | undefined;
  visible: boolean;
  setVisible: (visible: boolean) => void;
}) {
  // const invalidate = useInvalidate();
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const trackEvent = useTrackEvent();
  const { public_profile_id } = useClassProfiles();

  // Focus the textarea when the reply becomes visible
  useEffect(() => {
    if (visible && messageInputRef.current) {
      // Small delay to ensure the component is fully rendered
      setTimeout(() => {
        messageInputRef.current?.focus();
      }, 100);
    }
  }, [visible]);
  const { tableController } = useDiscussionThreadsController();

  const sendMessage = useCallback(
    async (message: string, profile_id: string, close = true) => {
      if (!thread) {
        return;
      }
      const result = await tableController.create({
        subject: `Re: ${thread.subject}`,
        parent: thread.id,
        root: thread.root || thread.id,
        topic_id: thread.topic_id,
        instructors_only: thread.instructors_only,
        class_id: thread.class_id,
        author: profile_id,
        body: message
      });

      // Track discussion reply
      if (result) {
        const rootId = thread.root || thread.id;

        trackEvent("discussion_reply_posted", {
          thread_id: result.id,
          root_thread_id: rootId,
          course_id: thread.class_id,
          is_anonymous: profile_id === public_profile_id
        });
      }

      // invalidate({
      //     resource: "discussion_threads",
      //     invalidates: ['detail'],
      //     id: thread.parent!
      // });
      if (close) {
        setVisible(false);
      }
    },
    [tableController, setVisible, thread, trackEvent, public_profile_id]
  );
  if (!visible) {
    return <></>;
  }
  return (
    <Container ml="2" w="100%" bg="bg.subtle" p="2" rounded="l3" py="2" px="3">
      <MessageInput
        defaultSingleLine={true}
        enableAnonymousModeToggle={true}
        enableEmojiPicker={true}
        enableGiphyPicker={true}
        enableFilePicker={true}
        sendMessage={sendMessage}
        textAreaRef={messageInputRef}
      />
      <Button variant="ghost" onClick={() => setVisible(false)}>
        Cancel
      </Button>
    </Container>
  );
}

function NotificationAndReadStatusUpdater({
  thread_id,
  root_thread_id
}: {
  thread_id: number;
  root_thread_id: number;
}) {
  const { readStatus, setUnread } = useDiscussionThreadReadStatus(thread_id);
  const { notifications, set_read } = useNotifications("discussion_thread", thread_id);
  const ref = useRef<HTMLDivElement>(null);
  const isVisible = useIntersection(ref, { delay: 1000, rootMargin: "0px" });

  const threadIsUnread = readStatus === null || readStatus?.read_at === null;
  useEffect(() => {
    if (isVisible && threadIsUnread && thread_id && root_thread_id) {
      setUnread(root_thread_id, thread_id, false);
    }
  }, [isVisible, threadIsUnread, setUnread, thread_id, root_thread_id]);
  useEffect(() => {
    const relevantNotifications = notifications.filter((notification) => {
      const body = notification.body as DiscussionThreadNotification;
      return (
        notification.viewed_at === null && body.type === "discussion_thread" && body.root_thread_id === root_thread_id
      );
    });
    relevantNotifications.forEach((notification) => {
      if (!notification.viewed_at) {
        set_read(notification, true);
      }
    });
  }, [notifications, set_read, root_thread_id]);

  if (!root_thread_id) {
    // Handle the case where root_thread_id might be undefined if necessary
    return null; // Or some fallback UI
  }

  return <div ref={ref}>{threadIsUnread ? <Badge colorPalette="red">New</Badge> : ""}</div>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function print(value: any) {
  if (typeof value === "object") {
    return JSON.stringify(value);
  } else {
    if (!value) {
      return "falsy";
    }
    return value.toString();
  }
}
export function useLogIfChanged<T>(name: string, value: T) {
  const previous = useRef(value);
  if (!Object.is(previous.current, value)) {
    console.log(`${name} changed. Old: ${print(previous.current)}, New: ${print(value)} `);
    previous.current = value;
  }
}

// Define the inner component that assumes thread and thread.root are valid
const DiscussionThreadContent = memo(
  ({
    thread,
    originalPoster,
    outerSiblings,
    isFirstDescendantOfParent
  }: {
    thread: DiscussionThreadType & { children: DiscussionThreadType[] }; // Ensure thread is properly typed
    originalPoster: string;
    outerSiblings: string;
    isFirstDescendantOfParent: boolean;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    // We know thread.root is a number here
    const root_thread = useDiscussionThreadTeaser(thread.root!);
    const is_answer = root_thread?.answer === thread.id;
    const { tableController } = useDiscussionThreadsController();

    const [replyVisible, setReplyVisible] = useState(false);
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const { course_id } = useParams();
    const authorProfile = useUserProfile(thread.author);
    const { role } = useClassProfiles();
    const [isEditing, setIsEditing] = useState(false);
    const canEdit = useMemo(() => {
      return authorProfile?.id === originalPoster || role.role === "instructor" || role.role === "grader";
    }, [authorProfile, originalPoster, role.role]);

    const outerBorders = useCallback(
      (present: string): JSX.Element => {
        const ret: JSX.Element[] = [];
        for (let i = 0; i < present.length; i++) {
          if (present[i] === "1") {
            ret.push(
              <Box
                key={i}
                pos="absolute"
                width="2px"
                left={`${(present.length - i - 2) * -32}px`}
                top={i == present.length - 1 && isFirstDescendantOfParent ? "0" : "0"}
                bottom="0"
                bg="border"
              />
            );
          }
        }
        return <>{ret}</>;
      },
      [isFirstDescendantOfParent]
    );

    const childOuterSiblings = useMemo(() => {
      const ret: string[] = [];
      if (thread.children) {
        for (let i = 0; i < thread.children.length; i++) {
          ret.push(outerSiblings + (thread.children.length > 1 && i !== thread.children.length - 1 ? "1" : "0"));
        }
      }
      return ret;
    }, [thread.children, outerSiblings]);

    const updateThread = useUpdateThreadTeaser();
    const trackEvent = useTrackEvent();
    const showReply = useCallback(() => {
      setReplyVisible(true);
    }, []);

    const toggleAnswered = useCallback(async () => {
      // root_thread might still be loading initially, handle that case
      if (!root_thread || thread.root === undefined || thread.id === undefined) {
        // Silently return if data not loaded yet
        return;
      }
      if (is_answer) {
        await updateThread({ id: thread.root!, old: root_thread, values: { answer: null } });
      } else {
        await updateThread({ id: thread.root!, old: root_thread, values: { answer: thread.id } });

        // Track discussion thread marked as answer (only when marking, not unmarking)
        trackEvent("discussion_thread_marked_as_answer", {
          thread_id: thread.id,
          root_thread_id: thread.root!,
          course_id: thread.class_id
        });
      }
    }, [is_answer, updateThread, thread, root_thread, trackEvent]);

    const isAnswered = root_thread?.answer !== undefined && root_thread?.answer !== null;
    const descendant = thread.children.length > 0;

    return (
      <Box>
        <Container pl="8" pr="0" alignSelf="flex-start">
          <Box pos="relative" w="100%" pt="2">
            <Box
              pos="absolute"
              width="5"
              height="8"
              left="8"
              top="0"
              bottom="0"
              borderColor="border"
              roundedBottomLeft="l3"
              borderStartWidth="2px"
              borderBottomWidth="2px"
            />
            {outerBorders(outerSiblings)}
            {descendant && <Box pos="absolute" width="2px" left="16" top="10" bottom="0" bg="border" />}
            <Flex gap="2" ps="14" pt="2" as="article" tabIndex={-1} w="100%">
              {authorProfile ? (
                <Avatar.Root size="sm" variant="outline" shape="square">
                  <Avatar.Fallback name={authorProfile.name} />
                  <Avatar.Image src={authorProfile.avatar_url} />
                </Avatar.Root>
              ) : (
                <SkeletonCircle width="40px" height="40px" />
              )}
              <Stack
                w="100%"
                border={thread.id === root_thread?.answer ? "2px solid var(--chakra-colors-green-500)" : "none"}
                borderRadius="l3"
              >
                <Box bg="bg.muted" rounded="l3" py="2" px="3" ref={ref}>
                  <HStack gap="1">
                    <Text textStyle="sm" fontWeight="semibold">
                      <Link
                        id={`post-${thread.ordinal}`}
                        href={`/course/${thread.class_id}/discussion/${thread.root!}#post-${thread.ordinal}`}
                      >
                        #{thread.ordinal}
                      </Link>
                    </Text>
                    {authorProfile ? (
                      <Text textStyle="sm" fontWeight="semibold">
                        {authorProfile?.name}
                        {authorProfile?.real_name && " (" + authorProfile?.real_name + " to self and instructors)"}
                        {thread.author === originalPoster && (
                          <Badge ml="2" colorPalette="blue">
                            OP
                          </Badge>
                        )}
                        {authorProfile?.flair && (
                          <Badge ml="2" colorPalette={authorProfile?.flair_color}>
                            {authorProfile?.flair}
                          </Badge>
                        )}
                      </Text>
                    ) : (
                      <Skeleton width="100px" height="20px" />
                    )}
                    {isGraderOrInstructor && authorProfile?.private_profile_id && (
                      <StudentSummaryTrigger
                        student_id={authorProfile.private_profile_id}
                        course_id={Number(course_id)}
                      />
                    )}
                    {thread.id === root_thread?.answer && <Badge colorPalette="green">Answer to Question</Badge>}
                    {/* Ensure root_thread_id is valid before passing */}
                    {thread.root !== null && thread.root !== undefined && (
                      <NotificationAndReadStatusUpdater thread_id={thread.id} root_thread_id={thread.root} />
                    )}
                  </HStack>
                  {isEditing ? (
                    <MessageInput
                      sendMessage={async (message) => {
                        await tableController.update(thread.id, {
                          body: message,
                          edited_at: new Date().toISOString()
                        });
                        setIsEditing(false);
                      }}
                      onClose={() => setIsEditing(false)}
                      closeButtonText="Cancel"
                      enableEmojiPicker={true}
                      enableFilePicker={true}
                      enableGiphyPicker={true}
                      sendButtonText="Edit"
                      value={thread.body}
                    />
                  ) : (
                    <Box textStyle="sm" color="fg.muted">
                      <Markdown>{thread.body}</Markdown>
                    </Box>
                  )}
                </Box>
                <HStack fontWeight="semibold" textStyle="xs" ps="2">
                  <Text textStyle="sm" color="fg.muted" ms="3" data-visual-test="blackout">
                    {formatRelative(thread.created_at, new Date())}
                  </Text>
                  <Link onClick={showReply} color="fg.muted">
                    Reply
                  </Link>
                  {canEdit && (
                    <Link onClick={() => setIsEditing(true)} color="fg.muted">
                      Edit
                    </Link>
                  )}
                  {root_thread?.is_question && canEdit && !isAnswered && (
                    <Button variant="surface" onClick={toggleAnswered} size="xs" colorPalette="green">
                      Mark as Answer
                    </Button>
                  )}
                  {canEdit && root_thread?.answer === thread.id && (
                    <Link onClick={toggleAnswered} color="fg.muted">
                      Unmark as answer
                    </Link>
                  )}
                </HStack>
                <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
              </Stack>
            </Flex>
          </Box>
          {thread.children.map((child, index) => (
            <DiscussionThread
              key={child.id}
              thread_id={child.id}
              originalPoster={originalPoster}
              indent={index === 0}
              outerSiblings={childOuterSiblings[index]}
              isFirstDescendantOfParent={index === 0}
            />
          ))}
        </Container>
      </Box>
    );
  }
);
DiscussionThreadContent.displayName = "DiscussionThreadContent";

// Modified outer component
export const DiscussionThread = memo(
  ({
    thread_id,
    outerSiblings,
    isFirstDescendantOfParent,
    originalPoster
  }: {
    thread_id: number;
    indent: boolean; // This prop seems unused in the original logic provided? Keeping it for signature consistency.
    outerSiblings: string;
    isFirstDescendantOfParent: boolean;
    originalPoster: string;
  }) => {
    const thread = useDiscussionThreadChildren(thread_id);

    // Show skeleton if thread or thread.root is not loaded/valid
    if (!thread || thread.root === undefined || thread.root === null) {
      return <Skeleton height="100px" />;
    }

    // Render the content component only when data is ready
    return (
      <DiscussionThreadContent
        thread={thread}
        originalPoster={originalPoster}
        outerSiblings={outerSiblings}
        isFirstDescendantOfParent={isFirstDescendantOfParent}
      />
    );
  }
);
DiscussionThread.displayName = "DiscussionThread";
