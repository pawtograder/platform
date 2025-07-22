"use client";

import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useOfficeHoursRealtime, type ChatMessage } from "@/hooks/useOfficeHoursRealtime";
import { ChatMessageItem, type UnifiedMessage } from "@/components/chat-message";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Input, Icon, Text, Button, HStack } from "@chakra-ui/react";
import { Send, X } from "lucide-react";
import { useModerationStatus, formatTimeRemaining } from "@/hooks/useModerationStatus";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";

interface RealtimeChatProps {
  onMessage?: (messages: UnifiedMessage[]) => void;
  messages?: ChatMessage[];
  helpRequest: HelpRequest;
  helpRequestStudentIds?: string[];
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
    <Box
      p={3}
      bg="gray.50"
      _dark={{ bg: "gray.700" }}
      borderTopRadius="md"
      borderTop="3px solid"
      borderColor="blue.500"
      fontSize="sm"
    >
      <HStack justify="space-between" align="start">
        <Box flex={1}>
          <Text fontWeight="medium" fontSize="xs" color="gray.600" _dark={{ color: "gray.300" }} mb={1}>
            Replying to {getMessageAuthor(fullMessage)}
          </Text>
          <Text
            color="gray.500"
            _dark={{ color: "gray.400" }}
            overflow="hidden"
            textOverflow="ellipsis"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical"
            }}
          >
            {getMessageContent(fullMessage)}
          </Text>
        </Box>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          color="gray.500"
          _dark={{ color: "gray.400" }}
          minW="auto"
          p={1}
        >
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
  helpRequestStudentIds = []
}: RealtimeChatProps) => {
  const { containerRef, scrollToBottom } = useChatScroll();
  const moderationStatus = useModerationStatus(helpRequest.class_id);

  // Get authenticated user and their profile
  const { user } = useAuthState();
  const { private_profile_id, allVisibleRoles } = useClassProfiles();

  // Reply state
  const [replyToMessage, setReplyToMessage] = useState<UnifiedMessage | null>(null);
  const [newMessage, setNewMessage] = useState("");

  // Refs for intersection observer
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Track which messages have already been marked as read to prevent duplicates
  const [markedAsRead, setMarkedAsRead] = useState<Set<number>>(new Set());

  // Use the enhanced office hours realtime hook with chat functionality enabled
  const {
    data,
    sendMessage,
    markMessageAsRead,
    isConnected,
    isValidating,
    isAuthorized,
    connectionError,
    readReceipts
  } = useOfficeHoursRealtime({
    classId: helpRequest.class_id,
    helpRequestId: helpRequest.id,
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

  // Prioritize realtime data over prop data, ensure proper reactivity to changes
  const allMessages = useMemo(() => {
    const hookMessages = data?.helpRequestMessages || [];
    // Always prefer realtime hook data if available, fallback to prop data only when hook data is empty
    const messages = hookMessages.length > 0 ? hookMessages : databaseMessages;

    // Sort messages by creation time to ensure proper order
    return messages.sort((a, b) => {
      const aTime = getMessageTimestamp(a);
      const bTime = getMessageTimestamp(b);
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
  }, [data?.helpRequestMessages, databaseMessages]);

  // Notify parent component when messages change
  useEffect(() => {
    if (onMessage) {
      onMessage(allMessages);
    }
  }, [allMessages, onMessage]);

  // Clean up markedAsRead state when messages change to prevent stale data
  useEffect(() => {
    const currentMessageIds = new Set(
      allMessages
        .map((msg) => {
          if ("id" in msg && typeof msg.id === "number") {
            return msg.id;
          }
          return null;
        })
        .filter((id): id is number => id !== null)
    );

    setMarkedAsRead((prev) => {
      const filtered = new Set([...prev].filter((id) => currentMessageIds.has(id)));
      return filtered;
    });
  }, [allMessages]);

  // Scroll to bottom when messages change (with debouncing to prevent excessive scrolling)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      scrollToBottom();
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [allMessages.length, scrollToBottom]); // Only track message count to avoid excessive scrolling

  // Mark messages as read when they come into view
  useEffect(() => {
    if (!allMessages.length || !markMessageAsRead) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const messageId = parseInt(entry.target.getAttribute("data-message-id") || "0", 10);
            const messageAuthorId = entry.target.getAttribute("data-message-author-id") || undefined;
            if (messageId && !markedAsRead.has(messageId)) {
              // Mark this message as processed to prevent duplicate calls
              setMarkedAsRead((prev) => new Set(prev).add(messageId));
              // Mark message as read after a short delay to ensure it's actually viewed
              setTimeout(() => {
                markMessageAsRead(messageId, messageAuthorId);
              }, 1000);
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
  }, [allMessages, markMessageAsRead, markedAsRead]);

  const handleSendMessage = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newMessage.trim() || !sendMessage || !isConnected || moderationStatus.isBanned) return;

      const replyToId =
        replyToMessage && "id" in replyToMessage && typeof replyToMessage.id === "number" ? replyToMessage.id : null;

      try {
        await sendMessage(newMessage, replyToId);
        setNewMessage("");
        setReplyToMessage(null);
      } catch (error) {
        console.error("Failed to send message:", error);
      }
    },
    [newMessage, sendMessage, isConnected, moderationStatus.isBanned, replyToMessage]
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
      <Flex
        direction="column"
        height="100%"
        width="100%"
        bg="white"
        _dark={{ bg: "gray.800" }}
        justify="center"
        align="center"
      >
        <Text fontSize="sm" color="gray.500" _dark={{ color: "gray.400" }}>
          Connecting to chat...
        </Text>
      </Flex>
    );
  }

  // Show error state if not authorized or connection failed
  if (!isAuthorized || connectionError) {
    return (
      <Flex
        direction="column"
        height="100%"
        width="100%"
        bg="white"
        _dark={{ bg: "gray.800" }}
        justify="center"
        align="center"
        p={4}
      >
        <Box
          p={4}
          bg="red.50"
          _dark={{ bg: "red.900", borderColor: "red.700" }}
          borderRadius="md"
          border="1px"
          borderColor="red.200"
        >
          <Text fontSize="sm" color="red.700" _dark={{ color: "red.300" }}>
            {connectionError || "Unable to connect to chat"}
          </Text>
        </Box>
      </Flex>
    );
  }

  return (
    <Flex direction="column" height="100%" width="100%" bg="white" _dark={{ bg: "gray.800" }}>
      {/* Connection status indicator */}
      {!isConnected && (
        <Box
          p={2}
          bg="yellow.50"
          _dark={{ bg: "yellow.900", borderColor: "yellow.700" }}
          borderBottom="1px"
          borderColor="yellow.200"
        >
          <Text fontSize="xs" color="yellow.700" _dark={{ color: "yellow.300" }} textAlign="center">
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
            <Text fontSize="sm" color="gray.500" _dark={{ color: "gray.400" }} textAlign="center">
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
                    userRoles={allVisibleRoles}
                  />
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>

      {moderationStatus.isBanned ? (
        <Box
          p={4}
          borderTop="1px"
          borderColor="gray.200"
          bg="red.50"
          _dark={{ borderColor: "gray.600", bg: "red.900" }}
        >
          <Text fontSize="sm" color="red.700" _dark={{ color: "red.300" }} textAlign="center">
            {moderationStatus.isPermanentBan
              ? "You are permanently banned from sending messages in office hours."
              : moderationStatus.timeRemainingMs
                ? `You are temporarily banned. Time remaining: ${formatTimeRemaining(moderationStatus.timeRemainingMs)}`
                : "You are temporarily banned from sending messages."}
          </Text>
        </Box>
      ) : (
        <Box borderTop="1px" borderColor="gray.200" _dark={{ borderColor: "gray.600" }}>
          {/* Reply Preview */}
          {replyToMessage && (
            <ReplyPreview replyToMessage={replyToMessage} onCancel={cancelReply} allMessages={allMessages} />
          )}

          {/* Message Input */}
          <Box as="form" onSubmit={handleSendMessage} p={4}>
            <Flex gap={2} width="100%" align="center">
              <Input
                borderRadius="full"
                bg="white"
                _dark={{ bg: "gray.800" }}
                fontSize="sm"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={replyToMessage ? "Reply to message..." : "Type a message..."}
                disabled={!isConnected || !sendMessage}
                transition="all 0.3s"
                flex="1"
              />
              {isConnected && newMessage.trim() && sendMessage && (
                <Button
                  type="submit"
                  size="sm"
                  borderRadius="full"
                  aspectRatio="1"
                  disabled={!isConnected || !sendMessage}
                  style={{
                    animation: "slideInFromRight 0.3s ease-out"
                  }}
                >
                  <Icon as={Send} boxSize={4} />
                </Button>
              )}
            </Flex>
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
