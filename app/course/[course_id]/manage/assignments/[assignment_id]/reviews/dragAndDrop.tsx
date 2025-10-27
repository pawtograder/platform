import StudentInfoCard from "@/components/ui/student-info-card";
import {
  AccordionItem,
  AccordionItemContent,
  AccordionItemIndicator,
  AccordionItemTrigger,
  AccordionRoot,
  Badge,
  Box,
  Card,
  Flex,
  HStack,
  Separator,
  SimpleGrid,
  Text,
  VStack
} from "@chakra-ui/react";
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  UniqueIdentifier,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import React, { Dispatch, SetStateAction, useMemo, useState } from "react";
import { DraftReviewAssignment, UserRoleWithConflictsAndName } from "./page";
import { Rubric } from "@/utils/supabase/DatabaseTypes";

function getDraggableId(item: DraftReviewAssignment): string {
  return item.part ? `submission-${item.submission.id}-part-${item.part.id}` : `submission-${item.submission.id}`;
}

interface DraggableItemProps {
  item: DraftReviewAssignment;
}

interface ExistingAssignmentItemProps {
  submission: {
    id: number;
    profile_id?: string;
    assignment_groups?: {
      assignment_groups_members: { profile_id: string }[];
    } | null;
  };
  isCompleted: boolean;
  rubricPartName?: string;
}

