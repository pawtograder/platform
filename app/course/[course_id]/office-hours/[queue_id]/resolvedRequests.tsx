import HelpRequestChat from "@/components/ui/help-queue/HelpRequestChat";
import { HelpRequestChatChannelProvider } from "@/lib/chat";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Stack, Text, Card, Badge, Button, Icon } from "@chakra-ui/react";
import { useState } from "react";
import { BsChevronDown, BsChevronUp } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";

export default function HelpRequestHistory({ requests }: { requests: HelpRequest[] }) {
  const [expandedRequest, setExpandedRequest] = useState<number | null>(null);

  if (requests.length === 0) {
    return (
      <Card.Root>
        <Card.Body>
          <Text textAlign="center" color="fg.muted">
            No previous help requests found.
          </Text>
        </Card.Body>
      </Card.Root>
    );
  }

  return (
    <Stack spaceY={4}>
      <Text fontSize="lg" fontWeight="medium">
        Your Previous Requests
      </Text>
      <Stack spaceY={4}>
        {requests
          .sort((a, b) => new Date(b.resolved_at!).getTime() - new Date(a.resolved_at!).getTime())
          .map((request) => (
            <Card.Root
              key={request.id}
              variant="outline"
              cursor="pointer"
              _hover={{ borderColor: "border.emphasized" }}
            >
              <Card.Body>
                <HStack justify="space-between" align="start">
                  <Box flex="1">
                    <Text fontWeight="medium" fontSize="sm" lineHeight="short">
                      {request.request.length > 100 ? `${request.request.substring(0, 100)}...` : request.request}
                    </Text>
                    <HStack mt={2} gap={2}>
                      <Badge colorPalette="green" size="sm">
                        {request.status}
                      </Badge>
                      {request.location_type && (
                        <Badge colorPalette="blue" size="sm">
                          {request.location_type}
                        </Badge>
                      )}
                      {request.is_private && (
                        <Badge colorPalette="orange" size="sm">
                          Private
                        </Badge>
                      )}
                    </HStack>
                  </Box>
                  <Stack align="end" spaceY={1}>
                    <Text fontSize="xs" color="fg.muted">
                      {formatDistanceToNow(new Date(request.resolved_at!), { addSuffix: true })}
                    </Text>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedRequest(expandedRequest === request.id ? null : request.id);
                      }}
                    >
                      {expandedRequest === request.id ? "Hide" : "View"} Chat
                      <Icon as={expandedRequest === request.id ? BsChevronUp : BsChevronDown} ml={1} />
                    </Button>
                  </Stack>
                </HStack>

                {expandedRequest === request.id && (
                  <Box mt={4} pt={4} borderTopWidth="1px">
                    <HelpRequestChatChannelProvider help_request={request}>
                      <HelpRequestChat request={request} />
                    </HelpRequestChatChannelProvider>
                  </Box>
                )}
              </Card.Body>
            </Card.Root>
          ))}
      </Stack>
    </Stack>
  );
}
