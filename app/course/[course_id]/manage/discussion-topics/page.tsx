"use client";

import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import useModalManager from "@/hooks/useModalManager";
import {
  useCourseController,
  useDiscussionTopics,
  useAssignments,
  useDiscussionThreadTeasers
} from "@/hooks/useCourseController";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Container, Flex, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { BsPencil, BsPlus, BsTrash, BsLink45Deg, BsLock, BsChatDots } from "react-icons/bs";
import CreateTopicModal from "./modals/createTopicModal";
import EditTopicModal from "./modals/editTopicModal";
import { toaster } from "@/components/ui/toaster";
import { useMemo } from "react";
import { Tooltip } from "@/components/ui/tooltip";

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

  // Get topics, assignments, and threads from the course controller
  const controller = useCourseController();
  const topics = useDiscussionTopics();
  const assignments = useAssignments();
  const threads = useDiscussionThreadTeasers();

  /**
   * Create a map of assignment IDs to assignment titles for quick lookup.
   */
  const assignmentMap = useMemo(() => {
    const map = new Map<number, string>();
    assignments.forEach((a) => map.set(a.id, a.title));
    return map;
  }, [assignments]);

  /**
   * Create a map of topic IDs to thread counts for determining if a topic can be deleted.
   * Topics with existing threads cannot be deleted due to foreign key constraints.
   */
  const topicThreadCountMap = useMemo(() => {
    const map = new Map<number, number>();
    threads.forEach((thread) => {
      const currentCount = map.get(thread.topic_id) ?? 0;
      map.set(thread.topic_id, currentCount + 1);
    });
    return map;
  }, [threads]);

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
   *
   * Deletion is prevented if the topic has existing discussion threads referencing it,
   * as this would violate the foreign key constraint. The UI prevents most cases,
   * but this handler also catches race conditions where threads are created
   * between the UI check and the actual delete operation.
   *
   * @param topicId - The ID of the topic to delete
   */
  const handleDeleteTopic = async (topicId: number) => {
    // Double-check thread count in case threads were created since the UI rendered
    const threadCount = topicThreadCountMap.get(topicId) ?? 0;
    if (threadCount > 0) {
      toaster.error({
        title: "Cannot Delete Topic",
        description: `This topic has ${threadCount} discussion thread${threadCount === 1 ? "" : "s"} referencing it. Remove or reassign the threads before deleting this topic.`
      });
      return;
    }

    try {
      await controller.discussionTopics.hardDelete(topicId);
      toaster.success({
        title: "Success",
        description: "Discussion topic deleted successfully"
      });
    } catch (error) {
      // Handle foreign key constraint violation gracefully
      // This can occur if a thread was created between the check above and the delete operation
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isForeignKeyViolation =
        errorMessage.includes("foreign key") ||
        errorMessage.includes("violates foreign key constraint") ||
        errorMessage.includes("discussion_threads_topic_id_fkey");

      if (isForeignKeyViolation) {
        toaster.error({
          title: "Cannot Delete Topic",
          description:
            "This topic has discussion threads referencing it. Remove or reassign the threads before deleting this topic."
        });
      } else {
        toaster.error({
          title: "Error",
          description: `Failed to delete topic: ${errorMessage}`
        });
      }
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
            const threadCount = topicThreadCountMap.get(topic.id) ?? 0;
            const hasThreads = threadCount > 0;

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
                      {threadCount > 0 && (
                        <Badge variant="subtle" colorPalette="gray">
                          <Icon as={BsChatDots} mr={1} />
                          {threadCount} thread{threadCount === 1 ? "" : "s"}
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
                        {hasThreads ? (
                          <Tooltip
                            content={`Cannot delete: ${threadCount} thread${threadCount === 1 ? "" : "s"} use${threadCount === 1 ? "s" : ""} this topic. Remove or reassign threads first.`}
                          >
                            <Button size="sm" variant="outline" colorPalette="red" disabled>
                              <Icon as={BsTrash} />
                              Delete
                            </Button>
                          </Tooltip>
                        ) : (
                          <PopConfirm
                            triggerLabel="Delete topic"
                            trigger={
                              <Button size="sm" variant="outline" colorPalette="red">
                                <Icon as={BsTrash} />
                                Delete
                              </Button>
                            }
                            confirmHeader="Delete Topic"
                            confirmText={`Are you sure you want to delete the topic "${topic.topic}"? This action cannot be undone.`}
                            onConfirm={async () => await handleDeleteTopic(topic.id)}
                          />
                        )}
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