interface DroppableAreaProps {
  id: string;
  title: string;
  items: DraftReviewAssignment[];
  children: React.ReactNode;
  hasConflict?: boolean;
  assignedCount: number;
  completedCount: number;
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
      bg={isDragging ? "bg.emphasized" : "bg.default"}
      border={isDragging ? "2px solid" : "1px solid"}
      borderColor={isDragging ? "blue.emphasized" : "border.emphasized"}
    >
      <Card.Body p={0} m={1}>
        <VStack gap={0} align="flex-start">
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

function ExistingAssignmentItem({ submission, isCompleted, rubricPartName }: ExistingAssignmentItemProps) {
  return (
    <Card.Root
      p={0}
      m={0}
      opacity={0.6}
      bg="bg.muted"
      border="1px solid"
      borderColor="border.muted"
      _hover={{ opacity: 0.8 }}
      transition="all 0.2s"
    >
      <Card.Body p={0} m={2}>
        <VStack gap={2} align="flex-start">
          <HStack gap={2} wrap="wrap">
            {submission.assignment_groups?.assignment_groups_members?.map((member: { profile_id: string }) => (
              <StudentInfoCard key={member.profile_id} private_profile_id={member.profile_id} />
            )) ??
              (submission.profile_id && <StudentInfoCard private_profile_id={submission.profile_id} />)}
          </HStack>
          {rubricPartName && (
            <Text fontSize="sm" color="text.muted">
              ({rubricPartName})
            </Text>
          )}
          <Badge size="sm" colorScheme={isCompleted ? "green" : "yellow"} variant="subtle">
            {isCompleted ? "Completed" : "In Progress"}
          </Badge>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function DroppableArea({
  id,
  title,
  items,
  children,
  hasConflict,
  assignedCount,
  completedCount
}: Omit<DroppableAreaProps, "isOver">) {
  const { isOver, setNodeRef } = useDroppable({
    id
  });

  const getBorderColor = () => {
    if (isOver) {
      return hasConflict ? "red.solid" : "green.solid";
    }
    return "border.emphasized";
  };

  const getBgColor = () => {
    if (isOver) {
      return hasConflict ? "red.subtle" : "green.subtle";
    }
    return "bg.default";
  };

  return (
    <Card.Root
      ref={setNodeRef}
      p={1}
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
        <VStack gap={2} align="stretch">
          <Flex justifyContent={"space-between"} alignItems={"center"}>
            <Text maxWidth={"90%"} textWrap={"wrap"}>
              {title}
            </Text>
            <Badge colorScheme={"blue"} variant="solid">
              {items.length}
            </Badge>
          </Flex>
          {assignedCount > 0 && (
            <Text fontSize="xs" color="text.muted">
              ({assignedCount} assigned/{completedCount} complete)
            </Text>
          )}
        </VStack>
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
  courseStaffWithConflicts,
  currentReviewAssignments,
  selectedRubric,
  allActiveSubmissions,
  groupMembersByGroupId
}: {
  draftReviews: DraftReviewAssignment[];
  setDraftReviews: Dispatch<SetStateAction<DraftReviewAssignment[]>>;
  courseStaffWithConflicts: UserRoleWithConflictsAndName[];
  currentReviewAssignments: {
    id: number;
    submission_id: number;
    rubric_id: number;
    assignee_profile_id: string;
    completed_at?: string | null;
  }[];
  selectedRubric?: Rubric;
  allActiveSubmissions: { id: number; profile_id?: string | null; assignment_group_id?: number | null }[];
  groupMembersByGroupId: Map<number, string[]>;
}) {
  const categories: { id: string; title: string }[] = courseStaffWithConflicts?.map((staff) => {
    return { id: staff.private_profile_id, title: staff.profiles.name };
  });

  const [activeId, setActiveId] = useState<string | null>(null);

  // Process existing assignments for the selected rubric
  const existingAssignmentsByAssignee = useMemo(() => {
    if (!selectedRubric) return new Map();

    const assignmentMap = new Map<
      string,
      Array<{
        submission: {
          id: number;
          profile_id?: string;
          assignment_groups?: {
            assignment_groups_members: { profile_id: string }[];
          } | null;
        };
        isCompleted: boolean;
        rubricPartName?: string;
      }>
    >();

    const relevantAssignments = currentReviewAssignments.filter((ra) => ra.rubric_id === selectedRubric.id);

    for (const assignment of relevantAssignments) {
      const submission = allActiveSubmissions.find((s) => s.id === assignment.submission_id);
      if (!submission) continue;

      // Build submission with group members for display
      const submissionWithMembers = {
        ...submission,
        profile_id: submission.profile_id || undefined,
        assignment_groups:
          submission.assignment_group_id && groupMembersByGroupId.has(submission.assignment_group_id)
            ? {
                assignment_groups_members: groupMembersByGroupId
                  .get(submission.assignment_group_id)!
                  .map((pid) => ({ profile_id: pid }))
              }
            : null
      };

      if (!assignmentMap.has(assignment.assignee_profile_id)) {
        assignmentMap.set(assignment.assignee_profile_id, []);
      }

      assignmentMap.get(assignment.assignee_profile_id)!.push({
        submission: submissionWithMembers,
        isCompleted: !!assignment.completed_at,
        rubricPartName: undefined // TODO: Add rubric part name if needed
      });
    }

    return assignmentMap;
  }, [currentReviewAssignments, selectedRubric, allActiveSubmissions, groupMembersByGroupId]);

  // Calculate workload statistics
  const getWorkloadStats = (assigneeId: string) => {
    const assignments = existingAssignmentsByAssignee.get(assigneeId) || [];
    return {
      assigned: assignments.length,
      completed: assignments.filter((a: { isCompleted: boolean }) => a.isCompleted).length
    };
  };

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
    const staff = courseStaffWithConflicts?.find((staff) => staff.private_profile_id === over_id);
    if (!staff?.profiles?.grading_conflicts) {
      return false;
    }
    return !!staff.profiles.grading_conflicts.find((conflict) => {
      return draggedItem?.submitters.some((submitter) => conflict.student_profile_id === submitter.private_profile_id);
    });
  }

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
                const workloadStats = getWorkloadStats(category.id);
                const existingAssignments = existingAssignmentsByAssignee.get(category.id) || [];

                return (
                  <Box key={category.id}>
                    <DroppableArea
                      id={category.id}
                      title={category.title}
                      items={getItemsByAssignee(category.id)}
                      hasConflict={hasConflictForThisArea}
                      assignedCount={workloadStats.assigned}
                      completedCount={workloadStats.completed}
                    >
                      {/* New draft assignments */}
                      {getItemsByAssignee(category.id).map((item) => (
                        <DraggableItem key={getDraggableId(item)} item={item} />
                      ))}

                      {/* Existing assignments in accordion */}
                      {existingAssignments.length > 0 && (
                        <>
                          {getItemsByAssignee(category.id).length > 0 && <Separator my={2} />}
                          <AccordionRoot collapsible size="sm">
                            <AccordionItem value="existing-assignments">
                              <AccordionItemTrigger>
                                <AccordionItemIndicator />
                                <Text fontSize="sm" color="text.muted">
                                  Existing Reviews ({workloadStats.completed}/{workloadStats.assigned})
                                </Text>
                              </AccordionItemTrigger>
                              <AccordionItemContent>
                                <VStack gap={2} align="stretch" mt={2}>
                                  {existingAssignments.map(
                                    (
                                      existingAssignment: {
                                        submission: {
                                          id: number;
                                          profile_id?: string;
                                          assignment_groups?: {
                                            assignment_groups_members: { profile_id: string }[];
                                          } | null;
                                        };
                                        isCompleted: boolean;
                                        rubricPartName?: string;
                                      },
                                      index: number
                                    ) => (
                                      <ExistingAssignmentItem
                                        key={`existing-${category.id}-${index}`}
                                        submission={existingAssignment.submission}
                                        isCompleted={existingAssignment.isCompleted}
                                        rubricPartName={existingAssignment.rubricPartName}
                                      />
                                    )
                                  )}
                                </VStack>
                              </AccordionItemContent>
                            </AccordionItem>
                          </AccordionRoot>
                        </>
                      )}
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
