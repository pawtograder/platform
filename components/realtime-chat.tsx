"use client";

import { ChatMessageItem, type UnifiedMessage } from "@/components/chat-message";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { toaster } from "@/components/ui/toaster";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { formatTimeRemaining, useModerationStatus } from "@/hooks/useModerationStatus";
import {
  useHelpRequestMessages,
  useOfficeHoursController,
  useRealtimeChat,
  useHelpRequest,
  type ChatMessage
} from "@/hooks/useOfficeHoursRealtime";
import { Box, Button, Flex, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import { useMeetingWindows } from "@/hooks/useMeetingWindows";
import { BsCameraVideo, BsPersonVideo2 } from "react-icons/bs";
import { useCreate } from "@refinedev/core";
import { X } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface RealtimeChatProps {
  onMessage?: (messages: UnifiedMessage[]) => void;
  messages?: ChatMessage[];
  request_id: number;
  helpRequestStudentIds?: string[];
  readOnly?: boolean;
}

/**
 * Component to display reply preview when replying to a message
 */
const ReplyPreview = ({
  replyToMessage,
  onCancel,
  allMessages
}: {
  replyToMessage: UnifiedMessage;
  onCancel: () => void;
  allMessages: UnifiedMessage[];
}) => {
  // Find the full message if we only have partial data
  const getMessageId = (msg: UnifiedMessage) => {
    if ("id" in msg && typeof msg.id === "number") {
      return msg.id;
    }
    return null;
  };

  const getMessageContent = (msg: UnifiedMessage) => {
    if ("message" in msg && msg.message) {
      return msg.message;
    }
    if ("content" in msg && msg.content) {
      return msg.content;
    }
    return "";
  };

  const getMessageAuthor = (msg: UnifiedMessage) => {
    if ("author" in msg && msg.author) {
      return msg.author;
    }
    if ("user" in msg && msg.user?.id) {
      return msg.user.id;
    }
    return "";
  };

  const replyMessageId = getMessageId(replyToMessage);
  const fullMessage = replyMessageId
    ? allMessages.find((msg) => getMessageId(msg) === replyMessageId) || replyToMessage
    : replyToMessage;

  return (
    <Box p={3} bg="bg.muted" borderTopRadius="md" borderTop="3px solid" borderColor="blue.500" fontSize="sm">
      <HStack justify="space-between" align="start">
        <Box flex={1}>
          <Text fontWeight="medium" fontSize="xs" color="fg.default" mb={1}>
            Replying to {getMessageAuthor(fullMessage)}
          </Text>
          <Box
            color="fg.muted"
            overflow="hidden"
            textOverflow="ellipsis"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical"
            }}
          >
            <Markdown>{getMessageContent(fullMessage)}</Markdown>
          </Box>
        </Box>
        <Button size="sm" variant="ghost" onClick={onCancel} color="fg" minW="auto" p={1}>
          <Icon as={X} boxSize={4} />
        </Button>
      </HStack>
    </Box>
  );
};

/**
 * Realtime chat component enhanced with office hours functionality
 */
