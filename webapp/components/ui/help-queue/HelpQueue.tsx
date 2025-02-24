'use client'
import {
  Avatar,
  AvatarGroup,
  Box,
  Flex,
  Group,
  HStack,
  Icon,
  IconButton,
  Input,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react'
import { BsCameraFill, BsCameraVideo, BsChatTextFill, BsClipboardCheck, BsClipboardCheckFill, BsMicFill, BsPaperclip, BsPinAngleFill, BsSend } from 'react-icons/bs'
import { ChatGroupHeader } from './ChatGroupHeader'
import { ChatMessage } from './ChatMessage'
import { SearchInput } from './SearchInput'
import { useList, useUpdate } from '@refinedev/core'
import { HelpRequest } from '@/utils/supabase/DatabaseTypes'
import useAuthState from '@/hooks/useAuthState'
import { useRef, useState, useEffect, useCallback, Fragment } from 'react';
import { HelpRequestChatChannelProvider, useChatChannel } from '@/lib/chat'
import { HelpRequestTeaser } from './HelpRequestTeaser'
import { useUserProfile } from '@/hooks/useUserProfiles'
import { useRouter } from 'next/navigation';
import HelpRequestChat from './HelpRequestChat'
const HelpRequestAssignment = ({ request }: { request: HelpRequest }) => {
  const user = useAuthState();
  const [assignee, setAssignee] = useState(request.assignee);
  useEffect(() => {
    setAssignee(request.assignee);
  }, [request.assignee]);
  const { mutateAsync: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    mutationMode: "optimistic",
    id: request.id,
    mutationOptions: {
      onSuccess: (update) => {
        console.log("onSuccess", update.data.assignee);
        setAssignee(update.data.assignee);
      }
    }
  });

  if (assignee === user?.id) {
    return <Text>Assigned to you <IconButton aria-label="Drop Assignment" onClick={() => updateRequest({ id: request.id, values: { assignee: null } })}><Icon as={BsClipboardCheckFill} /></IconButton></Text>
  } else if (assignee) {
    return <Text>Assigned to {request.assignee}</Text>
  } else {
    return <Text>Not assigned <IconButton aria-label="Assume Assignment" variant="outline" onClick={() => updateRequest({ id: request.id, values: { assignee: user?.id } })}><Icon as={BsClipboardCheck} /></IconButton></Text>
  }
}


export const HelpQueue = ({ queue_id }: { queue_id: number }) => {
  const user = useAuthState();
  const [activeRequest, setActiveRequest] = useState<HelpRequest | null>(null);

  const { data } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "help_queue", operator: "eq", value: queue_id }
    ]
  })
  const requests = data?.data;
  return (<Flex height="100vh" overflow="hidden">
    <Stack spaceY="4" width="320px" borderEndWidth="1px" pt="6">
      <Box px="5">
        <Text fontSize="lg" fontWeight="medium">
          Requests ({requests?.length})
        </Text>
      </Box>

      <Box px="5">
        <SearchInput />
      </Box>

      <Stack mt="2" spaceY="4" flex="1" overflowY="auto" px="5" pb="5">
        <Stack mt="2" spaceY="4">
          <ChatGroupHeader icon={BsClipboardCheckFill}>Working ({requests?.filter(r => r.assignee === user?.id).length})</ChatGroupHeader>
          <Stack spaceY="0" mx="-4">
            {requests?.filter(r => r.assignee === user?.id && r.resolved_by === null).map((request) => (
              <HelpRequestTeaser key={request.id} data={{
                user: request.creator,
                updatedAt: request.created_at,
                message: request.request,
                isResolved: request.resolved_by !== null,
                isAssigned: request.assignee === user?.id
              }} onClick={() => setActiveRequest(request)} />
            ))}
          </Stack>
        </Stack>

        <Stack mt="2" spaceY="4">
          <ChatGroupHeader icon={BsChatTextFill}>Unassigned ({requests?.filter(r => r.assignee === null).length})</ChatGroupHeader>
          <Stack spaceY="0" mx="-4">
            {requests?.filter(r => r.assignee === null && r.resolved_by === null).map((request) => (
              <HelpRequestTeaser key={request.id} data={{
                user: request.creator,
                updatedAt: request.created_at,
                message: request.request,
                isResolved: request.resolved_by !== null,
                isAssigned: request.assignee === user?.id
              }} onClick={() => setActiveRequest(request)}
                selected={activeRequest?.id === request.id}
              />
            ))}
          </Stack>
        </Stack>
        <Stack mt="2" spaceY="4">
          <ChatGroupHeader icon={BsChatTextFill}>Resolved ({requests?.filter(r => r.resolved_by !== null).length})</ChatGroupHeader>
          <Stack spaceY="0" mx="-4">
            {requests?.filter(r => r.resolved_by !== null).map((request) => (
              <HelpRequestTeaser key={request.id} data={{
                user: request.creator,
                updatedAt: request.created_at,
                message: request.request,
                isResolved: request.resolved_by !== null,
                isAssigned: request.assignee === user?.id
              }} onClick={() => setActiveRequest(request)}
                selected={activeRequest?.id === request.id}
              />
            ))}
          </Stack>
        </Stack>
      </Stack>
    </Stack>

    {activeRequest &&
      <HelpRequestChatChannelProvider help_request={activeRequest}>
        <HelpRequestChat request={activeRequest} actions={
          <>
            <HelpRequestAssignment request={activeRequest} />
            <IconButton
              aria-label="Join Video Call"
              onClick={() => {
                window.open(`${process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/course/${activeRequest.class_id}/help/${activeRequest.help_queue}/request/${activeRequest.id}/meet`, '_blank');
              }}
            >
              <Icon as={BsCameraVideo} fontSize="md!" />
            </IconButton>
          </>
          } />
      </HelpRequestChatChannelProvider>
    }
  </Flex>
  )
}
