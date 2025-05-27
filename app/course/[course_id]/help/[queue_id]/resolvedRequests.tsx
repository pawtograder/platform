import HelpRequestChat from "@/components/ui/help-queue/HelpRequestChat";
import { HelpRequestChatChannelProvider } from "@/lib/chat";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";

export default function HelpRequestHistory({ requests }: { requests: HelpRequest[] }) {
  const [curRequest, setCurRequest] = useState<HelpRequest | null>(requests[0] ?? null);
  return (
    <div>
      Resolved Requests
      <Stack spaceY={4}>
        {requests
          .sort((a, b) => new Date(b.resolved_at!).getTime() - new Date(a.resolved_at!).getTime())
          .map((request) => (
            <Box
              key={request.id}
              p={4}
              borderWidth="1px"
              borderRadius="lg"
              cursor="pointer"
              onClick={() => setCurRequest(request)}
              bg={curRequest?.id === request.id ? "bg.subtle" : "transparent"}
            >
              <HStack justify="space-between">
                <Text fontWeight="medium">{request.request}</Text>
                <Text fontSize="sm" color="fg.subtle">
                  {new Date(request.resolved_at!).toLocaleDateString()}
                </Text>
              </HStack>
              {request === curRequest && (
                <HelpRequestChatChannelProvider help_request={request}>
                  <HelpRequestChat request={request} actions={<></>} />
                </HelpRequestChatChannelProvider>
              )}
            </Box>
          ))}
      </Stack>
    </div>
  );
}
