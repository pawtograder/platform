import { useUserProfile } from "@/hooks/useUserProfiles";
import { Avatar, Box, HStack, Stack, Text } from "@chakra-ui/react";
import type { ChatMessage as ChatMessageType } from "@/lib/chat";
import Markdown from "react-markdown";
interface Props {
  author: string;
  messages: ChatMessageType[];
}

export const ChatMessage = (props: Props) => {
  const { author, messages } = props;
  const userProfile = useUserProfile(author);
  return (
    <HStack align="flex-start" gap="5">
      <Box pt="1">
        <Avatar.Root size="sm" variant="subtle" shape="square">
          <Avatar.Fallback name={userProfile?.name} />
          <Avatar.Image src={userProfile?.avatar_url} />
        </Avatar.Root>
      </Box>
      <Stack spaceY="1">
        <Text fontWeight="medium">{userProfile?.name}</Text>
        <Stack spaceY="2">
          {messages.map((message, index) => (
            <Box key={index} color="fg.muted" lineHeight="tall">
              <Markdown>{message.message}</Markdown>
            </Box>
          ))}
        </Stack>
      </Stack>
    </HStack>
  );
};
