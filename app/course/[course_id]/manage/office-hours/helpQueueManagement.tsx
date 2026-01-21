"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import useModalManager from "@/hooks/useModalManager";
import { useConnectionStatus, useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import { getQueueTypeColor } from "@/lib/utils";
import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Flex, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { BsPencil, BsPlus, BsTrash } from "react-icons/bs";
import CreateHelpQueueModal from "./modals/createHelpQueueModal";
import EditHelpQueueModal from "./modals/editHelpQueueModal";
import DiscordChannelLink from "@/components/discord/discord-channel-link";

/**
 * Component for managing help queues in a course.
 * Allows instructors to create, edit, and delete help queues.
 * Uses real-time updates to show changes made by other instructors.
 */
export default function HelpQueueManagement() {
  // Modal management
  const createModal = useModalManager();
  const editModal = useModalManager<HelpQueue>();

  // Get help queues and connection status using individual hooks
  const queues = useHelpQueues();
  const { isConnected, connectionStatus, isLoading: realtimeLoading } = useConnectionStatus();

  const { mutateAsync: deleteQueue } = useDelete();

  const handleDeleteQueue = async (queueId: number) => {
    await deleteQueue({
      resource: "help_queues",
      id: queueId,
      successNotification: {
        message: "Help queue deleted successfully",
        type: "success"
      },
      errorNotification: {
        message: "Failed to delete help queue",
        type: "error"
      }
    });
  };

  const handleCreateSuccess = () => {
    createModal.closeModal();
    // No need to refetch - realtime updates will handle data synchronization
  };

  const handleEditSuccess = () => {
    editModal.closeModal();
    // No need to refetch - realtime updates will handle data synchronization
  };

  if (realtimeLoading) return <Text>Loading help queues...</Text>;

  const getQueueTypeLabel = (type: string) => {
    switch (type) {
      case "text":
        return "Text Chat";
      case "video":
        return "Video Call";
      case "in_person":
        return "In Person";
      default:
        return type;
    }
  };

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Help Queue Management</Heading>
        <Button onClick={() => createModal.openModal()}>
          <Icon as={BsPlus} />
          Create New Queue
        </Button>
      </Flex>

      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Queue changes by other instructors may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {queues.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Text mb={4}>No help queues have been created yet.</Text>
          <Button onClick={() => createModal.openModal()}>
            <Icon as={BsPlus} />
            Create Your First Queue
          </Button>
        </Box>
      ) : (
        <Stack spaceY={4}>
          {queues.map((queue) => (
            <Box key={queue.id} p={4} borderWidth="1px" borderRadius="md">
              <Flex justify="space-between" align="flex-start">
                <Box flex="1">
                  <Flex align="center" gap={3} mb={2}>
                    <Text fontWeight="semibold" fontSize="lg">
                      {queue.name}
                    </Text>
                    <Badge colorPalette={getQueueTypeColor(queue.queue_type)} variant="solid">
                      {getQueueTypeLabel(queue.queue_type)}
                    </Badge>
                    {!queue.is_active && (
                      <Box
                        px={2}
                        py={1}
                        borderRadius="md"
                        bg="red.100"
                        color="red.700"
                        fontSize="sm"
                        fontWeight="medium"
                      >
                        Inactive
                      </Box>
                    )}
                  </Flex>

                  {queue.description && <Text mb={3}>{queue.description}</Text>}

                  <HStack spaceX={4} fontSize="sm">
                    <Text>
                      <Text as="span" fontWeight="medium">
                        Status:
                      </Text>{" "}
                      {queue.available ? "Available" : "Unavailable"}
                    </Text>
                    {queue.max_concurrent_requests && (
                      <Text>
                        <Text as="span" fontWeight="medium">
                          Max Requests:
                        </Text>{" "}
                        {queue.max_concurrent_requests}
                      </Text>
                    )}
                    {queue.closing_at && (
                      <Text>
                        <Text as="span" fontWeight="medium">
                          Closes:
                        </Text>{" "}
                        <TimeZoneAwareDate date={queue.closing_at} format="compact" />
                      </Text>
                    )}
                    <Text>
                      <Text as="span" fontWeight="medium">
                        Queue Depth:
                      </Text>{" "}
                      {queue.depth}
                    </Text>
                  </HStack>
                </Box>

                <HStack spaceX={2}>
                  <DiscordChannelLink
                    channelType="office_hours"
                    resourceId={queue.id}
                    size="sm"
                    variant="outline"
                    tooltipText="Open Discord Channel"
                  />
                  <Button size="sm" variant="outline" onClick={() => editModal.openModal(queue)}>
                    <Icon as={BsPencil} />
                    Edit
                  </Button>
                  <PopConfirm
                    triggerLabel="Delete queue"
                    trigger={
                      <Button size="sm" variant="outline" colorPalette="red">
                        <Icon as={BsTrash} />
                        Delete
                      </Button>
                    }
                    confirmHeader="Delete Queue"
                    confirmText={`Are you sure you want to delete the queue "${queue.name}"? This action cannot be undone.`}
                    onConfirm={async () => await handleDeleteQueue(queue.id)}
                  />
                </HStack>
              </Flex>
            </Box>
          ))}
        </Stack>
      )}

      {/* Modals */}
      <CreateHelpQueueModal
        isOpen={createModal.isOpen}
        onClose={createModal.closeModal}
        onSuccess={handleCreateSuccess}
      />

      <EditHelpQueueModal
        isOpen={editModal.isOpen}
        onClose={editModal.closeModal}
        onSuccess={handleEditSuccess}
        queue={editModal.modalData}
      />
    </Box>
  );
}
