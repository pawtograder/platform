"use client";

import { Box, Card, Checkbox, Container, Dialog, Field, Fieldset, Flex, HStack, Heading, Text } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AssignReviewModal from "./assignReviewModal";
import ReviewsTable, { PopulatedReviewAssignment } from "./ReviewsTable";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Select } from "chakra-react-select";
import { useEffect, useState } from "react";
import { Submission, SubmissionReview, UserRole } from "@/utils/supabase/DatabaseTypes";
import { LuCheck } from "react-icons/lu";
import { GradingConflictWithPopulatedProfiles } from "../../../course/grading-conflicts/gradingConflictsTable";
import { AssignmentResult, TAAssignmentSolver } from "./assignmentCalculator";

type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
export type SubmissionWithGrading = Submission & {
  submission_reviews: SubmissionReview[];
  review_assignments: ReviewAssignmentRow[];
};
export type UserRoleWithConflicts = UserRole & {
  profiles: {
    grading_conflicts: GradingConflictWithPopulatedProfiles[];
  };
};

type DraftReviewAssignment = {
  assignee_profile_id: string;
  assignee_name: string;
  submission_id: number;
  submission_owner: string;
};

// Main Page Component
export default function ReviewAssignmentsPage() {
  const { course_id, assignment_id } = useParams();
  const invalidate = useInvalidate();
  const {
    isOpen: isAssignModalOpen,
    modalData: assignModalData,
    openModal: openAssignModal,
    closeModal: closeAssignModal
  } = useModalManager<PopulatedReviewAssignment | null>();

  const handleReviewAssignmentChange = () => {
    invalidate({ resource: "review_assignments", invalidates: ["list"] });
  };

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <ReviewAssignmentBulkModal />

      <HStack justifyContent="space-between" mb={4}>
        <Heading size="lg">Manage Review Assignments</Heading>
        <Button
          onClick={() => {
            openAssignModal(null);
          }}
          variant="solid"
        >
          <FaPlus style={{ marginRight: "8px" }} /> Assign Reviews
        </Button>
      </HStack>

      <ReviewsTable
        assignmentId={assignment_id as string}
        openAssignModal={openAssignModal}
        onReviewAssignmentDeleted={handleReviewAssignmentChange}
      />
      {isAssignModalOpen && (
        <AssignReviewModal
          isOpen={isAssignModalOpen}
          onClose={closeAssignModal}
          courseId={Number(course_id)}
          assignmentId={Number(assignment_id)}
          onSuccess={() => {
            handleReviewAssignmentChange();
            closeAssignModal();
          }}
          initialData={assignModalData}
          isEditing={!!assignModalData}
        />
      )}
    </Container>
  );
}

