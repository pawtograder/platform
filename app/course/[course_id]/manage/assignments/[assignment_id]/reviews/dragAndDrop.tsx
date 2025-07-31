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
import { Box, VStack, HStack, Text, Badge, Card, Flex, SimpleGrid } from "@chakra-ui/react";
import { CSS } from "@dnd-kit/utilities";
import { DraftReviewAssignment, UserRoleWithConflictsAndName } from "./page";
import StudentInfoCard from "@/components/ui/student-info-card";

function getDraggableId(item: DraftReviewAssignment): string {
  return item.part ? `submission-${item.submission.id}-part-${item.part.id}` : `submission-${item.submission.id}`;
}

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
    id: getDraggableId(item)
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0 : 1
  };

  return (
    <Card.Root
      p={0}
      m={0}
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
      <Card.Body p={0} m={2}>
        <VStack gap={2} align="flex-start">
          <HStack gap={2} wrap="wrap">
            {item.submitters.map((submitter) => (
              <StudentInfoCard key={submitter.private_profile_id} private_profile_id={submitter.private_profile_id} />
            ))}
          </HStack>
          {item.part && (
            <Text fontSize="sm" color="text.muted">
              ({item.part.name})
            </Text>
          )}
        </VStack>
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
  console.log(draftReviews);

  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      const draggedItem = draftReviews.find((item) => getDraggableId(item) === active.id);
      if (hasConflict(over.id, draggedItem)) {
        return false;
      }
      if (draggedItem && categories.some((cat) => cat.id === over.id)) {
        setDraftReviews(
          draftReviews.map((item) =>
            getDraggableId(item) === active.id
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
        return draggedItem?.submitters.some(
          (submitter) => conflict.student_profile_id === submitter.private_profile_id
        );
      });
  }

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

  const getItemsByAssignee = (assignee_profile_id: string): DraftReviewAssignment[] => {
    return draftReviews.filter((item) => item.assignee.private_profile_id === assignee_profile_id);
  };

  const activeItem = activeId ? draftReviews.find((item) => getDraggableId(item) === activeId) : null;

  return (
    <Box>
      <Flex gap={8}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SimpleGrid columns={{ base: 1, md: 2, lg: 3, xl: 4 }} gap={6}>
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
                        <DraggableItem key={getDraggableId(item)} item={item} />
                      ))}
                    </DroppableArea>
                  </Box>
                );
              })}
          </SimpleGrid>

          <DragOverlay>{activeItem ? <DraggableItem item={activeItem} /> : null}</DragOverlay>
        </DndContext>
      </Flex>
    </Box>
  );
}