export const RealtimeChat = ({
  onMessage,
  request_id,
  helpRequestStudentIds = [],
  readOnly = false
}: RealtimeChatProps) => {
  const { containerRef, scrollToBottom } = useChatScroll();
  const { course_id } = useParams();
  const moderationStatus = useModerationStatus(Number(course_id));
  const messages = useHelpRequestMessages(request_id);
  const request = useHelpRequest(request_id);
  const profiles = useAllProfilesForClass();
  const { openMeetingWindow } = useMeetingWindows();

  // Get authenticated user and their profile
  const { user } = useAuthState();
  const { private_profile_id } = useClassProfiles();

  // Reply state
  const [replyToMessage, setReplyToMessage] = useState<UnifiedMessage | null>(null);

  // Refs for intersection observer
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Use the new realtime chat hook for chat functionality
  const { sendMessage, markMessageAsRead, isConnected, isValidating, isAuthorized, connectionError, readReceipts } =
    useRealtimeChat({
      helpRequestId: request_id,
      classId: Number(course_id),
      enableChat: true
    });

  // Helper function to get timestamp from either message type
  const getMessageTimestamp = (msg: UnifiedMessage): string => {
    if ("created_at" in msg && msg.created_at) {
      return msg.created_at;
    }
    if ("createdAt" in msg) {
      return (msg as { createdAt: string }).createdAt;
    }
    return new Date().toISOString();
  };

  const allMessages = useMemo(() => {
    // Sort messages by creation time to ensure proper order
    return messages.sort((a, b) => {
      const aTime = getMessageTimestamp(a);
      const bTime = getMessageTimestamp(b);
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
  }, [messages]);

  // Human-friendly date label for separators
  const formatMessageDateLabel = useCallback((timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const atMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayDiff = Math.round((atMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

    if (dayDiff === 0) return "Today";
    if (dayDiff === -1) return "Yesterday";

    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }, []);

  // Notify parent component when messages change
  useEffect(() => {
    if (onMessage) {
      onMessage(allMessages);
    }
  }, [allMessages, onMessage]);

  // Get the controller instance to access persistent read receipt tracking
  const officeHoursController = useOfficeHoursController();

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [allMessages.length, scrollToBottom]); // Only track message count to avoid excessive scrolling

  // Mark messages as read when they come into view using controller's persistent tracking
  useEffect(() => {
    if (!allMessages.length || !markMessageAsRead || !officeHoursController) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const messageId = parseInt(entry.target.getAttribute("data-message-id") || "0", 10);
            const messageAuthorId = entry.target.getAttribute("data-message-author-id") || undefined;

            if (messageId && !officeHoursController.isMessageMarkedAsRead(messageId)) {
              // Mark message as read - the controller will handle duplicate prevention
              markMessageAsRead(messageId, messageAuthorId);
            }
          }
        });
      },
      {
        threshold: 0.5,
        rootMargin: "0px 0px -20px 0px"
      }
    );

    // Observe all current message elements
    messageRefs.current.forEach((element) => {
      if (element) observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, [allMessages, markMessageAsRead, officeHoursController]);

  const handleSendMessage = useCallback(
    async (message: string) => {
      if (!isConnected) {
        toaster.error({
          title: "Not connected to chat",
          description: "Please wait for the chat to connect before sending messages."
        });
        return;
      }
      if (!message.trim() || !sendMessage || moderationStatus.isBanned) return;

      const replyToId =
        replyToMessage && "id" in replyToMessage && typeof replyToMessage.id === "number" ? replyToMessage.id : null;

      try {
        await sendMessage(message, replyToId);

        // Log activity for the current user who sent the message
        if (private_profile_id) {
          try {
            await createStudentActivity({
              values: {
                student_profile_id: private_profile_id,
                class_id: Number(course_id),
                help_request_id: request_id,
                activity_type: "message_sent",
                activity_description: `Student sent a message in help request chat${replyToId ? " (reply)" : ""}`
              }
            });
          } catch {
            // Don't throw - activity logging shouldn't block message sending
            // Error is silently handled as it's not critical to the user experience
          }
        }

        setReplyToMessage(null);
      } catch (error) {
        toaster.error({
          title: "Failed to send message",
          description: "Failed to send message: " + (error as Error).message
        });
      }
    },
    [
      sendMessage,
      isConnected,
      moderationStatus.isBanned,
      replyToMessage,
      private_profile_id,
      createStudentActivity,
      course_id,
      request_id
    ]
  );

  const handleReply = useCallback(
    (messageId: number) => {
      const messageToReplyTo = allMessages.find((msg) => {
        if ("id" in msg && typeof msg.id === "number") {
          return msg.id === messageId;
        }
        return false;
      });
      if (messageToReplyTo) {
        setReplyToMessage(messageToReplyTo);
      }
    },
    [allMessages]
  );

  const cancelReply = useCallback(() => {
    setReplyToMessage(null);
  }, []);

  // Helper function to find reply-to message - memoized to prevent unnecessary recalculation
  const getReplyToMessage = useCallback(
    (replyToId: number | null) => {
      if (!replyToId) return null;
      return (
        allMessages.find((msg) => {
          if ("id" in msg && typeof msg.id === "number") {
            return msg.id === replyToId;
          }
          return false;
        }) || null
      );
    },
    [allMessages]
  );

  // Show loading state during validation
  if (isValidating) {
    return (
      <Flex direction="column" height="100%" width="100%" bg="bg.subtle" justify="center" align="center">
        <Text fontSize="sm" color="fg.muted">
          Connecting to chat...
        </Text>
      </Flex>
    );
  }

  // Show error state if not authorized or connection failed
  if (!isAuthorized || connectionError) {
    return (
      <Flex direction="column" height="100%" width="100%" bg="bg.subtle" justify="center" align="center" p={4}>
        <Box p={4} bg="bg.error" borderRadius="md" border="1px" borderColor="border.error">
          <Text fontSize="sm" color="fg.error">
            {connectionError || "Unable to connect to chat"}
          </Text>
        </Box>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      height="100%"
      width="100%"
      maxW={{ base: "md", md: "full" }}
      mx="auto"
      bg="bg.subtle"
      minH={0}
    >
      {/* Connection status indicator */}
      {!isConnected && (
        <Box p={2} bg="bg.warning" borderBottom="1px" borderColor="border.emphasized">
          <Text fontSize="xs" color="fg.warning" textAlign="center">
            Reconnecting to chat...
          </Text>
        </Box>
      )}

      {/* Video Call Banner */}
      {request?.is_video_live && (
        <Box
          p={3}
          bg="green.50"
          borderBottom="1px"
          borderColor="border.emphasized"
          borderRadius={0}
          borderTop="2px"
          borderTopColor="green.500"
        >
          <HStack gap={3} flex="1" align="center" justify="space-between" wrap="wrap">
            <HStack gap={2} flex="1" minW={0}>
              <Icon as={BsPersonVideo2} boxSize={5} color="green.600" />
              <Box flex="1" minW={0}>
                <Text fontWeight="semibold" fontSize="sm" mb={0.5} color="green.900">
                  Video call is active
                </Text>
                <Text fontSize="xs" color="green.700">
                  {request.assignee
                    ? `${profiles.find((p) => p.id === request.assignee)?.name || "Someone"} started a video call and is waiting for you`
                    : "A video call has been started"}
                </Text>
              </Box>
            </HStack>
            <Button
              size="sm"
              colorPalette="green"
              variant="solid"
              onClick={() => {
                if (request) {
                  openMeetingWindow(request.class_id, request.id, request.help_queue);
                }
              }}
              flexShrink={0}
            >
              <Icon as={BsCameraVideo} mr={1} />
              Join Video Call
            </Button>
          </HStack>
        </Box>
      )}

      {/* Messages */}
      <Box
        ref={containerRef}
        flex="1"
        overflowY="auto"
        p={{ base: 2, md: 4 }}
        style={{
          animation: allMessages.length > 0 ? "fadeIn 0.3s ease-in" : undefined
        }}
      >
        {allMessages.length === 0 ? (
          <Flex justify="center" align="center" height="100%">
            <Text fontSize="sm" color="fg.muted" textAlign="center">
              No messages yet. Start the conversation!
            </Text>
          </Flex>
        ) : (
          <Stack gap={1}>
            {allMessages.map((message, index) => {
              const prevMessage = index > 0 ? allMessages[index - 1] : null;
              const getCurrentMessageAuthor = (msg: UnifiedMessage) => {
                if ("author" in msg && msg.author) return msg.author;
                if ("user" in msg && msg.user?.id) return msg.user.id;
                return "";
              };
              const getPrevMessageAuthor = (msg: UnifiedMessage | null) => {
                if (!msg) return "";
                if ("author" in msg && msg.author) return msg.author;
                if ("user" in msg && msg.user?.id) return msg.user.id;
                return "";
              };

              const showHeader = !prevMessage || getCurrentMessageAuthor(message) !== getPrevMessageAuthor(prevMessage);

              const getReplyToId = (msg: UnifiedMessage): number | null => {
                if ("reply_to_message_id" in msg) return msg.reply_to_message_id ?? null;
                if ("replyToMessageId" in msg) return msg.replyToMessageId ?? null;
                return null;
              };

              const getUniqueKey = (msg: UnifiedMessage, idx: number) => {
                if ("id" in msg && typeof msg.id === "number") return `db-${msg.id}`;
                if ("id" in msg && typeof msg.id === "string") return `broadcast-${msg.id}`;
                return `index-${idx}`;
              };

              const messageKey = getUniqueKey(message, index);
              const replyToId = getReplyToId(message);
              const replyToMsg = getReplyToMessage(replyToId);
              const currentDateStr = new Date(getMessageTimestamp(message)).toDateString();
              const prevDateStr = prevMessage ? new Date(getMessageTimestamp(prevMessage)).toDateString() : null;
              const showDateSeparator = !prevMessage || currentDateStr !== prevDateStr;

              return (
                <Box key={messageKey}>
                  {showDateSeparator && (
                    <HStack my={3} justify="center">
                      <Box flex="1" height="1px" bg="border.emphasized" />
                      <Box px={2} py={0.5} bg="bg.muted" borderRadius="md" border="1px" borderColor="border.emphasized">
                        <Text fontSize="xs" color="fg.muted">
                          {formatMessageDateLabel(getMessageTimestamp(message))}
                        </Text>
                      </Box>
                      <Box flex="1" height="1px" bg="border.emphasized" />
                    </HStack>
                  )}
                  <Box
                    ref={(el: HTMLDivElement | null) => {
                      if (el && "id" in message && typeof message.id === "number") {
                        messageRefs.current.set(message.id, el);
                      }
                    }}
                    data-message-id={"id" in message && typeof message.id === "number" ? message.id : undefined}
                    data-message-author-id={getCurrentMessageAuthor(message)}
                    style={{
                      animation: "slideInFromBottom 0.3s ease-out"
                    }}
                  >
                    <ChatMessageItem
                      message={message}
                      isOwnMessage={
                        getCurrentMessageAuthor(message) === private_profile_id ||
                        getCurrentMessageAuthor(message) === (user?.id || "")
                      }
                      showHeader={showHeader}
                      replyToMessage={replyToMsg}
                      readReceipts={readReceipts}
                      onReply={handleReply}
                      allMessages={allMessages}
                      currentUserId={private_profile_id}
                      helpRequestStudentIds={helpRequestStudentIds}
                    />
                  </Box>
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>

      {readOnly ? (
        <Box p={{ base: 3, md: 4 }} borderTop="1px" borderColor="border.emphasized" bg="bg.muted">
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            This is a historical chat view. New messages cannot be sent.
          </Text>
        </Box>
      ) : moderationStatus.isBanned ? (
        <Box p={{ base: 3, md: 4 }} borderTop="1px" borderColor="border.emphasized" bg="bg.error">
          <Text fontSize="sm" color="red.fg" textAlign="center">
            {moderationStatus.isPermanentBan
              ? "You are permanently banned from sending messages in office hours."
              : moderationStatus.timeRemainingMs
                ? `You are temporarily banned. Time remaining: ${formatTimeRemaining(moderationStatus.timeRemainingMs)}`
                : "You are temporarily banned from sending messages."}
          </Text>
        </Box>
      ) : (
        <Box borderTop="1px" borderColor="border.emphasized">
          {/* Reply Preview */}
          {replyToMessage && (
            <ReplyPreview replyToMessage={replyToMessage} onCancel={cancelReply} allMessages={allMessages} />
          )}

          {/* Message Input */}
          <Box p={{ base: 2, md: 4 }}>
            <MessageInput
              sendMessage={handleSendMessage}
              enableFilePicker={true}
              enableEmojiPicker={true}
              enableGiphyPicker={true}
              placeholder={replyToMessage ? "Reply to message..." : "Type a message..."}
              sendButtonText="Send"
              uploadFolder="office-hours"
              ariaLabel="Type your message"
              defaultSingleLine={true}
              inlineFileUpload={false}
            />
          </Box>
        </Box>
      )}

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes slideInFromBottom {
          from {
            opacity: 0;
            transform: translateY(16px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes slideInFromRight {
          from {
            opacity: 0;
            transform: translateX(16px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </Flex>
  );
};
