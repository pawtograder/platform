"use client";

import { ChatMessageItem, type UnifiedMessage } from "@/components/chat-message";
import MessageInput from "@/components/ui/message-input";
import { toaster } from "@/components/ui/toaster";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { formatTimeRemaining, useModerationStatus } from "@/hooks/useModerationStatus";
import { useOfficeHoursController, useRealtimeChat, type ChatMessage } from "@/hooks/useOfficeHoursRealtime";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { useCreate } from "@refinedev/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";

interface RealtimeChatProps {
  onMessage?: (messages: UnifiedMessage[]) => void;
  messages?: ChatMessage[];
  helpRequest: HelpRequest;
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
  messages: databaseMessages = [],
  helpRequest,
  helpRequestStudentIds = [],
  readOnly = false
}: RealtimeChatProps) => {
  const { containerRef, scrollToBottom } = useChatScroll();
  const moderationStatus = useModerationStatus(helpRequest.class_id);

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
      helpRequestId: helpRequest.id,
      classId: helpRequest.class_id,
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

  // Use database messages if provided, otherwise empty array (chat hook will handle real-time messages)
  const allMessages = useMemo(() => {
    if (!databaseMessages || databaseMessages.length === 0) {
      return [];
    }

    // Sort messages by creation time to ensure proper order
    return databaseMessages.sort((a, b) => {
      const aTime = getMessageTimestamp(a);
      const bTime = getMessageTimestamp(b);
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
  }, [databaseMessages]);

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (message: string, profile_id: string, close?: boolean) => {
      if (!message.trim() || !sendMessage || !isConnected || moderationStatus.isBanned) return;

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
                class_id: helpRequest.class_id,
                help_request_id: helpRequest.id,
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
      helpRequest,
      createStudentActivity
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
    <Flex direction="column" height="100%" width="100%" bg="bg.subtle">
      {/* Connection status indicator */}
      {!isConnected && (
        <Box p={2} bg="bg.warning" borderBottom="1px" borderColor="border.emphasized">
          <Text fontSize="xs" color="fg.warning" textAlign="center">
            Reconnecting to chat...
          </Text>
        </Box>
      )}

      {/* Messages */}
      <Box
        ref={containerRef}
        flex="1"
        overflowY="auto"
        p={4}
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

              return (
                <Box
                  key={messageKey}
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
              );
            })}
          </Stack>
        )}
      </Box>

      {readOnly ? (
        <Box p={4} borderTop="1px" borderColor="border.emphasized" bg="bg.muted">
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            This is a historical chat view. New messages cannot be sent.
          </Text>
        </Box>
      ) : moderationStatus.isBanned ? (
        <Box p={4} borderTop="1px" borderColor="border.emphasized" bg="bg.error">
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
          <Box p={4}>
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
