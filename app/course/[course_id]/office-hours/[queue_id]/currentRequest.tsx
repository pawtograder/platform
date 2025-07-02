import { DataList, Flex, Icon, IconButton, Button, HStack } from "@chakra-ui/react";

import { Box } from "@chakra-ui/react";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import HelpRequestChat from "@/components/ui/help-queue/help-request-chat";
import { BsCameraVideo, BsXCircle } from "react-icons/bs";
import { useList, useUpdate } from "@refinedev/core";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useCallback } from "react";
import { toaster } from "@/components/ui/toaster";

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
  const { mutate: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    id: request.id,
    mutationOptions: {
      onSuccess: () => {
        toaster.success({
          title: "Request closed",
          description: "Your help request has been closed successfully."
        });
      },
      onError: () => {
        toaster.error({
          title: "Failed to close request",
          description: "There was an error closing your request. Please try again."
        });
      }
    }
  });

  const closeOwnRequest = useCallback(() => {
    updateRequest({
      id: request.id,
      values: {
        status: "closed"
      }
    });
  }, [updateRequest, request.id]);

  // Don't show actions for already closed/resolved requests
  if (request.status === "closed" || request.status === "resolved") {
    return null;
  }

  return (
    <HStack gap={2} mb={4}>
      {/* Video Call Button */}
      {request.is_video_live && (
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
      )}

      {/* Close Request Button */}
      <PopConfirm
        triggerLabel="Close Request"
        trigger={
          <Button size="sm" colorPalette="red" variant="outline">
            <Icon as={BsXCircle} fontSize="md!" />
            Close Request
          </Button>
        }
        confirmHeader="Close Your Request"
        confirmText="Are you sure you want to close your help request? This cannot be undone."
        onConfirm={closeOwnRequest}
        onCancel={() => {}}
      />
    </HStack>
  );
}

export default function CurrentRequest({ queue, request }: { queue: HelpQueue; request: HelpRequest }) {
  const assignee = useUserProfile(request.assignee);
  // Fetch active requests in this queue to compute position (oldest first)
  const { data: openRequestsData } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "help_queue", operator: "eq", value: queue.id },
      { field: "status", operator: "in", value: ["open", "in_progress"] }
    ],
    sorters: [{ field: "created_at", order: "asc" }],
    pagination: { current: 1, pageSize: 1000 }
  });

  const activeRequests = openRequestsData?.data ?? [];
  const position = activeRequests.findIndex((r) => r.id === request.id) + 1;
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

      <HelpRequestStudentActions request={request} />

      <Flex height="100vh" overflow="hidden" width="100%">
        <HelpRequestChat request={request} />
      </Flex>
    </Box>
  );
}
