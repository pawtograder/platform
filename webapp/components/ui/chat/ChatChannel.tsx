import { Box, Button, Flex, HStack, Stack, Textarea } from '@chakra-ui/react'
import { FiDownloadCloud, FiRepeat, FiSend } from 'react-icons/fi'
import { ChatActionButton } from './ChatActionButton'
import { ChatMessage } from './ChatMessage'
import { ChatMessages } from './ChatMessages'
import useUserProfiles from '@/hooks/useUserProfiles'
import { useChatChannel, ChatMessage as ChatMessageType } from '@/lib/chat'
import { useCallback, useRef } from 'react'
export const ChatChannel = () => {
  const { messages, postMessage } = useChatChannel()
  const userProfile = useUserProfiles()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  //Group messages by contiguous messages from the same user
  const groupedMessages = messages.reduce((acc, msg) => {
    const lastGroup = acc[acc.length - 1]
    if (lastGroup && lastGroup.user_id === msg.user_id) {
      lastGroup.messages.push(msg)
    } else {
      acc.push({
        user_id: msg.user_id,
        messages: [msg]
      })
    }
    return acc
  }, [] as { user_id: string, messages: ChatMessageType[] }[])
  const sendMessage = useCallback(() => {
    if (!inputRef.current) { return }
    postMessage(inputRef.current.value).then(() => {
      inputRef.current!.value = ''
      inputRef.current!.focus()
    })
  }, [postMessage])
  return (
    <Box>

      <Flex direction="column" pos="relative" bg="bg.canvas" height="100vh" overflow="hidden">
        <Box paddingTop="20" paddingBottom="40">
          <ChatMessages>
            {groupedMessages.map((group) => (
              <ChatMessage key={group.user_id} author_id={group.user_id} messages={group.messages} />
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
            <Box as="form" pos="relative" pb="1" onSubmit={(ev) => {
              ev.preventDefault()
              sendMessage()
            }}>
              <Textarea
                name="message"
                placeholder=""
                maxHeight="200px"
                paddingEnd="9"
                ref={inputRef}
                resize="none"
                rows={2}
                _placeholder={{ color: 'fg.subtle' }}
                onKeyDown={(event) => {
                  console.log(event.metaKey, event.key)
                  if (event.metaKey && event.key === 'Enter') {
                    event.preventDefault();
                    sendMessage()
                  }
                }}
                onInput={(event) => {
                  const textarea = event.currentTarget
                  textarea.style.height = 'auto'
                  const borderHeight = textarea.offsetHeight - textarea.clientHeight
                  textarea.style.height = textarea.scrollHeight + borderHeight + 'px'
                }}
              />
              <Box pos="absolute" top="3" right="0" zIndex="2">
                <Button size="sm" type="submit" variant="outline" colorScheme="gray">
                  <FiSend />
                </Button>
              </Box>
            </Box>
          </Stack>
        </Box >
      </Flex >
    </Box>
  )
}
