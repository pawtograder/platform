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
import { TopicIcon } from "@/components/discussion/TopicIcon";
import { Badge, Box, Container, Flex, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { BsPencil, BsPlus, BsTrash, BsLink45Deg, BsLock, BsChatDots, BsGripVertical } from "react-icons/bs";
import CreateTopicModal from "./modals/createTopicModal";
import EditTopicModal from "./modals/editTopicModal";
import { toaster } from "@/components/ui/toaster";
import { useMemo } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  useDraggable,
  useDroppable
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

/**
 * Draggable and droppable topic item component.
 * Wraps a topic in drag-and-drop functionality for reordering.
 */
function DraggableTopicItem({
  topic,
  isCustomTopic,
  linkedAssignment,
  threadCount,
  hasThreads,
  onEdit,
  onDelete
}: {
  topic: DiscussionTopic;
  isCustomTopic: boolean;
  linkedAssignment: string | null | undefined;
  threadCount: number;
  hasThreads: boolean;
  onEdit: (topic: DiscussionTopic) => void;
  onDelete: (topicId: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    transform,
    isDragging
  } = useDraggable({
    id: topic.id
  });

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: topic.id
  });

  // Combine refs for both draggable and droppable
  const setNodeRef = (node: HTMLElement | null) => {
    setDraggableRef(node);
    setDroppableRef(node);
  };

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      p={4}
      borderWidth="1px"
      borderRadius="md"
      bg={isDragging ? "bg.emphasized" : isOver && !isDragging ? "bg.subtle" : "bg.panel"}
      borderColor={isDragging ? "blue.solid" : isOver && !isDragging ? "blue.solid" : "border.emphasized"}
      borderStyle={isDragging ? "dashed" : "solid"}
      cursor={isDragging ? "grabbing" : "grab"}
      transition="all 0.2s"
    >
      <Flex justify="space-between" align="flex-start">
        <Box flex="1">
          <Flex align="center" gap={3} mb={2}>
            <Box
              {...listeners}
              {...attributes}
              cursor="grab"
              _active={{ cursor: "grabbing" }}
              color="fg.muted"
              _hover={{ color: "fg.default" }}
              display="inline-flex"
              alignItems="center"
              mr={1}
            >
              <Icon as={BsGripVertical} />
            </Box>
            <Badge colorPalette={topic.color} variant="solid" px={3} py={1}>
              {topic.topic}
              <TopicIcon name={topic.icon} />
            </Badge>
            {topic.default_follow && (
              <Badge variant="subtle" colorPalette="blue">
                Default follow
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
          <Button size="sm" variant="outline" onClick={() => onEdit(topic)}>
            <Icon as={BsPencil} />
            Edit
          </Button>
          {isCustomTopic &&
            (hasThreads ? (
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
                onConfirm={async () => await onDelete(topic.id)}
              />
            ))}
        </HStack>
      </Flex>
    </Box>
  );
}

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

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // Require 8px of movement before starting drag
      }
    }),
    useSensor(KeyboardSensor)
  );

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

  /**
   * Handles drag end event and updates topic ordinals.
   * Reorders topics and updates all affected ordinals in the database.
   */
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const activeIndex = sortedTopics.findIndex((topic) => topic.id === active.id);
    const overIndex = sortedTopics.findIndex((topic) => topic.id === over.id);

    if (activeIndex === -1 || overIndex === -1) {
      return;
    }

    // Create new array with reordered topics
    const newOrder = [...sortedTopics];
    const [movedTopic] = newOrder.splice(activeIndex, 1);
    newOrder.splice(overIndex, 0, movedTopic);

    // Calculate new ordinals (starting from 1)
    const updates = newOrder.map((topic, index) => ({
      id: topic.id,
      newOrdinal: index + 1
    }));

    // Only update topics that actually changed ordinal
    const topicsToUpdate = updates.filter((update) => {
      const originalTopic = sortedTopics.find((t) => t.id === update.id);
      return originalTopic && originalTopic.ordinal !== update.newOrdinal;
    });

    if (topicsToUpdate.length === 0) {
      return;
    }

    // Update all affected topics
    try {
      await Promise.all(
        topicsToUpdate.map((update) =>
          controller.discussionTopics.update(update.id, {
            ordinal: update.newOrdinal
          })
        )
      );

      toaster.success({
        title: "Success",
        description: "Topic order updated successfully"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to update topic order: ${error instanceof Error ? error.message : String(error)}`
      });
    }
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <Stack spaceY={4}>
            {sortedTopics.map((topic) => {
              const linkedAssignment = topic.assignment_id ? assignmentMap.get(topic.assignment_id) : null;
              const threadCount = topicThreadCountMap.get(topic.id) ?? 0;
              const hasThreads = threadCount > 0;

              return (
                <DraggableTopicItem
                  key={topic.id}
                  topic={topic}
                  isCustomTopic={true}
                  linkedAssignment={linkedAssignment ?? null}
                  threadCount={threadCount}
                  hasThreads={hasThreads}
                  onEdit={(topic) => editModal.openModal(topic)}
                  onDelete={handleDeleteTopic}
                />
              );
            })}
          </Stack>
        </DndContext>
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
