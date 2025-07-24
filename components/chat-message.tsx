import type { ChatMessage } from "@/hooks/useOfficeHoursRealtime";
import type { HelpRequestMessageReadReceipt } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Text, Icon, Stack, HStack, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Reply, Check, CheckCheck } from "lucide-react";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useTagsForProfile } from "@/hooks/useTags";
import { Tooltip } from "@/components/ui/tooltip";

// Broadcast message type for real-time communication
export interface BroadcastMessage {
  id: string;
  content: string;
  user: {
    id: string;
    name: string;
  };
  createdAt: string;
  replyToMessageId?: number | null;
  helpRequestId: number;
  classId: number;
}

// Unified message type that can handle both database and broadcast messages
export type UnifiedMessage =
  | ChatMessage
  | (BroadcastMessage & {
      reply_to_message_id?: number | null;
      author: string;
      message: string;
      author_name?: string; // Preserve username for broadcast messages
    });

interface ChatMessageItemProps {
  message: UnifiedMessage;
  isOwnMessage: boolean;
  showHeader: boolean;
  replyToMessage?: UnifiedMessage | null;
  readReceipts: HelpRequestMessageReadReceipt[];
  onReply?: (messageId: number) => void;
  allMessages: UnifiedMessage[];
  currentUserId?: string;
  helpRequestStudentIds?: string[];
}

/**
 * Helper to get message content regardless of message type
 */
const getMessageContent = (message: UnifiedMessage): string => {
  if ("message" in message && message.message) {
    return message.message; // Database message
  }
  if ("content" in message && message.content) {
    return message.content; // Broadcast message
  }
  return ""; // Fallback
};

/**
 * Helper to get message author regardless of message type
 */
const getMessageAuthor = (message: UnifiedMessage): string => {
  if ("author" in message && message.author) {
    return message.author; // Database message
  }
  if ("user" in message && message.user?.id) {
    return message.user.id; // Broadcast message
  }
  return ""; // Fallback
};

/**
 * Helper to get message timestamp regardless of message type
 */
const getMessageTimestamp = (message: UnifiedMessage): string => {
  if ("created_at" in message) {
    return message.created_at; // Database message
  }
  if ("createdAt" in message) {
    return message.createdAt; // Broadcast message
  }
  return new Date().toISOString(); // Fallback
};

/**
 * Helper to get reply message ID regardless of message type
 */
const getReplyToMessageId = (message: UnifiedMessage): number | null => {
  if ("reply_to_message_id" in message) {
    return message.reply_to_message_id ?? null; // Database message
  }
  if ("replyToMessageId" in message) {
    return message.replyToMessageId ?? null; // Broadcast message
  }
  return null;
};

/**
 * Helper to check if message has a database ID (for read receipts and replies)
 */
const getMessageId = (message: UnifiedMessage): number | null => {
  if ("id" in message && typeof message.id === "number") {
    return message.id; // Database message
  }
  return null; // Broadcast message (no database ID yet)
};

/**
 * Component to display role-based badges for message authors
 */
const UserRoleBadge = ({ authorId, helpRequestStudentIds }: { authorId: string; helpRequestStudentIds?: string[] }) => {
  // Check if author is a student associated with this help request (OP)
  const isOP = helpRequestStudentIds?.includes(authorId);

  // Get tags for the user to determine their role
  const { tags } = useTagsForProfile(authorId);

  // Check for instructor or grader tags
  const hasInstructorTag = tags.some((tag) => tag.name === "instructor");
  const hasGraderTag = tags.some((tag) => tag.name === "grader");

  if (isOP) {
    return (
      <Badge colorPalette="blue" variant="outline" size="sm">
        OP
      </Badge>
    );
  }

  if (hasInstructorTag) {
    return (
      <Badge colorPalette="purple" variant="outline" size="sm">
        Instructor
      </Badge>
    );
  }

  if (hasGraderTag) {
    return (
      <Badge colorPalette="green" variant="outline" size="sm">
        Grader
      </Badge>
    );
  }

  return null;
};

/**
 * Component to display a single user name in the tooltip
 */
const ReadReceiptUser = ({ userId }: { userId: string }) => {
  const profile = useUserProfile(userId);
  return <Text>• {profile?.name || userId}</Text>;
};

