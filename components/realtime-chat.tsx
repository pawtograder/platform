"use client";

import { useChatScroll } from "@/hooks/use-chat-scroll";
import { useRealtimeChat, type ChatMessage } from "@/hooks/use-realtime-chat";
import { ChatMessageItem, type UnifiedMessage } from "@/components/chat-message";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Input, Icon, Text, Button, HStack } from "@chakra-ui/react";
import { Send, X } from "lucide-react";
import { useModerationStatus, formatTimeRemaining } from "@/hooks/useModerationStatus";
import useAuthState from "@/hooks/useAuthState";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useClassProfiles } from "@/hooks/useClassProfiles";

interface RealtimeChatProps {
  roomName: string;
  username: string;
  onMessage?: (messages: UnifiedMessage[]) => void;
  messages?: ChatMessage[];
  helpRequest: HelpRequest;
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
 * Realtime chat component
 * @param roomName - The name of the room to join. Each room is a unique chat.
 * @param username - The username of the user
 * @param onMessage - The callback function to handle the messages. Useful if you want to store the messages in a database.
 * @param messages - The messages to display in the chat. Useful if you want to display messages from a database.
 * @returns The chat component
 */
export const RealtimeChat = ({
  roomName,
  username: propUsername, // Keep prop for fallback
  onMessage,
  messages: databaseMessages = [],
  helpRequest
}: RealtimeChatProps) => {
  const { containerRef, scrollToBottom } = useChatScroll();
  const moderationStatus = useModerationStatus(helpRequest.class_id);

  // Get authenticated user and their profile for display name
  const { user } = useAuthState();
  const userProfile = useUserProfile(user?.id || "");
  const { private_profile_id } = useClassProfiles();

  // Use profile name, fallback to prop username, then fallback to user email
  const displayName = userProfile?.name || propUsername || user?.email || "Unknown User";

  // Reply state
  const [replyToMessage, setReplyToMessage] = useState<UnifiedMessage | null>(null);
  const [newMessage, setNewMessage] = useState("");

  // Refs for intersection observer
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Track which messages have already been marked as read to prevent duplicates
  const [markedAsRead, setMarkedAsRead] = useState<Set<number>>(new Set());

  const { broadcastMessages, sendMessage, markMessageAsRead, isConnected, readReceipts } = useRealtimeChat({
    roomName,
    username: displayName, // Pass display name to hook
    messages: databaseMessages, // Pass messages from props to hook
    helpRequest
  });

  // Merge broadcast messages with database messages
  const allMessages = useMemo(() => {
    const mergedMessages: UnifiedMessage[] = [...databaseMessages];

    // Add broadcast messages that aren't already in database
    broadcastMessages.forEach((broadcastMsg) => {
      // Don't add if we already have this message in database
      const isDuplicate = databaseMessages.some((dbMsg) => {
        // Check content match
        const contentMatches = dbMsg.message === broadcastMsg.content;

        // Check timestamp match (5 second tolerance)
        const timeMatches =
          Math.abs(new Date(dbMsg.created_at).getTime() - new Date(broadcastMsg.createdAt).getTime()) < 5000;

        // For the current user, also check author match to ensure we're comparing the right messages
        // For database messages, author is profile ID. For broadcast messages, user.id is auth user ID
        const isFromCurrentUser = broadcastMsg.user.id === (user?.id || "");
        const databaseMessageFromCurrentUser = dbMsg.author === private_profile_id;
        const authorMatches = !isFromCurrentUser || (isFromCurrentUser && databaseMessageFromCurrentUser);

        // For messages from other users, we rely on content + timestamp matching
        // For messages from current user, we also verify author matching
        return contentMatches && timeMatches && authorMatches;
      });

      if (!isDuplicate) {
        // Convert broadcast message to unified format
        // For consistency, use profile ID when this is the current user's message
        let authorId = broadcastMsg.user.id; // Default to auth user ID

        // If this is the current user's message, use their profile ID for consistency with database messages
        if (broadcastMsg.user.id === (user?.id || "") && private_profile_id) {
          authorId = private_profile_id;
        }

        const unifiedMsg: UnifiedMessage = {
          ...broadcastMsg,
          author: authorId, // Use profile ID for current user, auth user ID for others
          author_name: broadcastMsg.user.name, // Preserve username for display
          message: broadcastMsg.content,
          created_at: broadcastMsg.createdAt,
          reply_to_message_id: broadcastMsg.replyToMessageId,
          help_request_id: broadcastMsg.helpRequestId,
          class_id: broadcastMsg.classId,
          instructors_only: false,
          requestor: null
        };
        mergedMessages.push(unifiedMsg);
      }
    });

    // Sort by creation date
    return mergedMessages.sort((a, b) => {
      const timeA = "created_at" in a ? a.created_at : a.createdAt;
      const timeB = "created_at" in b ? b.created_at : b.createdAt;
      return timeA.localeCompare(timeB);
    });
  }, [databaseMessages, broadcastMessages, user?.id, private_profile_id]);

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

  useEffect(() => {
    // Scroll to bottom whenever messages change
    scrollToBottom();
  }, [allMessages, scrollToBottom]);

  // Mark messages as read when they come into view
  useEffect(() => {
    if (!allMessages.length) return;

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
        threshold: 0.5, // Message must be 50% visible
        rootMargin: "0px 0px -20px 0px" // Add some bottom margin
      }
    );

    // Observe all current message elements
    messageRefs.current.forEach((element) => {
      if (element) observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, [allMessages, markMessageAsRead, markedAsRead, setMarkedAsRead]);

  const handleSendMessage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!newMessage.trim() || !isConnected || moderationStatus.isBanned) return;

      const replyToId =
        replyToMessage && "id" in replyToMessage && typeof replyToMessage.id === "number" ? replyToMessage.id : null;

      sendMessage(newMessage, replyToId);
      setNewMessage("");
      setReplyToMessage(null);
    },
    [newMessage, isConnected, sendMessage, moderationStatus.isBanned, replyToMessage]
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

  // Helper function to find reply-to message
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

  return (
    <Flex direction="column" height="100%" width="100%" bg="white" _dark={{ bg: "gray.800" }}>
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
                    currentUserId={private_profile_id} // Pass profile ID for read receipt matching (database uses profile IDs)
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
                disabled={!isConnected}
                transition="all 0.3s"
                flex="1"
              />
              {isConnected && newMessage.trim() && (
                <Button
                  type="submit"
                  size="sm"
                  borderRadius="full"
                  aspectRatio="1"
                  disabled={!isConnected}
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
