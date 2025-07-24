"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useDelete } from "@refinedev/core";
import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { BsPlus, BsPencil, BsTrash } from "react-icons/bs";
import useModalManager from "@/hooks/useModalManager";
import { PopConfirm } from "@/components/ui/popconfirm";
import CreateHelpQueueModal from "./modals/createHelpQueueModal";
import EditHelpQueueModal from "./modals/editHelpQueueModal";
import { Alert } from "@/components/ui/alert";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { useEffect } from "react";

/**
 * Component for managing help queues in a course.
 * Allows instructors to create, edit, and delete help queues.
 * Uses real-time updates to show changes made by other instructors.
 */
export default function HelpQueueManagement() {
  const { course_id } = useParams();

  // Modal management
  const createModal = useModalManager();
  const editModal = useModalManager<HelpQueue>();

  // Set up real-time subscriptions for global help queues
  const {
    data: realtimeData,
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true,
    enableStaffData: false
  });

  const { mutate: deleteQueue } = useDelete();

  // Use only realtime data
  const queues = realtimeData.helpQueues;

  // Set up realtime message handling for optimistic updates
  useEffect(() => {
    if (!isConnected) return;

    // Realtime updates are handled automatically by the hook
    // The controller will update the realtimeData when queue changes are broadcast
    console.log("Help queue management realtime connection established");
  }, [isConnected]);

  const handleDeleteQueue = (queueId: number) => {
    deleteQueue({
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

  const getQueueTypeColor = (type: string) => {
    switch (type) {
      case "text":
        return "blue";
      case "video":
        return "green";
      case "in_person":
        return "orange";
      default:
        return "gray";
    }
  };

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
                    <Box
                      px={2}
                      py={1}
                      borderRadius="md"
                      bg={`${getQueueTypeColor(queue.queue_type)}.100`}
                      color={`${getQueueTypeColor(queue.queue_type)}.700`}
                      fontSize="sm"
                      fontWeight="medium"
                    >
                      {getQueueTypeLabel(queue.queue_type)}
                    </Box>
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
                    {isConnected && (
                      <Text fontSize="xs" color="green.500">
                        ● Live
                      </Text>
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
                        {new Date(queue.closing_at).toLocaleString()}
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
                    onConfirm={() => handleDeleteQueue(queue.id)}
                    onCancel={() => {}}
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
