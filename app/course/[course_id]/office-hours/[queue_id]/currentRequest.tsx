import { DataList, Flex, Icon, IconButton } from "@chakra-ui/react";

import { Box } from "@chakra-ui/react";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { HelpRequestChatChannelProvider } from "@/lib/chat";
import { useUserProfile } from "@/hooks/useUserProfiles";
import HelpRequestChat from "@/components/ui/help-queue/HelpRequestChat";
import { BsCameraVideo } from "react-icons/bs";
import { useList } from "@refinedev/core";

// function ChatChannelParticipants() {
//   const { participants } = useChatChannel();
//   const profiles = useUserProfiles();
//   return (
//     <>
//       {participants.map((participant, index) => (
//         <Text key={participant}>
//           {profiles.users.find((p) => p.id === participant)?.name}
//           {index === participants.length - 1 ? "" : ", "}
//         </Text>
//       ))}
//     </>
//   );
// }

function HelpRequestStudentActions({ request }: { request: HelpRequest }) {
  if (request.is_video_live)
    return (
      <>
        <IconButton
          aria-label="Join Video Call"
          variant="ghost"
          onClick={() => {
            window.open(
              `${process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/course/${request.class_id}/office-hours/${request.help_queue}/request/${request.id}/meet`,
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
  // Fetch unresolved requests in this queue to compute position
  const { data: openRequestsData } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "help_queue", operator: "eq", value: queue.id },
      { field: "resolved_by", operator: "null", value: null }
    ],
    sorters: [{ field: "created_at", order: "asc" }],
    pagination: { current: 1, pageSize: 1000 }
  });

  const unresolved = openRequestsData?.data ?? [];
  const position = unresolved.findIndex((r) => r.id === request.id) + 1;
  return (
    <Box width="100%">
      <DataList.Root>
        <DataList.Item>
          <DataList.ItemLabel>Your position in the queue</DataList.ItemLabel>
          <DataList.ItemValue>{position > 0 ? position : "-"}</DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>Working on this request:</DataList.ItemLabel>
          <DataList.ItemValue>{assignee ? assignee.name : "Nobody is working on this request yet"}</DataList.ItemValue>
        </DataList.Item>
      </DataList.Root>

      <Flex height="100vh" overflow="hidden" width="100%">
        <HelpRequestChatChannelProvider help_request={request}>
          <HelpRequestChat request={request} />
          <HelpRequestStudentActions request={request} />
        </HelpRequestChatChannelProvider>
      </Flex>
    </Box>
  );
}
