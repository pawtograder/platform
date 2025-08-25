import type { ChatMessage } from "@/hooks/useOfficeHoursRealtime";
import type { HelpRequestMessageReadReceipt } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Text, Icon, Stack, HStack, Badge, Link, Collapsible } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Reply, Check, CheckCheck, ChevronDown, ChevronRight } from "lucide-react";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useTagsForProfile } from "@/hooks/useTags";
import { Tooltip } from "@/components/ui/tooltip";
import Markdown from "@/components/ui/markdown";
import { ImageIcon, FileText } from "lucide-react";

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
 * Helper to extract file attachments from markdown content
 */
const extractFileAttachments = (content: string): Array<{ name: string; url: string; isImage: boolean }> => {
  const attachments: Array<{ name: string; url: string; isImage: boolean }> = [];

  // Match markdown image links: ![alt text](url)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  // Match markdown regular links: [text](url)
  const linkRegex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

  let match;

  // Find image attachments
  while ((match = imageRegex.exec(content)) !== null) {
    const [, name, url] = match;
    attachments.push({ name, url, isImage: true });
  }

  // Find regular file attachments
  while ((match = linkRegex.exec(content)) !== null) {
    const [, name, url] = match;
    attachments.push({ name, url, isImage: false });
  }

  return attachments;
};

/**
 * Helper to detect if message content contains code blocks
 */
const hasCodeBlocks = (content: string): boolean => {
  // Match code blocks: ```language ... ``` or ``` ... ```
  const codeBlockRegex = /```[\s\S]*?```/g;
  // Match inline code: `code`
  const inlineCodeRegex = /`[^`\n]+`/g;

  return codeBlockRegex.test(content) || inlineCodeRegex.test(content);
};

/**
 * Helper to determine if a message should be wrapped in a collapsible
 */
const shouldUseCollapsible = (content: string): boolean => {
  const attachments = extractFileAttachments(content);
  const hasCode = hasCodeBlocks(content);

  return attachments.length > 0 || hasCode;
};

/**
 * Component to display file attachments with appropriate icons
 */
const FileAttachments = ({ attachments }: { attachments: Array<{ name: string; url: string; isImage: boolean }> }) => {
  if (attachments.length === 0) return null;

  return (
    <Stack gap={1} mt={2}>
      {attachments.map((attachment, index) => (
        <HStack key={index} gap={1} align="center">
          {attachment.isImage ? (
            <Icon as={ImageIcon} color="fg.muted" boxSize={3} />
          ) : (
            <Icon as={FileText} color="fg.muted" boxSize={3} />
          )}
          <Link
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            fontSize="xs"
            color="fg.muted"
            _hover={{ color: "fg.info", textDecoration: "underline" }}
          >
            {attachment.name}
          </Link>
        </HStack>
      ))}
    </Stack>
  );
};

/**
 * Component that wraps message content in a collapsible when it contains code or attachments
 */
const CollapsibleMessageContent = ({ content, isOwnMessage }: { content: string; isOwnMessage: boolean }) => {
  const shouldCollapse = shouldUseCollapsible(content);
  const attachments = extractFileAttachments(content);
  const hasCode = hasCodeBlocks(content);

  // Determine the summary text for the collapsible trigger
  const getSummaryText = () => {
    const parts = [];
    if (hasCode) parts.push("code");
    if (attachments.length > 0) {
      parts.push(`${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`);
    }
    return `Message with ${parts.join(" and ")}`;
  };

  if (!shouldCollapse) {
    // For messages without code or attachments, render normally
    return (
      <>
        <Markdown>{content}</Markdown>
        <FileAttachments attachments={attachments} />
      </>
    );
  }

  // For messages with code or attachments, wrap in collapsible
  return (
    <Collapsible.Root defaultOpen={false}>
      <Collapsible.Trigger asChild>
        <HStack
          cursor="pointer"
          _hover={{ opacity: 0.8 }}
          transition="opacity 0.2s"
          role="button"
          tabIndex={0}
          justify="space-between"
          w="100%"
        >
          <Text fontSize="sm" fontWeight="medium" color={isOwnMessage ? "blue.contrast" : "fg.default"}>
            {getSummaryText()}
          </Text>
          <Collapsible.Context>
            {(collapsible) => (
              <Icon
                as={collapsible.open ? ChevronDown : ChevronRight}
                boxSize={4}
                color={isOwnMessage ? "blue.contrast" : "fg.muted"}
              />
            )}
          </Collapsible.Context>
        </HStack>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Box mt={2} pt={2} borderTop="1px solid" borderColor={isOwnMessage ? "blue.300" : "border.muted"}>
          <Markdown>{content}</Markdown>
          <FileAttachments attachments={attachments} />
        </Box>
      </Collapsible.Content>
    </Collapsible.Root>
  );
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
const ReadReceiptUser = ({
  userId,
  readReceipts
}: {
  userId: string;
  readReceipts: HelpRequestMessageReadReceipt[];
}) => {
  const profile = useUserProfile(userId);
  return (
    <Text>
      • {profile?.name || userId} on{" "}
      {new Date(readReceipts[0].created_at).toLocaleDateString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
        timeZoneName: "short"
      })}
    </Text>
  );
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
    return (
      <Text fontSize="xs">
        Read by {firstUserProfile?.name || readReceipts[0].viewer_id} on{" "}
        {new Date(readReceipts[0].created_at).toLocaleDateString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "America/New_York",
          timeZoneName: "short"
        })}
      </Text>
    );
  }

  return (
    <Box fontSize="xs" maxW="200px">
      <Text fontWeight="medium" mb={1}>
        Read by:
      </Text>
      <Stack gap={0}>
        {readReceipts.map((receipt, index) => (
          <ReadReceiptUser
            key={`${receipt.viewer_id}-${index}`}
            userId={receipt.viewer_id}
            readReceipts={readReceipts}
          />
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
        <Icon as={Check} boxSize={3} color="fg.muted" />
      </Tooltip>
    );
  }

  return (
    <Tooltip content={<ReadReceiptTooltipContent readReceipts={messageReadReceipts} />} showArrow>
      <HStack gap={1} align="center" cursor="pointer">
        <Icon as={CheckCheck} boxSize={3} color="fg.info" />
        {readCount > 1 && (
          <Text fontSize="2xs" color="fg.muted">
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
      borderColor="border.emphasized"
      bg="bg.emphasized"
      borderRadius="md"
      fontSize="xs"
    >
      <Text fontWeight="medium" color="fg.muted" mb={1}>
        Replying to {getReplyDisplayName()}
      </Text>
      <Box
        color="fg.muted"
        lineHeight="1.3"
        overflow="hidden"
        textOverflow="ellipsis"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical"
        }}
      >
        <Markdown>{getMessageContent(originalMessage)}</Markdown>
      </Box>
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
      <Flex
        maxW={{ base: "85%", md: "75%" }}
        w="fit-content"
        direction="column"
        gap={1}
        align={isOwnMessage ? "flex-end" : "flex-start"}
      >
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
            <Text color="fg.muted" fontSize="xs">
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
            borderColor="border.emphasized"
            bg={isOwnMessage ? "blue.solid" : "bg.emphasized"}
            color={isOwnMessage ? "blue.contrast" : "fg.default"}
            position="relative"
            _hover={{
              "& .reply-button": {
                opacity: 1
              }
            }}
            data-visual-test-no-radius
          >
            <CollapsibleMessageContent content={getMessageContent(message)} isOwnMessage={isOwnMessage} />

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
                data-visual-test-no-radius
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
