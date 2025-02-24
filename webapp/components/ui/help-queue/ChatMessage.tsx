import { useUserProfile } from '@/hooks/useUserProfiles'
import { Avatar, Box, HStack, Stack, Text } from '@chakra-ui/react'
import Markdown from 'react-markdown'
interface MessageData {
  user: string
  updatedAt: string
  message: string
}

interface Props {
  data: MessageData
}

export const ChatMessage = (props: Props) => {
  const { user, updatedAt, message } = props.data
  const userProfile = useUserProfile(user);
  return (
    <HStack align="flex-start" gap="3" px="4" py="3"
      rounded="md"
    >
      <Box pt="1">
        <Avatar.Root size="sm">
          <Avatar.Image src={userProfile?.avatar_url} />
          <Avatar.Fallback>{userProfile?.name.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      </Box>
      <Stack spaceY="0" fontSize="sm" flex="1" truncate>
        <HStack spaceX="1">
          <Text fontWeight="medium" flex="1">
            {userProfile?.name}
          </Text>
          <Text color="fg.subtle" fontSize="xs">
            {updatedAt}
          </Text>
        </HStack>
        <Box color="fg.subtle" truncate>
          <Markdown>{message}</Markdown>
        </Box>
      </Stack>
    </HStack>
  )
}