export function ReviewAssignmentBulkModal() {
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<RubricRow>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<String>();
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>();
const {mutateAsync} = useCreate();
  const { data: gradingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    meta: {
      select: "*"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "review_round", operator: "ne", value: "self-review" }
    ]
  });

  const { data: activeSubmissions } = useList<SubmissionWithGrading>({
    resource: "submissions",
    meta: {
      select:
        "*, submission_reviews!submission_reviews_submission_id_fkey(*), review_assignments!review_assignments_submission_id_fkey(*)"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "is_active", operator: "eq", value: true },
      { field: "submission_reviews.rubric_id", operator: "eq", value: selectedRubric?.id },
      { field: "review_assignments.rubric_id", operator: "eq", value: selectedRubric?.id }
    ],
    queryOptions: {
      enabled: !!selectedRubric
    }
  });

  const { data: courseStaff } = useList<UserRoleWithConflicts>({
    resource: "user_roles",
    meta: {
      select:
        "*, profiles!user_roles_private_profile_id_fkey(grading_conflicts!grading_conflicts_grader_profile_id_fkey(*))"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "role", operator: "in", value: ["grader", "instructor"] }
    ]
  });

  const { data: i } = useList<UserRole & { profiles: { name: string } }>({
    resource: "user_roles",
    meta: {
      select: "*, profiles!user_roles_private_profile_id_fkey(name)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  useEffect(() => {
    console.log(activeSubmissions);
    if (selectedRubric && activeSubmissions) {
      console.log("setting");
      setSubmissionsToDo(
        activeSubmissions.data.filter((sub) => {
          return sub.review_assignments.length === 0;
        })
      );
    }
  }, [selectedRubric, activeSubmissions]);

  /**
   * options for assigning grading
   * - split evenly between graders OR graders and instructors OR instructors
   * - split between any of these combinations, but consider how many submissions they've already graded (for the course or for this assignment?)
   * - some way to manually reallocate the numbers -> validation to ensure the total staged to be assigned is the right number at the end of these edits
   * - should take grading conflicts into consideration
   * - option to set a deadline for when grading should be completed by -> make sure instructor can change this in case TAs are late
   *
   * - eventually, be able to reallocate one person's grading in case of an emergency
   *
   * q? how might these be affected by late submissions
   *
   * select field: assign grading to : graders, instructors, instructors and graders
   * checkbox field: consider how many submissions they've graded so far when splitting
   * generate button: splits people to be assigned to each of the graders/instructors which were selected, considering grading conflicts
   * preview: once generated, show each ta/instructor and their tentative assigned assignments to grade, along with the number of people in parentheses
   * next to their name
   * to edit -- potentially drag the students between tas? -> dnd - kit
   *
   *
   */

  const generateReviews = () => {
    const users = courseStaff?.data.filter((staff) => {
      if (role === "graders") {
        return staff.role === "grader";
      } else if (role === "instructors") {
        return staff.role === "instructor";
      } else if (role === "instructors and graders") {
        return staff.role === "grader" || staff.role === "instructor";
      } else {
        return false;
      }
    });
    if (!courseStaff || !submissionsToDo) {
      return;
    }
    const solver = new TAAssignmentSolver(courseStaff.data, submissionsToDo);
    const result = solver.solve();
    console.log(result);
    // transfer result to review assignment form
    toReview(result);
  };

  const toReview = (result: AssignmentResult) => {
    const reviewAssignments: DraftReviewAssignment[] = [];
    result.assignments?.entries().forEach((entry) => {
      const user: UserRoleWithConflicts = entry[0];
      const assignees: SubmissionWithGrading[] = entry[1];
      assignees.forEach((assignee) => {
        const grader = i?.data.find((item) => {
          return item.private_profile_id === user.private_profile_id;
        })?.profiles;
        console.log(user);
        const to = i?.data.find((item) => {
          return item.private_profile_id === assignee.profile_id;
        })?.profiles;
        reviewAssignments.push({
          assignee_profile_id: user.private_profile_id,
          assignee_name: grader?.name ?? "",
          submission_id: assignee.id,
          submission_owner: to?.name ?? ""
        });
      });
    });
    setDraftReviews(reviewAssignments);
  };

  const assign = () => {
    draftReviews?.forEach((review) => {
      mutateAsync({
        resource:"review_assignments",
        values: {
          assignee_profile_id:review.assignee_profile_id, // todo add due date
          submission_id:review.submission_id,
          assignment_id: assignment_id,
          rubric_id:selectedRubric?.id, // todo handle if null
          class_id:course_id,
          submission_review_id:1 // TODO get actual
        }
      }) // todo clear afterwards
    })
  }

  return (
    <Dialog.Root size="lg" placement={"center"}>
      <Dialog.Trigger asChild>
        <Button>Assign Grading</Button>
      </Dialog.Trigger>
      <Dialog.Positioner>
        <Dialog.Backdrop />
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Assign grading</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Fieldset.Root>
              <Fieldset.Content>
                <Field.Root>
                  <Field.Label>Choose rubric</Field.Label>
                  <Select
                    onChange={(e) => setSelectedRubric(e?.value)}
                    options={gradingRubrics?.data.map((rubric) => {
                      return { label: rubric.name, value: rubric };
                    })}
                  />
                </Field.Root>
                <Text>
                  There are {submissionsToDo?.length ?? 0} active submissions that are unassigned and ungraded for this
                  rubric on this assignment.
                </Text>
                <Field.Root>
                  <Field.Label>Select role to assign reviews to</Field.Label>
                  <Select
                    onChange={(e) => setRole(e?.value)}
                    options={[
                      { label: "Instructors", value: "instuctors" },
                      { label: "Graders", value: "graders" },
                      { label: "Instructors and graders", value: "instuctors and graders" }
                    ]}
                  />
                </Field.Root>
                <Field.Root>
                  <Flex gap="5">
                    <Checkbox.Root onCheckedChange={(e) => {}}>
                      <Checkbox.Control>
                        <LuCheck />
                      </Checkbox.Control>

                      <Checkbox.HiddenInput />
                    </Checkbox.Root>
                    <Field.Label>
                      Consider the number of submissions each person has graded already when splitting
                    </Field.Label>
                  </Flex>
                </Field.Root>
                <Button onClick={generateReviews}>Generate Reviews</Button>
              </Fieldset.Content>
            </Fieldset.Root>
            <Flex flexDir={"column"} gap="3" padding="2">
              {draftReviews?.map((review, key) => {
                return (
                  <Card.Root key={key} padding="2">
                    <Box>Grader: {review.assignee_name}</Box>
                    <Box>Submission: {review.submission_owner}</Box>
                  </Card.Root>
                );
              })}
            </Flex>
            <Dialog.Footer>
              <Button onClick={assign}>
                Assign
              </Button>
            </Dialog.Footer>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
