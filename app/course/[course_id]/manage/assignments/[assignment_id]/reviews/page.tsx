"use client";

import {
  Accordion,
  Checkbox,
  Container,
  Field,
  Fieldset,
  Flex,
  HStack,
  Heading,
  Input,
  Separator,
  Text
} from "@chakra-ui/react";
import { useCreate, useDelete, useInvalidate, useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AssignReviewModal from "./assignReviewModal";
import ReviewsTable, { PopulatedReviewAssignment } from "./ReviewsTable";
import { Select } from "chakra-react-select";
import { useCallback, useEffect, useState } from "react";
import { ReviewAssignment, Rubric, Submission, SubmissionReview, UserRole } from "@/utils/supabase/DatabaseTypes";
import { GradingConflictWithPopulatedProfiles } from "../../../course/grading-conflicts/gradingConflictsTable";
import { AssignmentResult, TAAssignmentSolver } from "./assignmentCalculator";
import { useCourse } from "@/hooks/useAuthState";
import DragAndDropExample from "./dragAndDrop";
import { TZDate } from "@date-fns/tz";
import { LuCheck } from "react-icons/lu";

export type SubmissionWithGrading = Submission & {
  submission_reviews: SubmissionReview[];
  review_assignments: ReviewAssignment[];
  assignment_groups: {
    assignment_groups_members: {
      profile_id: string;
    }[];
  } | null;
};

export type UserRoleWithConflictsAndName = UserRole & {
  profiles: {
    grading_conflicts: GradingConflictWithPopulatedProfiles[];
    name: string;
  };
};

export type DraftReviewAssignment = {
  assignee: UserRoleWithConflictsAndName;
  submitter: UserRoleWithConflictsAndName;
  submission: SubmissionWithGrading;
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
      <Separator></Separator>
      <ReviewAssignmentAccordion />

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

export function ReviewAssignmentAccordion() {
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<Rubric>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<string>();
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>([]);
  const [dueDate, setDueDate] = useState<string>("");
  const [selectedUser, setSelectedUser] = useState<UserRoleWithConflictsAndName>();
  const [currentSegment, setCurrentSegment] = useState<string>();
  const [preferGradedFewer, setPreferGradedFewer] = useState<boolean>(false);
  const [preferFewerAssigned, setPreferFewerAssigned] = useState<boolean>(false);

  const { mutateAsync } = useCreate();
  const { mutateAsync: deleteValues } = useDelete();
  const course = useCourse();
  const invalidate = useInvalidate();

  const { data: gradingRubrics } = useList<Rubric>({
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
        "*, submission_reviews!submission_reviews_submission_id_fkey(*), review_assignments!review_assignments_submission_id_fkey(*), assignment_groups!submissions_assignment_group_id_fkey(assignment_groups_members!assignment_groups_members_assignment_group_id_fkey(profile_id))"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "is_active", operator: "eq", value: true },
      { field: "submission_reviews.rubric_id", operator: "eq", value: selectedRubric?.id },
      { field: "review_assignments.rubric_id", operator: "eq", value: selectedRubric?.id }
    ],
    queryOptions: {
      enabled: !!selectedRubric && !!assignment_id && !!course_id
    },
    pagination: {
      pageSize: 1000
    }
  });

  const { data: userRoles } = useList<UserRoleWithConflictsAndName>({
    resource: "user_roles",
    meta: {
      select:
        "*, profiles!user_roles_private_profile_id_fkey(name, grading_conflicts!grading_conflicts_grader_profile_id_fkey(*))"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: {
      pageSize: 1000
    }
  });

  function shuffle<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // shuffled course staff to avoid those created first from consistently getting more assignments when
  // submissions / course_staff has a remainder
  const courseStaff = shuffle(
    userRoles?.data.filter((user) => {
      return user.role === "grader" || user.role === "instructor";
    }) ?? []
  );

  /**
   * If any of the prior fields are changed, draft reviews should be cleared.
   */
  useEffect(() => {
    setDraftReviews([]);
  }, [selectedRubric, role, selectedUser, dueDate]);

  /**
   * Populate submissions to do for assigning grading
   */
  useEffect(() => {
    if (selectedRubric && activeSubmissions && currentSegment === "assign grading") {
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
   * Populate submissions to do for reassigning grading
   */
  useEffect(() => {
    if (selectedUser && activeSubmissions && selectedRubric && currentSegment === "reassign grading") {
      const submissionsWithSelectedAssigned = activeSubmissions.data.filter(
        (sub) =>
          !!sub.review_assignments.find(
            (assign) =>
              assign.assignee_profile_id === selectedUser.private_profile_id && assign.rubric_id === selectedRubric.id
          )
      );
      const incompleteAssignments = submissionsWithSelectedAssigned.filter((sub) => {
        return !sub.submission_reviews.find((review) => {
          return review.completed_by === selectedUser.private_profile_id;
        });
      });
      setSubmissionsToDo(incompleteAssignments);
    }
  }, [selectedUser, activeSubmissions, currentSegment]);

  /**
   * Creates a list of the users who will be assigned submissions to grade based on category.
   */
  const selectedGraders = () => {
    const users =
      courseStaff?.filter((staff) => {
        if (role === "Graders") {
          return staff.role === "grader";
        } else if (role === "Instructors") {
          return staff.role === "instructor";
        } else if (role == "Instructors and graders") {
          return staff.role === "grader" || staff.role === "instructor";
        } else {
          return false;
        }
      }) ?? [];
    return users.filter((user) => user.private_profile_id !== selectedUser?.private_profile_id);
  };

  /**
   * Generates reviews based on the initial selected information and grading conflicts.
   */
  const generateReviews = () => {
    const users = selectedGraders();
    if (users.length === 0) {
      toaster.create({
        title: `Warning: No ${role}`,
        description: `Could not find any ${role} for this course to grade this assignment`
      });
      return;
    } else if (!submissionsToDo) {
      toaster.create({
        title: `Warning: No submissions`,
        description: `Could not find any submissions to grade this assignment`
      });
      return;
    }
    if (!selectedRubric?.id) {
      toaster.create({
        title: `Error: No rubric found`,
        description: `Was unable to find a rubric and therefore could not generate reviews`
      });
      return;
    }
    const historicalWorkload = new Map<string, number>();
    if (preferGradedFewer && preferFewerAssigned) {
      bothPreferences(historicalWorkload);
    } else if (preferGradedFewer) {
      preferGradedFewerCalculator(historicalWorkload);
    } else if (preferFewerAssigned) {
      preferAssignedFewerCalculator(historicalWorkload);
    }
    const solver = new TAAssignmentSolver(users, submissionsToDo, historicalWorkload);
    const result = solver.solve();
    if (result.error) {
      toaster.error({ title: "Error drafting reviews", description: result.error });
    }
    toReview(result);
  };

  /**
   * For each assignee, determines the number of relevant submissions that should be taken into account when assigning them
   * more work.  In this case, we consider submissions that they have graded with this rubric for this assignment as well as
   * outstanding reviews they have been assigned to complete but have not completed yet.
   * We only count the reviews they have not completed, as all completed review assignments will be linked to complete submission reviews
   * (already counted).  We count submission reviews instead in case someone graded a submission they were not assigned to review.
   *
   * @param historicalWorkload map to populate of assignee_private_profile_id -> number of relevant submissions
   */
  const bothPreferences = (historicalWorkload: Map<string, number>) => {
    for (const submission of activeSubmissions?.data ?? []) {
      const completedReviews = submission.submission_reviews.filter(
        (rev) => !!rev.completed_by && rev.rubric_id === selectedRubric?.id
      );
      for (const complete of completedReviews) {
        if (complete.completed_by) {
          historicalWorkload.set(complete.completed_by, (historicalWorkload.get(complete.completed_by) ?? 0) + 1);
        }
      }
      const unfinishedReviewAssignments = submission.review_assignments.filter(
        (rev) =>
          !submission.submission_reviews.find((sub) => sub.id === rev.submission_review_id)?.completed_at &&
          rev.rubric_id === selectedRubric?.id
      );
      for (const unfinished of unfinishedReviewAssignments) {
        historicalWorkload.set(
          unfinished.assignee_profile_id,
          (historicalWorkload.get(unfinished.assignee_profile_id) ?? 0) + 1
        );
      }
    }
  };

  /**
   * For each assignee, determines the number of relevant submissions that should be taken into account when assigning them
   * more work.  In this case, we consider only the submission reviews they have completed for this rubric on this assignment.
   *
   * @param historicalWorkload map to populate of assignee_private_profile_id -> number of relevant submissions
   */
  const preferGradedFewerCalculator = (historicalWorkload: Map<string, number>) => {
    for (const submission of activeSubmissions?.data ?? []) {
      const completedReviews = submission.submission_reviews.filter(
        (rev) => !!rev.completed_by && rev.rubric_id === selectedRubric?.id
      );
      for (const complete of completedReviews) {
        if (complete.completed_by) {
          historicalWorkload.set(complete.completed_by, (historicalWorkload.get(complete.completed_by) ?? 0) + 1);
        }
      }
    }
  };

  /**
   * For each assignee, determines the number of relevant submissions that should be taken into account when assigning them more work.
   * In this case, we consider only the number of review assignments they have already been tasked to complete for this rubric on this assignment.
   *
   * @param historicalWorkload map to populate of assignee_private_profile_id -> number of relevant submissions
   */
  const preferAssignedFewerCalculator = (historicalWorkload: Map<string, number>) => {
    for (const submission of activeSubmissions?.data ?? []) {
      for (const review of submission.review_assignments.filter((rev) => rev.rubric_id === selectedRubric?.id)) {
        historicalWorkload.set(
          review.assignee_profile_id,
          (historicalWorkload.get(review.assignee_profile_id) ?? 0) + 1
        );
      }
    }
  };

  /**
   * Translates the result of the assignment calculator to a set of draft reviews with all the information necessary to then
   * assign the reviews.
   * @param result the result of the assignment calculator
   */
  const toReview = useCallback(
    (result: AssignmentResult) => {
      const reviewAssignments: DraftReviewAssignment[] = [];
      result.assignments?.entries().forEach((entry) => {
        const user: UserRoleWithConflictsAndName = entry[0];
        const submissions: SubmissionWithGrading[] = entry[1];
        submissions.forEach((submission) => {
          const to = userRoles?.data.find((item) => {
            return item.private_profile_id === submission.profile_id;
          });
          if (!to) {
            toaster.error({
              title: "Error drafting reviews",
              description: `Failed to find user for submission #${submission.id}`
            });
            return;
          }
          reviewAssignments.push({
            assignee: user,
            submitter: to,
            submission: submission
          });
        });
      });
      setDraftReviews(reviewAssignments);
    },
    [userRoles, toaster]
  );

  /**
   * Creates the review assignments based on the draft reviews.
   */
  const assignReviews = async () => {
    if (!selectedRubric) {
      toaster.error({ title: "Error creating review assignments", description: "Failed to find rubric" });
      return;
    } else if (!course_id) {
      toaster.error({ title: "Error creating review assignments", description: "Failed to find current course" });
      return;
    }
    if (selectedUser) {
      clearIncompleteRolesForUser();
    }
    const reviewAssignments: Omit<
      ReviewAssignment,
      "id" | "created_at" | "max_allowable_late_tokens" | "release_date"
    >[] = [];
    for (const review of draftReviews ?? []) {
      let submissionReviewId: number;
      if (review.submission.submission_reviews.length > 0) {
        submissionReviewId = review.submission.submission_reviews[0].id;
      } else {
        const { data: rev } = await mutateAsync({
          resource: "submission_reviews",
          values: {
            total_score: 0,
            tweak: 0,
            class_id: course_id,
            submission_id: review.submission.id,
            name: selectedRubric.name,
            rubric_id: selectedRubric.id
          }
        });
        submissionReviewId = Number(rev.id);
      }
      if (isNaN(submissionReviewId)) {
        toaster.error({
          title: "Error creating review assignments",
          description: `Failed to find or create submission review for ${review.submitter.profiles.name}`
        });
        continue;
      }

      reviewAssignments.push({
        assignee_profile_id: review.assignee.private_profile_id,
        submission_id: review.submission.id,
        assignment_id: Number(assignment_id),
        rubric_id: selectedRubric.id,
        class_id: Number(course_id),
        submission_review_id: submissionReviewId,
        due_date: new TZDate(dueDate, course.classes.time_zone ?? "America/New_York").toISOString()
      });
    }
    await mutateAsync({
      resource: "review_assignments",
      values: reviewAssignments
    });
    clearStateData();
    invalidate({ resource: "review_assignments", invalidates: ["list"] });
  };

  /**
   * Clear state data so the modal is fresh when reopened
   */
  const clearStateData = useCallback(() => {
    setSelectedRubric(undefined);
    setSubmissionsToDo(undefined);
    setRole(undefined);
    setDraftReviews([]);
    setDueDate("");
    setSelectedUser(undefined);
    setPreferFewerAssigned(false);
    setPreferGradedFewer(false);
  }, []);

  const clearIncompleteRolesForUser = useCallback(async () => {
    const valuesToDelete = submissionsToDo
      ?.flatMap((submission) => submission.review_assignments)
      .filter((review) => {
        return review.assignee_profile_id === selectedUser?.private_profile_id;
      });
    for (const value of valuesToDelete ?? []) {
      await deleteValues({
        resource: "review_assignments",
        id: value.id
      });
    }
  }, [submissionsToDo, selectedUser]);

  /**
   * Fields used by both assign and reassign grading tabs
   */
  function BaseFields() {
    return (
      <>
        <Field.Root>
          <Field.Label>Choose rubric</Field.Label>
          <Select
            value={{ label: selectedRubric?.name, value: selectedRubric }}
            onChange={(e) => setSelectedRubric(e?.value)}
            options={gradingRubrics?.data.map((rubric) => {
              return { label: rubric.name, value: rubric };
            })}
          />
        </Field.Root>
        <Text fontSize={"sm"}>
          {currentSegment === "assign grading"
            ? `There are ${submissionsToDo?.length ?? 0} active submissions that are unassigned and ungraded for this rubric
          on this assignment.`
            : `There are ${submissionsToDo?.length ?? 0} active submissions assigned to ${selectedUser?.profiles.name ?? `[selected user]`} that are incomplete`}
        </Text>
        <Field.Root>
          <Field.Label>Select role to assign reviews to</Field.Label>
          <Select
            onChange={(e) => {
              if (e?.value) {
                console.log("setting role to " + e.value);
                setRole(e.value.toString());
              }
            }}
            value={{ label: role, value: role }}
            options={[
              { label: "Instructors", value: "Instructors" },
              { label: "Graders", value: "Graders" },
              { label: "Instructors and graders", value: "Instructors and graders" }
            ]}
          />
        </Field.Root>
        <Field.Root>
          <Checkbox.Root checked={preferGradedFewer} onCheckedChange={(e) => setPreferGradedFewer(!!e.checked)}>
            <Checkbox.Control>
              <Checkbox.HiddenInput />
              <LuCheck />
            </Checkbox.Control>
            <Text fontSize="sm">Prefer those who have graded fewer submissions so far</Text>
          </Checkbox.Root>
        </Field.Root>
        <Field.Root>
          <Checkbox.Root checked={preferFewerAssigned} onCheckedChange={(e) => setPreferFewerAssigned(!!e.checked)}>
            <Checkbox.Control>
              <Checkbox.HiddenInput />
              <LuCheck />
            </Checkbox.Control>
            <Text fontSize="sm">Prefer those who have fewer submissions assigned to them so far</Text>
          </Checkbox.Root>
        </Field.Root>

        <Field.Root>
          <Field.Label>Due Date ({course.classes.time_zone ?? "America/New_York"})</Field.Label>
          <Input
            type="datetime-local"
            value={
              dueDate
                ? new Date(dueDate)
                    .toLocaleString("sv-SE", {
                      timeZone: course.classes.time_zone ?? "America/New_York"
                    })
                    .replace(" ", "T")
                : ""
            }
            onChange={(e) => {
              const value = e.target.value;
              if (value) {
                // Treat inputted date as course timezone regardless of user location
                const [date, time] = value.split("T");
                const [year, month, day] = date.split("-");
                const [hour, minute] = time.split(":");

                // Create TZDate with these exact values in course timezone
                const tzDate = new TZDate(
                  parseInt(year),
                  parseInt(month) - 1,
                  parseInt(day),
                  parseInt(hour),
                  parseInt(minute),
                  0,
                  0,
                  course.classes.time_zone ?? "America/New_York"
                );
                setDueDate(tzDate.toString());
              } else {
                setDueDate("");
              }
            }}
          />
        </Field.Root>
        <Button
          onClick={generateReviews}
          variant="subtle"
          disabled={!dueDate || !selectedRubric || !role || submissionsToDo?.length === 0}
          marginBottom={"2"}
        >
          Generate Reviews
        </Button>
        {draftReviews.length > 0 && (
          <Flex flexDir={"column"} gap="3" padding="2">
            <DragAndDropExample
              draftReviews={draftReviews}
              setDraftReviews={setDraftReviews}
              courseStaffWithConflicts={selectedGraders() ?? []}
            />
            <Button variant="subtle" onClick={() => assignReviews()} float={"right"}>
              Assign
            </Button>
          </Flex>
        )}
      </>
    );
  }

  return (
    <>
      <Accordion.Root
        collapsible
        marginBottom={"2"}
        onValueChange={(e) => {
          clearStateData();
          if (e.value.length > 0) {
            setCurrentSegment(e.value[0]);
          }
        }}
      >
        <Accordion.Item key={1} value={"assign grading"}>
          <Accordion.ItemTrigger>
            <Heading size="md">Assign grading</Heading>
            <Accordion.ItemIndicator />
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Fieldset.Root>
              <Fieldset.Content>
                <BaseFields />
              </Fieldset.Content>
            </Fieldset.Root>
          </Accordion.ItemContent>
        </Accordion.Item>
        <Accordion.Item key={2} value={"reassign grading"}>
          <Accordion.ItemTrigger>
            <Heading size="md">Reassign grading</Heading>
            <Accordion.ItemIndicator />
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Fieldset.Root>
              <Fieldset.Content>
                <Field.Root>
                  <Field.Label>Select grader whose remaining work you want to reassign</Field.Label>
                  <Select
                    value={{ label: selectedUser?.profiles.name, value: selectedUser }}
                    onChange={(e) => {
                      setSelectedUser(e?.value);
                    }}
                    options={courseStaff?.map((staff) => {
                      return { label: staff.profiles.name, value: staff };
                    })}
                  />
                </Field.Root>
                <BaseFields />
              </Fieldset.Content>
            </Fieldset.Root>
          </Accordion.ItemContent>
        </Accordion.Item>
      </Accordion.Root>
    </>
  );
}