/**
 * Component to display the names of users who have read a message
 */
const ReadReceiptTooltipContent = ({ readReceipts }: { readReceipts: HelpRequestMessageReadReceipt[] }) => {
  const firstUserProfile = useUserProfile(readReceipts[0]?.viewer_id || "");

  if (readReceipts.length === 0) {
    return <Text fontSize="xs">No one has read this message yet</Text>;
  }

  if (readReceipts.length === 1) {
    return <Text fontSize="xs">Read by {firstUserProfile?.name || readReceipts[0].viewer_id}</Text>;
  }

  return (
    <Box fontSize="xs" maxW="200px">
      <Text fontWeight="medium" mb={1}>
        Read by:
      </Text>
      <Stack gap={0}>
        {readReceipts.map((receipt, index) => (
          <ReadReceiptUser key={`${receipt.viewer_id}-${index}`} userId={receipt.viewer_id} />
        ))}
      </Stack>
    </Box>
  );
};

/**
 * Component to display read receipt indicators
 */
const ReadReceiptIndicator = ({
  message,
  readReceipts,
  isOwnMessage,
  currentUserId
}: {
  message: UnifiedMessage;
  readReceipts: HelpRequestMessageReadReceipt[];
  isOwnMessage: boolean;
  currentUserId?: string;
}) => {
  if (!isOwnMessage) return null;

  const messageId = getMessageId(message);
  if (!messageId) return null; // No read receipts for broadcast-only messages

  // Filter read receipts for this message, excluding the current user's own receipt
  const messageReadReceipts = readReceipts.filter(
    (receipt) => receipt.message_id === messageId && receipt.viewer_id !== currentUserId
  );
  const readCount = messageReadReceipts.length;

  if (readCount === 0) {
    return (
      <Tooltip content="No one has read this message yet" showArrow>
        <Icon as={Check} boxSize={3} color="gray.400" _dark={{ color: "gray.500" }} />
      </Tooltip>
    );
  }

  return (
    <Tooltip content={<ReadReceiptTooltipContent readReceipts={messageReadReceipts} />} showArrow>
      <HStack gap={1} align="center" cursor="pointer">
        <Icon as={CheckCheck} boxSize={3} color="blue.500" _dark={{ color: "blue.400" }} />
        {readCount > 1 && (
          <Text fontSize="2xs" color="gray.500" _dark={{ color: "gray.400" }}>
            {readCount}
          </Text>
        )}
      </HStack>
    </Tooltip>
  );
};

/**
 * Component to display reply context
 */
const ReplyContext = ({
  replyToMessage,
  allMessages
}: {
  replyToMessage: UnifiedMessage | null;
  allMessages: UnifiedMessage[];
}) => {
  // Find the original message if we only have the ID
  const replyToId = replyToMessage ? getReplyToMessageId(replyToMessage) : null;
  const originalMessage = replyToId
    ? allMessages.find((msg) => getMessageId(msg) === replyToId) || replyToMessage
    : replyToMessage;

  const replyAuthor = useUserProfile(originalMessage ? getMessageAuthor(originalMessage) : "");

  if (!replyToMessage || !originalMessage) return null;

  // Get display name for reply context - same logic as main message
  const getReplyDisplayName = () => {
    // For broadcast messages with preserved username
    if ("author_name" in originalMessage && originalMessage.author_name) {
      return originalMessage.author_name;
    }
    // For database messages, use profile lookup
    if (replyAuthor?.name) {
      return replyAuthor.name;
    }
    // Final fallback to raw author ID
    return getMessageAuthor(originalMessage);
  };

  return (
    <Box
      pl={3}
      py={2}
      mb={1}
      borderLeft="3px solid"
      borderColor="gray.300"
      bg="gray.50"
      borderRadius="md"
      fontSize="xs"
      _dark={{ borderColor: "gray.600", bg: "gray.700" }}
    >
      <Text fontWeight="medium" color="gray.600" mb={1} _dark={{ color: "gray.300" }}>
        Replying to {getReplyDisplayName()}
      </Text>
      <Text
        color="gray.500"
        lineHeight="1.3"
        overflow="hidden"
        textOverflow="ellipsis"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical"
        }}
        _dark={{ color: "gray.400" }}
      >
        {getMessageContent(originalMessage)}
      </Text>
    </Box>
  );
};

