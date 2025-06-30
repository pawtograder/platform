import type { ChatMessage } from "@/hooks/use-realtime-chat";
import { Box, Flex, Text } from "@chakra-ui/react";

interface ChatMessageItemProps {
  message: ChatMessage;
  isOwnMessage: boolean;
  showHeader: boolean;
}

export const ChatMessageItem = ({ message, isOwnMessage, showHeader }: ChatMessageItemProps) => {
  return (
    <Flex mt={2} justify={isOwnMessage ? "flex-end" : "flex-start"}>
      <Flex maxW="75%" w="fit-content" direction="column" gap={1} align={isOwnMessage ? "flex-end" : "flex-start"}>
        {showHeader && (
          <Flex
            align="center"
            gap={2}
            fontSize="xs"
            px={3}
            justify={isOwnMessage ? "flex-end" : "flex-start"}
            direction={isOwnMessage ? "row-reverse" : "row"}
          >
            <Text fontWeight="medium">{message.author}</Text>
            <Text color="gray.500" _dark={{ color: "gray.400" }} fontSize="xs">
              {new Date(message.created_at).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
              })}
            </Text>
          </Flex>
        )}
        <Box
          py={2}
          px={3}
          borderRadius="xl"
          fontSize="sm"
          w="fit-content"
          bg={isOwnMessage ? "blue.500" : "gray.100"}
          color={isOwnMessage ? "white" : "black"}
          _dark={{
            bg: isOwnMessage ? "blue.500" : "gray.700",
            color: isOwnMessage ? "white" : "white"
          }}
        >
          {message.message}
        </Box>
      </Flex>
    </Flex>
  );
};
