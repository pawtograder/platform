import React, { Dispatch, SetStateAction, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  useDraggable,
  useDroppable,
  UniqueIdentifier
} from "@dnd-kit/core";
import { Box, VStack, HStack, Text, Badge, Container, Card, Flex } from "@chakra-ui/react";
import { CSS } from "@dnd-kit/utilities";
import { DraftReviewAssignment, UserRoleWithConflictsAndName } from "./page";

interface DraggableItemProps {
  item: DraftReviewAssignment;
}

interface DroppableAreaProps {
  id: string;
  title: string;
  items: DraftReviewAssignment[];
  children: React.ReactNode;
  hasConflict?: boolean;
}

function DraggableItem({ item }: DraggableItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.submission.id
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0 : 1
  };

  return (
    <Card.Root
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      cursor="grab"
      _active={{ cursor: "grabbing" }}
      _hover={{ shadow: "md" }}
      transition="all 0.2s"
      bg={isDragging ? "gray.50" : "white"}
      border={isDragging ? "2px solid" : "1px solid"}
      borderColor={isDragging ? "blue.300" : "gray.200"}
    >
      <Card.Body>
        <HStack gap={3}>
          <Text flex={1}>{item.submitter.profiles.name}</Text>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

function DroppableArea({ id, title, items, children, hasConflict }: Omit<DroppableAreaProps, "isOver">) {
  const { isOver, setNodeRef } = useDroppable({
    id
  });

  const getBorderColor = () => {
    if (isOver) {
      return hasConflict ? "red.400" : "green.400";
    }
    return "gray.200";
  };

  const getBgColor = () => {
    if (isOver) {
      return hasConflict ? "red.50" : "green.50";
    }
    return "gray.50";
  };

  return (
    <Card.Root
      ref={setNodeRef}
      p={4}
      size="sm"
      width="xs"
      borderRadius="lg"
      border="2px dashed"
      borderColor={getBorderColor()}
      bg={getBgColor()}
      transition="all 0.2s"
      minH="200px"
    >
      <Card.Title>
        <Flex justifyContent={"space-between"} alignItems={"center"}>
          <Text maxWidth={"90%"} textWrap={"wrap"}>
            {title}
          </Text>
          <Badge colorScheme={"gray"} variant="solid">
            {items.length}
          </Badge>
        </Flex>
      </Card.Title>
      <VStack gap={2} align="stretch">
        {children}
      </VStack>
    </Card.Root>
  );
}

export default function DragAndDropExample({
  draftReviews,
  setDraftReviews,
  courseStaffWithConflicts
}: {
  draftReviews: DraftReviewAssignment[];
  setDraftReviews: Dispatch<SetStateAction<DraftReviewAssignment[]>>;
  courseStaffWithConflicts: UserRoleWithConflictsAndName[];
}) {
  const categories: { id: string; title: string }[] = courseStaffWithConflicts?.map((staff) => {
    return { id: staff.private_profile_id, title: staff.profiles.name };
  });

  Array.from(
    draftReviews
      .reduce((map, item) => {
        map.set(item.assignee.private_profile_id, {
          id: item.assignee.private_profile_id,
          title: item.assignee.profiles.name
        });
        return map;
      }, new Map<string, { id: string; title: string }>())
      .values()
  );

  const [activeId, setActiveId] = useState<number | null>(null);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      const draggedItem = draftReviews.find((item) => item.submission.id === active.id);
      if (hasConflict(over.id, draggedItem)) {
        return false;
      }
      if (draggedItem && categories.some((cat) => cat.id === over.id)) {
        setDraftReviews(
          draftReviews.map((item) =>
            item.submission.id === active.id
              ? {
                  ...item,
                  assignee: courseStaffWithConflicts.find(
                    (staff) => staff.private_profile_id == over?.id
                  ) as DraftReviewAssignment["assignee"] // HERE
                }
              : item
          )
        );
      }
    }
  }

  function hasConflict(over_id: UniqueIdentifier, draggedItem?: DraftReviewAssignment) {
    return !!courseStaffWithConflicts
      ?.find((staff) => staff.private_profile_id === over_id)
      ?.profiles.grading_conflicts.find((conflict) => {
        return (
          conflict.student_profile_id === draggedItem?.submitter.private_profile_id ||
          draggedItem?.submission.assignment_groups?.assignment_groups_members
            .map((member) => member.profile_id)
            .includes(conflict.student_profile_id)
        );
      });
  }

  const getItemsByAssignee = (assignee_profile_id: string): DraftReviewAssignment[] => {
    return draftReviews.filter((item) => item.assignee.private_profile_id === assignee_profile_id);
  };

  const activeItem = activeId ? draftReviews.find((item) => item.submission.id === activeId) : null;

  return (
    <Container maxW="6xl" py={8}>
      <Flex gap={8}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <Flex gap={6}>
            {categories
              .sort((a, b) => {
                return a.title.localeCompare(b.title);
              })
              .map((category) => {
                const draggedItem = activeItem;
                const hasConflictForThisArea = draggedItem ? hasConflict(category.id, draggedItem) : false;

                return (
                  <Box key={category.id}>
                    <DroppableArea
                      id={category.id}
                      title={category.title}
                      items={getItemsByAssignee(category.id)}
                      hasConflict={hasConflictForThisArea}
                    >
                      {getItemsByAssignee(category.id).map((item) => (
                        <DraggableItem key={item.submission.id} item={item} />
                      ))}
                    </DroppableArea>
                  </Box>
                );
              })}
          </Flex>

          <DragOverlay>{activeItem ? <DraggableItem item={activeItem} /> : null}</DragOverlay>
        </DndContext>
      </Flex>
    </Container>
  );
}
