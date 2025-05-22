import { Box, Button, Flex, Stack, Textarea } from "@chakra-ui/react";
import { FiSend } from "react-icons/fi";
import { ChatMessage } from "./ChatMessage";
import { ChatMessages } from "./ChatMessages";
import { useChatChannel, ChatMessage as ChatMessageType } from "@/lib/chat";
import { useCallback, useRef } from "react";
import { useClassProfiles } from "@/hooks/useClassProfiles";
export const ChatChannel = () => {
  const { messages, postMessage } = useChatChannel();
  const { private_profile_id } = useClassProfiles();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  //Group messages by contiguous messages from the same user
  const groupedMessages = messages.reduce(
    (acc, msg) => {
      const lastGroup = acc[acc.length - 1];
      if (lastGroup && lastGroup.author === msg.author) {
        lastGroup.messages.push(msg);
      } else {
        acc.push({ author: msg.author, messages: [msg] });
      }
      return acc;
    },
    [] as { author: string; messages: ChatMessageType[] }[]
  );
  const sendMessage = useCallback(() => {
    if (!inputRef.current) {
      return;
    }
    postMessage(inputRef.current.value, private_profile_id!).then(() => {
      inputRef.current!.value = "";
      inputRef.current!.focus();
    });
  }, [postMessage, private_profile_id]);
  return (
    <Box>
      <Flex direction="column" pos="relative" bg="bg.canvas" height="100vh" overflow="hidden">
        <Box paddingTop="20" paddingBottom="40">
          <ChatMessages>
            {groupedMessages.map((group) => (
              <ChatMessage key={group.author} author={group.author} messages={group.messages} />
            ))}
          </ChatMessages>
        </Box>

        <Box
          pos="absolute"
          bottom="0"
          insetX="0"
          bgGradient="linear(to-t, bg.canvas 80%, rgba(0,0,0,0))"
          paddingY="8"
          marginX="4"
        >
          <Stack maxW="prose" mx="auto">
            <Box
              as="form"
              pos="relative"
              pb="1"
              onSubmit={(ev) => {
                ev.preventDefault();
                sendMessage();
              }}
            >
              <Textarea
                name="message"
                placeholder=""
                maxHeight="200px"
                paddingEnd="9"
                ref={inputRef}
                resize="none"
                rows={2}
                _placeholder={{ color: "fg.subtle" }}
                onKeyDown={(event) => {
                  console.log(event.metaKey, event.key);
                  if (event.metaKey && event.key === "Enter") {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                onInput={(event) => {
                  const textarea = event.currentTarget;
                  textarea.style.height = "auto";
                  const borderHeight = textarea.offsetHeight - textarea.clientHeight;
                  textarea.style.height = textarea.scrollHeight + borderHeight + "px";
                }}
              />
              <Box pos="absolute" top="3" right="0" zIndex="2">
                <Button size="sm" type="submit" variant="outline" colorPalette="gray" aria-label="Send message">
                  <FiSend />
                </Button>
              </Box>
            </Box>
          </Stack>
        </Box>
      </Flex>
    </Box>
  );
};