export const ChatMessageItem = ({
  message,
  isOwnMessage,
  showHeader,
  replyToMessage,
  readReceipts,
  onReply,
  allMessages,
  currentUserId,
  helpRequestStudentIds
}: ChatMessageItemProps) => {
  const messageAuthor = useUserProfile(getMessageAuthor(message));
  const messageId = getMessageId(message);
  const authorId = getMessageAuthor(message);

  // Get display name - use author_name for broadcast messages, fallback to profile lookup
  const getDisplayName = () => {
    // For broadcast messages with preserved username
    if ("author_name" in message && message.author_name) {
      return message.author_name;
    }
    // For database messages, use profile lookup
    if (messageAuthor?.name) {
      return messageAuthor.name;
    }
    // Final fallback to raw author ID (should rarely be needed now)
    return getMessageAuthor(message);
  };

  const handleReply = () => {
    if (onReply && messageId) {
      onReply(messageId);
    }
  };

  return (
    <Flex mt={2} justify={isOwnMessage ? "flex-end" : "flex-start"}>
      <Flex maxW="75%" w="fit-content" direction="column" gap={1} align={isOwnMessage ? "flex-end" : "flex-start"}>
        {showHeader && (
          <Flex
            align="center"
            gap={2}
            fontSize="xs"
            px={2}
            justify={isOwnMessage ? "flex-end" : "flex-start"}
            direction={isOwnMessage ? "row-reverse" : "row"}
          >
            <HStack gap={2}>
              <Text fontWeight="medium">{getDisplayName()}</Text>
              <UserRoleBadge authorId={authorId} helpRequestStudentIds={helpRequestStudentIds} />
            </HStack>
            <Text color="gray.500" _dark={{ color: "gray.400" }} fontSize="xs">
              {new Date(getMessageTimestamp(message)).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
              })}
            </Text>
          </Flex>
        )}

        <Stack gap={0} align={isOwnMessage ? "flex-end" : "flex-start"}>
          {/* Reply Context */}
          {getReplyToMessageId(message) && (
            <Box width="100%">
              <ReplyContext replyToMessage={replyToMessage || null} allMessages={allMessages} />
            </Box>
          )}

          {/* Message Content */}
          <Box
            py={2}
            px={2}
            borderRadius="xl"
            fontSize="sm"
            w="fit-content"
            bg={isOwnMessage ? "blue.500" : "gray.100"}
            color={isOwnMessage ? "white" : "black"}
            _dark={{
              bg: isOwnMessage ? "blue.500" : "gray.700",
              color: isOwnMessage ? "white" : "white"
            }}
            position="relative"
            _hover={{
              "& .reply-button": {
                opacity: 1
              }
            }}
          >
            {getMessageContent(message)}

            {/* Reply Button - Only show for messages with database IDs */}
            {onReply && messageId && (
              <Button
                className="reply-button"
                size="xs"
                variant="ghost"
                position="absolute"
                top="-8px"
                right={isOwnMessage ? "auto" : "-8px"}
                left={isOwnMessage ? "-8px" : "auto"}
                opacity={0}
                transition="opacity 0.2s"
                bg="white"
                color="gray.600"
                _dark={{ bg: "gray.800", color: "gray.300" }}
                _hover={{
                  bg: "gray.50",
                  _dark: { bg: "gray.700" }
                }}
                onClick={handleReply}
                borderRadius="full"
                aspectRatio="1"
                minW="auto"
                p={1}
              >
                <Icon as={Reply} boxSize={3} />
              </Button>
            )}
          </Box>

          {/* Read Receipt Indicator */}
          <Flex align="center" gap={1} mt={1} justify={isOwnMessage ? "flex-end" : "flex-start"}>
            <ReadReceiptIndicator
              message={message}
              readReceipts={readReceipts}
              isOwnMessage={isOwnMessage}
              currentUserId={currentUserId}
            />
          </Flex>
        </Stack>
      </Flex>
    </Flex>
  );
};
