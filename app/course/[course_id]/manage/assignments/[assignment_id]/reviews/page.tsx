"use client";

import { Container, Dialog, Field, Fieldset, Flex, HStack, Heading, Input, Text } from "@chakra-ui/react";
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
import { GradingConflictWithPopulatedProfiles } from "../../../course/grading-conflicts/gradingConflictsTable";
import { AssignmentResult, TAAssignmentSolver } from "./assignmentCalculator";
import { useCourse } from "@/hooks/useAuthState";
import DragAndDropExample from "./dragAndDrop";

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

export type DraftReviewAssignment = {
  assignee_profile_id: string;
  assignee_name: string;
  submission_id: number;
  submission_owner: UserRoleWithProfileName;
  submission_review_id: number;
};

type UserRoleWithProfileName = UserRole & { profiles: { name: string } };

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
          <FaPlus style={{ marginRight: "8px" }} /> Assign Single Review
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
  const [role, setRole] = useState<string>();
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>([]);
  const [dueDate, setDueDate] = useState<string>("");
  const { mutateAsync } = useCreate();
  const course = useCourse();

  const { data: gradingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    meta: {
      select: "*"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "review_round", operator: "ne", value: "self-review" }
    ],
    queryOptions: {
      enabled: !!course_id && !!assignment_id
    }
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

  const { data: userRolesWithProfiles } = useList<UserRoleWithProfileName>({
    resource: "user_roles",
    meta: {
      select: "*, profiles!user_roles_private_profile_id_fkey(name)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  /**
   * Submissions to do haven't been assigned for this rubric and there's no completed submission review for it either.
   */
  useEffect(() => {
    if (selectedRubric && activeSubmissions) {
      setSubmissionsToDo(
        activeSubmissions.data.filter((sub) => {
          return (
            sub.review_assignments.length === 0 &&
            !sub.submission_reviews.find((review) => {
              return review.completed_at !== null && review.rubric_id === selectedRubric.id;
            })
          );
        })
      );
    }
  }, [selectedRubric, activeSubmissions]);

  /**
   * todo:
   * - schedule assign setting => release date
   * - consider previous splitting ?
   * - error handling throughout
   * - due date
   * - better ui with more space for dragging across people
   */

  const generateReviews = () => {
    const users = courseStaff?.data.filter((staff) => {
      if (role === "graders") {
        return staff.role === "grader";
      } else if (role === "instructors") {
        return staff.role === "instructor";
      } else if (role == "instructors and graders") {
        return staff.role === "grader" || staff.role === "instructor";
      } else {
        return false;
      }
    });
    if (!users || !submissionsToDo) {
      return;
    }
    const solver = new TAAssignmentSolver(users, submissionsToDo);
    const result = solver.solve();
    toReview(result);
  };

  /**
   * Translates the result of the assignment calculator to a set of draft reviews with all the information necessary to then
   * assign the reviews.
   * @param result the result of the assignment calculator
   */
  const toReview = (result: AssignmentResult) => {
    const reviewAssignments: DraftReviewAssignment[] = [];
    result.assignments?.entries().forEach((entry) => {
      const user: UserRoleWithConflicts = entry[0];
      const assignees: SubmissionWithGrading[] = entry[1];
      assignees.forEach((assignee) => {
        const grader = userRolesWithProfiles?.data.find((item) => {
          return item.private_profile_id === user.private_profile_id;
        })?.profiles;
        const to = userRolesWithProfiles?.data.find((item) => {
          return item.private_profile_id === assignee.profile_id;
        });
        if (!to) {
          return;
        }
        reviewAssignments.push({
          assignee_profile_id: user.private_profile_id,
          assignee_name: grader?.name ?? "",
          submission_id: assignee.id,
          submission_owner: to,
          submission_review_id: assignee.submission_reviews[0].id // todo error handling if not one
        });
      });
    });
    setDraftReviews(reviewAssignments);
  };

  /**
   * Creates the review assignments based on the draft reviews.
   */
  const assign = async () => {
    if (!selectedRubric || !course_id) {
      console.log("no selected rubric or course");
      return;
    }
    const reviewAssignments: Omit<
      ReviewAssignmentRow,
      "id" | "created_at" | "max_allowable_late_tokens" | "release_date"
    >[] = [];
    for (const review of draftReviews ?? []) {
      reviewAssignments.push({
        assignee_profile_id: review.assignee_profile_id,
        submission_id: review.submission_id,
        assignment_id: Number(assignment_id),
        rubric_id: selectedRubric.id,
        class_id: Number(course_id),
        submission_review_id: review.submission_review_id,
        due_date: new Date().toISOString() // to do fix date including time zone handling
      });
    }
    await mutateAsync({
      resource: "review_assignments",
      values: reviewAssignments
    });
    clearStateData();
  };

  /**
   * Clear state data so the modal is fresh when reopened
   */
  const clearStateData = () => {
    setSelectedRubric(undefined);
    setSubmissionsToDo(undefined);
    setRole(undefined);
    setDraftReviews([]);
    setDueDate("");
  };

  return (
    <Dialog.Root size="lg" placement={"center"}>
      <Dialog.Trigger asChild>
        <Button>Open</Button>
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
                      { label: "Instructors", value: "instructors" },
                      { label: "Graders", value: "graders" },
                      { label: "Instructors and graders", value: "instructors and graders" }
                    ]}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Due Date ({course.classes.time_zone})</Field.Label>
                  <Input
                    type="datetime-local"
                    value={(() => {
                      const fieldValue = dueDate;

                      return fieldValue.toString();
                    })()}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </Field.Root>

                <Button onClick={generateReviews}>Generate Reviews</Button>
              </Fieldset.Content>
            </Fieldset.Root>
            <Flex flexDir={"column"} gap="3" padding="2">
              <DragAndDropExample
                draftReviews={draftReviews}
                setDraftReviews={setDraftReviews}
                courseStaffWithConflicts={courseStaff?.data}
              />
            </Flex>
            <Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <Button onClick={() => assign()}>Assign</Button>
              </Dialog.CloseTrigger>
            </Dialog.Footer>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
