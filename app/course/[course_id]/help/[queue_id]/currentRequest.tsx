import { DataList, Flex, Icon, IconButton, Text } from "@chakra-ui/react";

import { Box } from "@chakra-ui/react";
import { HelpQueue, HelpRequest, HelpRequestMessage } from "@/utils/supabase/DatabaseTypes";
import { HelpRequestChatChannelProvider, useChatChannel } from "@/lib/chat";
import useUserProfiles, { useUserProfile } from "@/hooks/useUserProfiles";
import { useList, useOne } from "@refinedev/core";
import { useAppState } from "@/lib/aws-chime-sdk-meeting/providers/AppStateProvider";
import useAuthState from "@/hooks/useAuthState";
import HelpRequestChat from "@/components/ui/help-queue/HelpRequestChat";
import { BsCameraVideo } from "react-icons/bs";
function ChatChannelParticipants() {
  const { participants } = useChatChannel();
  const profiles = useUserProfiles();
  return (
    <>
      {participants.map((participant, index) => (
        <Text key={participant}>
          {profiles.users.find((p) => p.id === participant)?.name}
          {index === participants.length - 1 ? "" : ", "}
        </Text>
      ))}
    </>
  );
}
function HelpRequestStudentActions({ request }: { request: HelpRequest }) {
  console.log(request.is_video_live);
  if (request.is_video_live)
    return (
      <>
        <IconButton
          aria-label="Join Video Call"
          variant="ghost"
          onClick={() => {
            window.open(
              `${process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/course/${request.class_id}/help/${request.help_queue}/request/${request.id}/meet`,
              "_blank"
            );
          }}
        >
          <Icon as={BsCameraVideo} />
        </IconButton>
      </>
    );
  else return <></>;
}
export default function CurrentRequest({ queue, request }: { queue: HelpQueue; request: HelpRequest }) {
  const assignee = useUserProfile(request.assignee);
  return (
    <Box width="100%">
      <DataList.Root>
        <DataList.Item>
          <DataList.ItemLabel>Your position in the queue</DataList.ItemLabel>
          <DataList.ItemValue>{queue.depth} (need to implement)</DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>Working on this request:</DataList.ItemLabel>
          <DataList.ItemValue>{assignee ? assignee.name : "Nobody is working on this request yet"}</DataList.ItemValue>
        </DataList.Item>
      </DataList.Root>

      <Flex height="100vh" overflow="hidden" width="100%">
        <HelpRequestChatChannelProvider help_request={request}>
          <HelpRequestChat request={request} actions={<HelpRequestStudentActions request={request} />} />
        </HelpRequestChatChannelProvider>
      </Flex>
    </Box>
  );
}
