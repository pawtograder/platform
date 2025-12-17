"use client";

import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import useModalManager from "@/hooks/useModalManager";
import { useCourseController, useDiscussionTopics, useAssignments } from "@/hooks/useCourseController";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Container, Flex, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { BsPencil, BsPlus, BsTrash, BsLink45Deg, BsLock } from "react-icons/bs";
import CreateTopicModal from "./modals/createTopicModal";
import EditTopicModal from "./modals/editTopicModal";
import { toaster } from "@/components/ui/toaster";
import { useMemo } from "react";

/**
 * Page component for managing discussion topics in a course.
 * Allows instructors to create, edit, and delete custom discussion topics.
 * Default topics (created automatically when a class is created) are displayed
 * but cannot be edited or deleted.
 *
 * Uses real-time updates via TableController to show changes made by other instructors.
 *
 * @returns The rendered discussion topics management page
 */
export default function DiscussionTopicsPage() {
  // Modal management using the useModalManager hook pattern
  const createModal = useModalManager();
  const editModal = useModalManager<DiscussionTopic>();

  // Get topics and assignments from the course controller
  const controller = useCourseController();
  const topics = useDiscussionTopics();
  const assignments = useAssignments();

  /**
   * Create a map of assignment IDs to assignment titles for quick lookup.
   */
  const assignmentMap = useMemo(() => {
    const map = new Map<number, string>();
    assignments.forEach((a) => map.set(a.id, a.title));
    return map;
  }, [assignments]);

  /**
   * Sort topics by ordinal for consistent display order.
   * Default topics (ordinal 1-4) appear first, custom topics after.
   */
  const sortedTopics = useMemo(() => {
    if (!topics) return [];
    return [...topics].sort((a, b) => a.ordinal - b.ordinal);
  }, [topics]);

  /**
   * Handles deleting a custom discussion topic.
   * Uses hardDelete since discussion_topics doesn't have a deleted_at column.
   * @param topicId - The ID of the topic to delete
   */
  const handleDeleteTopic = async (topicId: number) => {
    try {
      await controller.discussionTopics.hardDelete(topicId);
      toaster.success({
        title: "Success",
        description: "Discussion topic deleted successfully"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to delete topic: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  /**
   * Callback for successful topic creation.
   */
  const handleCreateSuccess = () => {
    createModal.closeModal();
    // Real-time updates handle data synchronization automatically
  };

  /**
   * Callback for successful topic edit.
   */
  const handleEditSuccess = () => {
    editModal.closeModal();
    // Real-time updates handle data synchronization automatically
  };

  return (
    <Container maxW="container.lg" py={6}>
      <Flex justify="space-between" align="center" mb={6}>
        <Box>
          <Heading size="lg">Discussion Topics</Heading>
          <Text color="fg.muted" mt={1}>
            Manage discussion topics for your course. Students use topics to categorize their posts.
          </Text>
        </Box>
        <Button onClick={() => createModal.openModal()} colorPalette="green">
          <Icon as={BsPlus} />
          Create Topic
        </Button>
      </Flex>

      {sortedTopics.length === 0 ? (
        <Box textAlign="center" py={8} borderWidth="1px" borderRadius="md" borderStyle="dashed">
          <Text mb={4} color="fg.muted">
            No discussion topics have been created yet.
          </Text>
          <Button onClick={() => createModal.openModal()} colorPalette="green">
            <Icon as={BsPlus} />
            Create Your First Topic
          </Button>
        </Box>
      ) : (
        <Stack spaceY={4}>
          {sortedTopics.map((topic) => {
            const isCustomTopic = topic.instructor_created;
            const linkedAssignment = topic.assignment_id ? assignmentMap.get(topic.assignment_id) : null;

            return (
              <Box key={topic.id} p={4} borderWidth="1px" borderRadius="md" bg="bg.panel">
                <Flex justify="space-between" align="flex-start">
                  <Box flex="1">
                    <Flex align="center" gap={3} mb={2}>
                      <Badge colorPalette={topic.color} variant="solid" px={3} py={1}>
                        {topic.topic}
                      </Badge>
                      {!isCustomTopic && (
                        <Badge variant="outline" colorPalette="gray">
                          <Icon as={BsLock} mr={1} />
                          Default
                        </Badge>
                      )}
                      {linkedAssignment && (
                        <Badge variant="subtle" colorPalette="blue">
                          <Icon as={BsLink45Deg} mr={1} />
                          {linkedAssignment}
                        </Badge>
                      )}
                    </Flex>

                    <Text color="fg.muted" fontSize="sm">
                      {topic.description}
                    </Text>

                    <HStack spaceX={4} fontSize="xs" color="fg.subtle" mt={2}>
                      <Text>Ordinal: {topic.ordinal}</Text>
                    </HStack>
                  </Box>

                  <HStack spaceX={2}>
                    {isCustomTopic ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => editModal.openModal(topic)}>
                          <Icon as={BsPencil} />
                          Edit
                        </Button>
                        <PopConfirm
                          triggerLabel="Delete topic"
                          trigger={
                            <Button size="sm" variant="outline" colorPalette="red">
                              <Icon as={BsTrash} />
                              Delete
                            </Button>
                          }
                          confirmHeader="Delete Topic"
                          confirmText={`Are you sure you want to delete the topic "${topic.topic}"? Discussion threads using this topic will no longer be categorized.`}
                          onConfirm={async () => await handleDeleteTopic(topic.id)}
                        />
                      </>
                    ) : (
                      <Text fontSize="sm" color="fg.subtle" fontStyle="italic">
                        Default topics cannot be modified
                      </Text>
                    )}
                  </HStack>
                </Flex>
              </Box>
            );
          })}
        </Stack>
      )}

      {/* Modals */}
      <CreateTopicModal isOpen={createModal.isOpen} onClose={createModal.closeModal} onSuccess={handleCreateSuccess} />

      <EditTopicModal
        isOpen={editModal.isOpen}
        onClose={editModal.closeModal}
        onSuccess={handleEditSuccess}
        topic={editModal.modalData}
      />
    </Container>
  );
}
