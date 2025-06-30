"use client";

import { useChatScroll } from "@/hooks/use-chat-scroll";
import { type ChatMessage, useRealtimeChat } from "@/hooks/use-realtime-chat";
import { ChatMessageItem } from "@/components/chat-message";
import { useCallback, useEffect, useState } from "react";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Input, Icon, Text } from "@chakra-ui/react";
import { Button } from "./ui/button";
import { Send } from "lucide-react";
import { useModerationStatus, formatTimeRemaining } from "@/hooks/useModerationStatus";

interface RealtimeChatProps {
  roomName: string;
  username: string;
  onMessage?: (messages: ChatMessage[]) => void;
  messages?: ChatMessage[];
  helpRequest: HelpRequest;
}

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
  username,
  onMessage,
  messages: databaseMessages = [],
  helpRequest
}: RealtimeChatProps) => {
  const { containerRef, scrollToBottom } = useChatScroll();
  const moderationStatus = useModerationStatus(helpRequest.class_id);

  const { sendMessage, isConnected } = useRealtimeChat({
    roomName,
    username,
    helpRequest
  });
  const [newMessage, setNewMessage] = useState("");

  // Use database messages directly (they come with real-time updates)
  const allMessages = databaseMessages;

  useEffect(() => {
    if (onMessage) {
      onMessage(allMessages);
    }
  }, [allMessages, onMessage]);

  useEffect(() => {
    // Scroll to bottom whenever messages change
    scrollToBottom();
  }, [allMessages, scrollToBottom]);

  const handleSendMessage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!newMessage.trim() || !isConnected || moderationStatus.isBanned) return;

      sendMessage(newMessage);
      setNewMessage("");
    },
    [newMessage, isConnected, sendMessage, moderationStatus.isBanned]
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
              const showHeader = !prevMessage || prevMessage.author !== message.author;

              return (
                <Box
                  key={message.id}
                  style={{
                    animation: "slideInFromBottom 0.3s ease-out"
                  }}
                >
                  <ChatMessageItem
                    message={message}
                    isOwnMessage={message.author === username}
                    showHeader={showHeader}
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
        <Box
          as="form"
          onSubmit={handleSendMessage}
          p={4}
          borderTop="1px"
          borderColor="gray.200"
          _dark={{ borderColor: "gray.600" }}
        >
          <Flex gap={2} width="100%" align="center">
            <Input
              borderRadius="full"
              bg="white"
              _dark={{ bg: "gray.800" }}
              fontSize="sm"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Type a message..."
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
