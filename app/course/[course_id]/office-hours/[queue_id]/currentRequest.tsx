import { DataList, Flex } from "@chakra-ui/react";
import { Box } from "@chakra-ui/react";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import HelpRequestChat from "@/components/ui/help-queue/help-request-chat";
import { useList } from "@refinedev/core";

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

      <Flex height="100vh" overflow="hidden" width="100%">
        <HelpRequestChat request={request} />
      </Flex>
    </Box>
  );
}
