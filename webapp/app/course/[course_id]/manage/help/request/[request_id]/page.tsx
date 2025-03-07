'use client'

import { useParams } from "next/navigation";
import { useShow, useUpdate } from "@refinedev/core";
import { HelpRequest, HelpRequestMessage } from "@/utils/supabase/DatabaseTypes"
import { BsCameraVideo, BsClipboardCheckFill, BsClipboardCheck } from "react-icons/bs";
import { HelpRequestChatChannelProvider } from "@/lib/chat";
import { Icon, IconButton, Skeleton, Text } from "@chakra-ui/react";
import  HelpRequestChat from "@/components/ui/help-queue/HelpRequestChat";
import useAuthState from "@/hooks/useAuthState";
import { useEffect } from "react";
import { useState } from "react";
const HelpRequestAssignment = ({ request }: { request: HelpRequest }) => {
    const { private_profile_id } = useAuthState();
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
  
    if (assignee === private_profile_id) {
      return <Text>Assigned to you <IconButton aria-label="Drop Assignment" onClick={() => updateRequest({ id: request.id, values: { assignee: null } })}><Icon as={BsClipboardCheckFill} /></IconButton></Text>
    } else if (assignee) {
      return <Text>Assigned to {request.assignee}</Text>
    } else {
      return <Text>Not assigned <IconButton aria-label="Assume Assignment" variant="outline" onClick={() => updateRequest({ id: request.id, values: { assignee: private_profile_id } })}><Icon as={BsClipboardCheck} /></IconButton></Text>
    }
  }

export default function HelpRequestPage() {
    const { request_id } = useParams();
    const { query: { data : activeRequest, isLoading} } = useShow<HelpRequest>({
        resource: "help_requests",
        id: Number.parseInt(request_id as string)
    })
    if (isLoading || !activeRequest) {
        return <Skeleton />
    }
    return <HelpRequestChatChannelProvider help_request={activeRequest.data}>
        <HelpRequestChat request={activeRequest.data} actions={
            <>
                <HelpRequestAssignment request={activeRequest.data} />
                <IconButton
                    aria-label="Join Video Call"
                    onClick={() => {
                        window.open(`${process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/course/${activeRequest.data.class_id}/help/${activeRequest.data.help_queue}/request/${activeRequest.data.id}/meet`, '_blank');
                    }}
                >
                    <Icon as={BsCameraVideo} fontSize="md!" />
                </IconButton>
            </>
        } />
    </HelpRequestChatChannelProvider>
}