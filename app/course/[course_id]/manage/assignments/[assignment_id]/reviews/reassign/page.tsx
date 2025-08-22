"use client";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import TagDisplay from "@/components/ui/tag";
import { toaster } from "@/components/ui/toaster";
import useTags from "@/hooks/useTags";
import { RubricPart, Tag, Assignment } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Container,
  Field,
  Fieldset,
  Flex,
  Heading,
  HStack,
  Input,
  Separator,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useCreate, useDelete, useInvalidate, useList } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { MultiValue, Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import { AssignmentResult, TAAssignmentSolver } from "../assignmentCalculator";
import DragAndDropExample from "../dragAndDrop";
import { DraftReviewAssignment, RubricWithParts, SubmissionWithGrading, UserRoleWithConflictsAndName } from "../page";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import type { GradingConflictWithPopulatedProfiles } from "../../../../course/grading-conflicts/gradingConflictsTable";
import * as Sentry from "@sentry/nextjs";

type ReviewAssignmentForRef = {
  assignee_profile_id: string;
  submission_id: number;
  rubric_id?: number;
  submissions?: {
    profile_id?: string;
    assignment_groups?: {
      assignment_groups_members?: Array<{ profile_id: string }>;
    };
  };
};

// Main Page Component
export default function ReassignGradingPage() {
  const { course_id, assignment_id } = useParams();
  const invalidate = useInvalidate();

  const handleReviewAssignmentChange = () => {
    invalidate({ resource: "review_assignments", invalidates: ["list"] });
    invalidate({ resource: "submissions", invalidates: ["list"] });
  };

  return (
    <Container maxW="container.xl" py={4}>
      <HStack justifyContent="space-between" mb={4}>
        <HStack gap={2}>
          <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews`}>
            <FaArrowLeft style={{ marginRight: "8px" }} /> Back to Reviews
          </Link>
          <Heading size="lg">Reassign Grading by Grader</Heading>
        </HStack>
      </HStack>
      <Separator mb={4} />

      <ReassignGradingForm handleReviewAssignmentChange={handleReviewAssignmentChange} />
    </Container>
  );
}

function ReassignGradingForm({ handleReviewAssignmentChange }: { handleReviewAssignmentChange: () => void }) {
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<RubricWithParts>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<string>("Graders");
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>([]);
  const [dueDate, setDueDate] = useState<string>("");
  const [selectedUser, setSelectedUser] = useState<UserRoleWithConflictsAndName>();
  const [baseOnAll, setBaseOnAll] = useState<boolean>(false);
  const [selectedTags, setSelectedTags] = useState<
    MultiValue<{
      label: string;
      value: Tag;
    }>
  >([]);
  const [assignmentMode, setAssignmentMode] = useState<"by_submission" | "by_rubric_part" | "by_filtered_parts">(
    "by_submission"
  );
  const [selectedRubricPartsForFilter, setSelectedRubricPartsForFilter] = useState<
    MultiValue<{
      label: string;
      value: RubricPart;
    }>
  >([]);
  const [selectedUsers, setSelectedUsers] = useState<
    MultiValue<{
      label: string;
      value: UserRoleWithConflictsAndName;
    }>
  >([]);
  const [originalRubricParts, setOriginalRubricParts] = useState<Map<number, RubricPart[]>>(new Map());
  const [selectedReferenceAssignment, setSelectedReferenceAssignment] = useState<Assignment>();
  const [selectedReferenceRubric, setSelectedReferenceRubric] = useState<RubricWithParts>();
  const [selectedExclusionAssignment, setSelectedExclusionAssignment] = useState<Assignment>();
  const [selectedExclusionRubric, setSelectedExclusionRubric] = useState<RubricWithParts>();
  const [isGeneratingReviews, setIsGeneratingReviews] = useState(false);

  const { mutateAsync } = useCreate();
  const { mutateAsync: deleteValues } = useDelete();
  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const { tags } = useTags();
  const supabase = createClient();

  // Fetch all assignments for reference/exclusion selection
  const { data: allAssignments } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    queryOptions: {
      enabled: !!course_id
    },
    pagination: {
      pageSize: 1000
    }
  });

  const { data: gradingRubrics } = useList<RubricWithParts>({
    resource: "rubrics",
    meta: {
      select: "*, rubric_parts!rubric_parts_rubric_id_fkey(*)"
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
        "*, submission_reviews!submission_reviews_submission_id_fkey(*), review_assignments!review_assignments_submission_id_fkey(*, review_assignment_rubric_parts!review_assignment_rubric_parts_review_assignment_id_fkey(*)), assignment_groups!submissions_assignment_group_id_fkey(assignment_groups_members!assignment_groups_members_assignment_group_id_fkey(profile_id))"
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

  // Fetch review assignments from reference assignment to understand previous grader assignments
  const { data: referenceReviewAssignments } = useList<ReviewAssignmentForRef>({
    resource: "review_assignments",
    meta: {
      select:
        "assignee_profile_id, submission_id, rubric_id, submissions!review_assignments_submission_id_fkey(profile_id, assignment_groups!submissions_assignment_group_id_fkey(assignment_groups_members!assignment_groups_members_assignment_group_id_fkey(profile_id)))"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: selectedReferenceAssignment?.id },
      { field: "class_id", operator: "eq", value: course_id }
    ],
    queryOptions: {
      enabled: !!selectedReferenceAssignment && !!course_id
    },
    pagination: {
      pageSize: 1000
    }
  });

  const { data: referenceRubrics } = useList<RubricWithParts>({
    resource: "rubrics",
    meta: {
      select: "*, rubric_parts!rubric_parts_rubric_id_fkey(*)"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: selectedReferenceAssignment?.id },
      { field: "class_id", operator: "eq", value: course_id }
    ],
    queryOptions: {
      enabled: !!selectedReferenceAssignment && !!course_id
    }
  });

  const { data: exclusionRubrics } = useList<RubricWithParts>({
    resource: "rubrics",
    meta: {
      select: "*, rubric_parts!rubric_parts_rubric_id_fkey(*)"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: selectedExclusionAssignment?.id },
      { field: "class_id", operator: "eq", value: course_id }
    ],
    queryOptions: {
      enabled: !!selectedExclusionAssignment && !!course_id
    }
  });

  // For exclusions, we also need the review assignments
  const { data: exclusionReviewAssignments } = useList<ReviewAssignmentForRef>({
    resource: "review_assignments",
    meta: {
      select:
        "assignee_profile_id, submission_id, rubric_id, submissions!review_assignments_submission_id_fkey(profile_id, assignment_groups!submissions_assignment_group_id_fkey(assignment_groups_members!assignment_groups_members_assignment_group_id_fkey(profile_id)))"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: selectedExclusionAssignment?.id },
      { field: "class_id", operator: "eq", value: course_id },
      { field: "rubric_id", operator: "eq", value: selectedExclusionRubric?.id }
    ],
    queryOptions: {
      enabled: !!selectedExclusionAssignment && !!selectedExclusionRubric && !!course_id
    },
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
  }, [
    selectedRubric,
    role,
    selectedUser,
    dueDate,
    assignmentMode,
    selectedRubricPartsForFilter,
    selectedUsers,
    originalRubricParts,
    selectedReferenceAssignment,
    selectedReferenceRubric,
    selectedExclusionAssignment,
    selectedExclusionRubric
  ]);

  /**
   * Populate submissions to do for reassigning grading
   */
  useEffect(() => {
    if (selectedUser && activeSubmissions && selectedRubric) {
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

      // Capture original rubric parts for each submission before clearing assignments
      const rubricPartsMap = new Map<number, RubricPart[]>();
      incompleteAssignments.forEach((submission) => {
        const userAssignment = submission.review_assignments.find(
          (assign) =>
            assign.assignee_profile_id === selectedUser.private_profile_id && assign.rubric_id === selectedRubric.id
        );
        if (userAssignment && selectedRubric) {
          const assignedParts = userAssignment.review_assignment_rubric_parts
            .map((part) => {
              return selectedRubric.rubric_parts.find((rubricPart) => rubricPart.id === part.rubric_part_id);
            })
            .filter((part): part is RubricPart => part !== undefined);

          rubricPartsMap.set(submission.id, assignedParts);
        }
      });
      setOriginalRubricParts(rubricPartsMap);
    }
  }, [selectedUser, activeSubmissions, selectedRubric]);

  /**
   * Creates a preference map from the reference assignment: student profile ID -> preferred grader profile ID
   */
  const buildGraderPreferenceMap = useCallback(() => {
    const preferenceMap = new Map<string, string>();

    if (!selectedReferenceAssignment || !referenceReviewAssignments?.data) {
      return preferenceMap;
    }

    referenceReviewAssignments.data.forEach((reviewAssignment: ReviewAssignmentForRef) => {
      // Filter by selected rubric if one is chosen
      if (selectedReferenceRubric && reviewAssignment.rubric_id !== selectedReferenceRubric.id) {
        return;
      }

      const submission = reviewAssignment.submissions;
      if (submission) {
        // Handle individual submissions
        if (submission.profile_id) {
          preferenceMap.set(submission.profile_id, reviewAssignment.assignee_profile_id);
        }

        // Handle group submissions
        if (submission.assignment_groups?.assignment_groups_members) {
          submission.assignment_groups.assignment_groups_members.forEach((member: { profile_id: string }) => {
            preferenceMap.set(member.profile_id, reviewAssignment.assignee_profile_id);
          });
        }
      }
    });

    return preferenceMap;
  }, [selectedReferenceAssignment, selectedReferenceRubric, referenceReviewAssignments]);

  const buildGraderExclusionMap = useCallback(() => {
    const exclusionMap = new Map<string, Set<string>>(); // student -> Set of graders to exclude

    if (!selectedExclusionAssignment || !selectedExclusionRubric || !exclusionReviewAssignments?.data) {
      return exclusionMap;
    }

    exclusionReviewAssignments.data.forEach((reviewAssignment: ReviewAssignmentForRef) => {
      const submission = reviewAssignment.submissions;
      if (submission) {
        // Helper function to add exclusion
        const addExclusion = (studentId: string, graderId: string) => {
          if (!exclusionMap.has(studentId)) {
            exclusionMap.set(studentId, new Set<string>());
          }
          exclusionMap.get(studentId)!.add(graderId);
        };

        // Handle individual submissions
        if (submission.profile_id) {
          addExclusion(submission.profile_id, reviewAssignment.assignee_profile_id);
        }

        // Handle group submissions
        if (submission.assignment_groups?.assignment_groups_members) {
          submission.assignment_groups.assignment_groups_members.forEach((member: { profile_id: string }) => {
            addExclusion(member.profile_id, reviewAssignment.assignee_profile_id);
          });
        }
      }
    });

    return exclusionMap;
  }, [selectedExclusionAssignment, selectedExclusionRubric, exclusionReviewAssignments]);

  /**
   * Creates a list of the users who will be assigned submissions to grade based on category.
   */
  const selectedGraders = useCallback(() => {
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
    if (selectedTags.length === 0) {
      return users.filter((user) => user.private_profile_id !== selectedUser?.private_profile_id);
    }
    const matchingProfileIds = new Set(
      tags
        .filter((tag) =>
          selectedTags.some(
            (selectedTag) => selectedTag.value.color === tag.color && selectedTag.value.name === tag.name
          )
        )
        .map((tag) => tag.profile_id)
    );
    return users.filter(
      (user) =>
        user.private_profile_id !== selectedUser?.private_profile_id && matchingProfileIds.has(user.private_profile_id)
    );
  }, [courseStaff, role, selectedUser, selectedTags, tags]);

  /**
   * Gets the final list of users after applying role, tag, and user selection filters
   */
  const finalSelectedUsers = useCallback(() => {
    const baseUsers = selectedGraders();

    // If no specific users are selected, return all users from role/tag filtering
    if (selectedUsers.length === 0) {
      return baseUsers;
    }

    // Return only the specifically selected users
    return selectedUsers.map((option) => option.value);
  }, [selectedGraders, selectedUsers]);

  /**
   * Auto-populate selectedUsers when the available users change based on role/tag filters
   */
  useEffect(() => {
    const availableUsers = selectedGraders();
    const userOptions = availableUsers.map((user) => ({
      label: user.profiles.name,
      value: user
    }));

    // If no users are currently selected, or if some selected users are no longer available,
    // reset to include all available users
    if (
      selectedUsers.length === 0 ||
      selectedUsers.some(
        (selected) => !availableUsers.find((user) => user.private_profile_id === selected.value.private_profile_id)
      )
    ) {
      setSelectedUsers(userOptions);
    }
  }, [selectedGraders, selectedUsers]);

  /**
   * Generates reviews based on the initial selected information and grading conflicts.
   */
  const generateReviews = () => {
    const users = finalSelectedUsers();
    if (users.length === 0) {
      toaster.create({
        title: `Warning: No ${role}`,
        description: `Could not find any ${role.toLowerCase()} for this course to grade this assignment`
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

    setIsGeneratingReviews(true);
    try {
      const historicalWorkload = new Map<string, number>();
      const graderPreferences = buildGraderPreferenceMap();
      const graderExclusions = buildGraderExclusionMap();

      if (baseOnAll) {
        baseOnAllCalculator(historicalWorkload);
      }

      // Show feedback about preferences and exclusions
      if (graderPreferences.size > 0) {
        const rubricInfo = selectedReferenceRubric ? ` (${selectedReferenceRubric.name} rubric)` : "";
        toaster.create({
          title: "Grader Preferences Applied",
          description: `Using grader preferences from ${selectedReferenceAssignment?.title}${rubricInfo} for ${graderPreferences.size} students.`,
          type: "info"
        });
      }

      if (graderExclusions.size > 0) {
        const totalExclusions = Array.from(graderExclusions.values()).reduce((sum, set) => sum + set.size, 0);
        const rubricInfo = selectedExclusionRubric ? ` (${selectedExclusionRubric.name} rubric)` : "";
        toaster.create({
          title: "Grader Exclusions Applied",
          description: `Excluding ${totalExclusions} grader-student pairs from ${selectedExclusionAssignment?.title}${rubricInfo}.`,
          type: "info"
        });
      }

      // Filter users to create temporary conflicts based on exclusions
      const usersWithExclusions = users.map((user) => {
        const conflicts: GradingConflictWithPopulatedProfiles[] = Array.isArray(user.profiles.grading_conflicts)
          ? [...user.profiles.grading_conflicts]
          : [];

        // For each student in the exclusion map, check if this grader should be excluded
        graderExclusions.forEach((excludedGraders, studentId) => {
          if (excludedGraders.has(user.private_profile_id)) {
            const tempConflict: GradingConflictWithPopulatedProfiles = {
              id: -1,
              grader_profile_id: user.private_profile_id,
              student_profile_id: studentId,
              class_id: Number(course_id),
              created_at: new Date().toISOString(),
              created_by_profile_id: user.private_profile_id,
              reason: `Excluded based on ${selectedExclusionAssignment?.title} - ${selectedExclusionRubric?.name}`
            };
            conflicts.push(tempConflict);
          }
        });

        return {
          ...user,
          profiles: {
            ...user.profiles,
            grading_conflicts: conflicts
          }
        } as UserRoleWithConflictsAndName;
      });

      if (assignmentMode === "by_rubric_part") {
        const reviewAssignments = generateReviewsByRubricPart(
          usersWithExclusions,
          submissionsToDo,
          historicalWorkload,
          graderPreferences
        );
        setDraftReviews(reviewAssignments);
      } else if (assignmentMode === "by_filtered_parts") {
        const reviewAssignments = generateReviewsByFilteredParts(
          usersWithExclusions,
          submissionsToDo,
          historicalWorkload,
          graderPreferences
        );
        setDraftReviews(reviewAssignments);
      } else {
        // For "by_submission" mode, preserve the original rubric parts that were assigned
        const reviewAssignments = generateReviewsByRubric(
          usersWithExclusions,
          submissionsToDo,
          historicalWorkload,
          graderPreferences
        );
        setDraftReviews(reviewAssignments);
      }
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({
        title: "Error drafting reviews",
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      setIsGeneratingReviews(false);
    }
  };

  const generateReviewsByRubric = (
    users: UserRoleWithConflictsAndName[],
    submissionsToDo: SubmissionWithGrading[],
    historicalWorkload: Map<string, number>,
    graderPreferences?: Map<string, string>
  ) => {
    const result = new TAAssignmentSolver(users, submissionsToDo, historicalWorkload, graderPreferences, 1).solve();
    if (result.error) {
      toaster.error({ title: "Error drafting reviews", description: result.error });
    }
    return toReviewWithOriginalParts(result);
  };

  const generateReviewsByRubricPart = (
    users: UserRoleWithConflictsAndName[],
    submissionsToDo: SubmissionWithGrading[],
    historicalWorkload: Map<string, number>,
    graderPreferences?: Map<string, string>
  ) => {
    if (!selectedRubric?.rubric_parts.length || selectedRubric?.rubric_parts.length === 0) {
      toaster.error({
        title: "Error drafting reviews",
        description: "Unable to create assignments by part because rubric has no parts"
      });
      return [];
    }
    const groups = splitIntoGroups(users, selectedRubric?.rubric_parts.length);
    const returnResult = [];
    for (let x = 0; x < groups.length; x += 1) {
      const result = new TAAssignmentSolver(
        groups[x],
        submissionsToDo,
        historicalWorkload,
        graderPreferences,
        1
      ).solve();
      if (result.error) {
        toaster.error({ title: "Error drafting reviews", description: result.error });
      }
      returnResult.push(toReview(result, selectedRubric?.rubric_parts[x]));
    }
    return returnResult.reduce((prev, cur) => {
      return prev.concat(cur);
    }, [] as DraftReviewAssignment[]);
  };

  const generateReviewsByFilteredParts = (
    users: UserRoleWithConflictsAndName[],
    submissionsToDo: SubmissionWithGrading[],
    historicalWorkload: Map<string, number>,
    graderPreferences?: Map<string, string>
  ) => {
    if (selectedRubricPartsForFilter.length === 0) {
      toaster.error({
        title: "Error drafting reviews",
        description: "Please select at least one rubric part to filter by"
      });
      return [];
    }

    if (!selectedRubric?.rubric_parts.length || selectedRubric?.rubric_parts.length === 0) {
      toaster.error({
        title: "Error drafting reviews",
        description: "Unable to create assignments by part because rubric has no parts"
      });
      return [];
    }

    // Get the selected rubric parts
    const selectedParts = selectedRubricPartsForFilter.map((option) => option.value);

    // Split selected rubric parts across graders
    const groups = splitIntoGroups(users, selectedParts.length);
    const returnResult = [];

    for (let x = 0; x < groups.length && x < selectedParts.length; x += 1) {
      const result = new TAAssignmentSolver(
        groups[x],
        submissionsToDo,
        historicalWorkload,
        graderPreferences,
        1
      ).solve();
      if (result.error) {
        toaster.error({ title: "Error drafting reviews", description: result.error });
      }
      returnResult.push(toReview(result, selectedParts[x]));
    }

    return returnResult.reduce((prev, cur) => {
      return prev.concat(cur);
    }, [] as DraftReviewAssignment[]);
  };

  function splitIntoGroups<T>(arr: T[], numGroups: number) {
    if (numGroups <= 0 || arr.length === 0) return [];
    if (numGroups >= arr.length) return arr.map((item) => [item]);

    const baseSize = Math.floor(arr.length / numGroups);
    const remainder = arr.length % numGroups;

    return Array.from({ length: numGroups }, (_, i) => {
      const start = i * baseSize + Math.min(i, remainder);
      const size = baseSize + (i < remainder ? 1 : 0);
      return arr.slice(start, start + size);
    });
  }

  /**
   * For each assignee, determines the number of relevant submissions that should be taken into account when assigning them more work.
   * In this case, we consider only the number of review assignments they have already been tasked to complete for this rubric on this assignment.
   *
   * @param historicalWorkload map to populate of assignee_private_profile_id -> number of relevant submissions
   */
  const baseOnAllCalculator = useCallback(
    (historicalWorkload: Map<string, number>) => {
      for (const submission of activeSubmissions?.data ?? []) {
        for (const review of submission.review_assignments.filter((rev) => rev.rubric_id === selectedRubric?.id)) {
          historicalWorkload.set(
            review.assignee_profile_id,
            (historicalWorkload.get(review.assignee_profile_id) ?? 0) + 1
          );
        }
      }
    },
    [activeSubmissions, selectedRubric]
  );

  /**
   * Translates the result of the assignment calculator to a set of draft reviews with all the information necessary to then
   * assign the reviews, using original rubric parts when available.
   * @param result the result of the assignment calculator
   */
  const toReviewWithOriginalParts = useCallback(
    (result: AssignmentResult) => {
      const reviewAssignments: DraftReviewAssignment[] = [];
      result.assignments?.entries().forEach((entry) => {
        const user: UserRoleWithConflictsAndName = entry[0];
        const submissions: SubmissionWithGrading[] = entry[1];
        submissions.forEach((submission) => {
          // Get all group members or just the single submitter
          const groupMembers = submission.assignment_groups?.assignment_groups_members || [
            { profile_id: submission.profile_id }
          ];

          // Find UserRoleWithConflictsAndName for each group member
          const submitters: UserRoleWithConflictsAndName[] = [];
          for (const member of groupMembers) {
            const memberUserRole = userRoles?.data.find((item) => {
              return item.private_profile_id === member.profile_id;
            });
            if (!memberUserRole) {
              toaster.error({
                title: "Error drafting reviews",
                description: `Failed to find user for group member with profile ID ${member.profile_id} in submission #${submission.id}`
              });
              return;
            }
            submitters.push(memberUserRole);
          }

          if (submitters.length === 0) {
            toaster.error({
              title: "Error drafting reviews",
              description: `No valid submitters found for submission #${submission.id}`
            });
            return;
          }

          // Get the original rubric parts for this submission
          const originalParts = originalRubricParts.get(submission.id) || [];

          if (originalParts.length > 0) {
            // Create separate assignments for each original rubric part
            originalParts.forEach((part) => {
              reviewAssignments.push({
                assignee: user,
                submitters: submitters,
                submission: submission,
                part: part
              });
            });
          } else {
            // No specific parts were originally assigned, create assignment without parts
            reviewAssignments.push({
              assignee: user,
              submitters: submitters,
              submission: submission,
              part: undefined
            });
          }
        });
      });
      return reviewAssignments;
    },
    [userRoles, originalRubricParts]
  );

  /**
   * Translates the result of the assignment calculator to a set of draft reviews with all the information necessary to then
   * assign the reviews.
   * @param result the result of the assignment calculator
   */
  const toReview = useCallback(
    (result: AssignmentResult, part?: RubricPart) => {
      const reviewAssignments: DraftReviewAssignment[] = [];
      result.assignments?.entries().forEach((entry) => {
        const user: UserRoleWithConflictsAndName = entry[0];
        const submissions: SubmissionWithGrading[] = entry[1];
        submissions.forEach((submission) => {
          // Get all group members or just the single submitter
          const groupMembers = submission.assignment_groups?.assignment_groups_members || [
            { profile_id: submission.profile_id }
          ];

          // Find UserRoleWithConflictsAndName for each group member
          const submitters: UserRoleWithConflictsAndName[] = [];
          for (const member of groupMembers) {
            const memberUserRole = userRoles?.data.find((item) => {
              return item.private_profile_id === member.profile_id;
            });
            if (!memberUserRole) {
              toaster.error({
                title: "Error drafting reviews",
                description: `Failed to find user for group member with profile ID ${member.profile_id} in submission #${submission.id}`
              });
              return;
            }
            submitters.push(memberUserRole);
          }

          if (submitters.length === 0) {
            toaster.error({
              title: "Error drafting reviews",
              description: `No valid submitters found for submission #${submission.id}`
            });
            return;
          }

          reviewAssignments.push({
            assignee: user,
            submitters: submitters,
            submission: submission,
            part: part
          });
        });
      });
      return reviewAssignments;
    },
    [userRoles]
  );

  /**
   * Creates the review assignments based on the draft reviews.
   */
  const assignReviews = async () => {
    if (!selectedRubric) {
      toaster.error({ title: "Error creating review assignments", description: "Failed to find rubric" });
      return false;
    } else if (!course_id) {
      toaster.error({ title: "Error creating review assignments", description: "Failed to find current course" });
      return false;
    }

    await clearIncompleteAssignmentsForUser();

    const submissionReviewPromises = (draftReviews ?? []).map(async (review) => ({
      review,
      submissionReviewId: await submissionReviewIdForReview(review)
    }));

    const reviewsWithSubmissionIds = await Promise.all(submissionReviewPromises);

    const validReviews = reviewsWithSubmissionIds.filter(({ submissionReviewId }) => submissionReviewId);

    if (validReviews.length === 0) {
      toaster.error({ title: "Error", description: "No valid reviews to assign" });
      return false;
    }

    const { data: existingAssignments, error: existingAssignmentsError } = await supabase
      .from("review_assignments")
      .select(
        "id, completed_at, review_assignment_rubric_parts(id, rubric_part_id), assignee_profile_id, submission_review_id"
      )
      .eq("assignment_id", Number(assignment_id))
      .eq("rubric_id", selectedRubric.id);

    if (existingAssignmentsError) {
      toaster.error({ title: "Error", description: "Error fetching existing review assignments" });
      return false;
    }

    const assignmentsToUpdate = existingAssignments
      .filter((assignment) => {
        return validReviews.find(
          ({ review, submissionReviewId }) =>
            assignment.assignee_profile_id === review.assignee.private_profile_id &&
            assignment.submission_review_id === submissionReviewId
        );
      })
      .map((assignment) => assignment.id);
    await supabase
      .from("review_assignments")
      .update({
        completed_at: null
      })
      .in("id", assignmentsToUpdate);

    const assignmentsToCreate = validReviews
      .filter(({ review, submissionReviewId }) => {
        return !existingAssignments.find(
          (assignment) =>
            assignment.assignee_profile_id === review.assignee.private_profile_id &&
            assignment.submission_review_id === submissionReviewId
        );
      })
      .map(({ review, submissionReviewId }) => ({
        assignee_profile_id: review.assignee.private_profile_id,
        submission_id: review.submission.id,
        assignment_id: Number(assignment_id),
        rubric_id: selectedRubric.id,
        class_id: Number(course_id),
        submission_review_id: submissionReviewId,
        due_date: new TZDate(dueDate, course.time_zone ?? "America/New_York").toISOString()
      }));
    await supabase.from("review_assignments").insert(assignmentsToCreate);

    const { data: allReviewAssignments, error: allReviewAssignmentsError } = await supabase
      .from("review_assignments")
      .select(
        "id, completed_at, review_assignment_rubric_parts(id, rubric_part_id), assignee_profile_id, submission_review_id"
      )
      .eq("assignment_id", Number(assignment_id))
      .eq("rubric_id", selectedRubric.id);

    if (allReviewAssignmentsError) {
      toaster.error({ title: "Error", description: "Error fetching all review assignments" });
      return false;
    }
    //Now insert all the review assignment parts as needed
    const reviewAssignmentPartsToCreate = validReviews
      .map(({ review, submissionReviewId }) => {
        if (review.part) {
          const assignment = allReviewAssignments.find(
            (assignment) =>
              assignment.assignee_profile_id === review.assignee.private_profile_id &&
              assignment.submission_review_id === submissionReviewId
          );
          if (!assignment || !assignment.id) {
            toaster.error({ title: "Error", description: "Error finding review assignment for review" });
            return undefined;
          }
          return {
            review_assignment_id: assignment.id,
            rubric_part_id: review.part.id,
            class_id: Number(course_id)
          };
        } else {
          return undefined;
        }
      })
      .filter((part) => part !== undefined);
    await supabase.from("review_assignment_rubric_parts").insert(reviewAssignmentPartsToCreate);

    toaster.success({
      title: "Reviews Reassigned",
      description: `Successfully reassigned ${validReviews.length} review assignments`
    });

    handleReviewAssignmentChange();
    clearStateData();
  };

  /**
   * Searches for the submission review id for this review assignment. If none found, creates a new submission
   * review to use.
   * @param review draft assignment to search
   * @returns submission review id for review assignment creation
   */
  const submissionReviewIdForReview = useCallback(
    async (review: DraftReviewAssignment) => {
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
            name: selectedRubric?.name,
            rubric_id: selectedRubric?.id
          }
        });
        submissionReviewId = Number(rev.id);
      }
      if (isNaN(submissionReviewId)) {
        toaster.error({
          title: "Error creating review assignments",
          description: `Failed to find or create submission review for ${review.submitters.map((s) => s.profiles.name).join(", ")}`
        });
      }
      return submissionReviewId;
    },
    [selectedRubric, course_id, mutateAsync]
  );

  const uniqueTags: Tag[] = Array.from(
    tags
      .reduce((map, tag) => {
        if (!map.has(tag.name + tag.color + tag.visible)) {
          map.set(tag.name + tag.color + tag.visible, tag);
        }
        return map;
      }, new Map())
      .values()
  );

  /**
   * Clear state data
   */
  const clearStateData = useCallback(() => {
    setSelectedRubric(undefined);
    setSubmissionsToDo(undefined);
    setRole("Graders");
    setDraftReviews([]);
    setDueDate("");
    setSelectedUser(undefined);
    setBaseOnAll(false);
    setAssignmentMode("by_submission");
    setSelectedRubricPartsForFilter([]);
    setSelectedTags([]);
    setSelectedUsers([]);
    setOriginalRubricParts(new Map());
    setSelectedReferenceAssignment(undefined);
    setSelectedReferenceRubric(undefined);
    setSelectedExclusionAssignment(undefined);
    setSelectedExclusionRubric(undefined);
  }, []);

  /**
   * Deletes all of the review-assignments for the selected user that are incomplete for this
   * rubric and assignment. Used when review assignments are being reassigned.
   */
  const clearIncompleteAssignmentsForUser = useCallback(async () => {
    const valuesToDelete = submissionsToDo
      ?.flatMap((submission) => submission.review_assignments)
      .filter((review) => {
        return review.assignee_profile_id === selectedUser?.private_profile_id;
      });
    const deletePromises = (valuesToDelete ?? []).map(
      async (value) =>
        await deleteValues({
          resource: "review_assignments",
          id: value.id
        })
    );
    return Promise.all(deletePromises);
  }, [submissionsToDo, selectedUser, deleteValues]);

  return (
    <VStack align="stretch" w="100%">
      <Fieldset.Root maxW={"lg"}>
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

          <VStack align="flex-start" maxW={"lg"} gap={0}>
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
            <Field.Root>
              <Field.Label>Assignment method</Field.Label>
              <Select
                value={{
                  label:
                    assignmentMode === "by_submission"
                      ? "Assign by submission"
                      : assignmentMode === "by_rubric_part"
                        ? "Assign by rubric part"
                        : "Filter by rubric parts",
                  value: assignmentMode
                }}
                onChange={(e) => {
                  if (e?.value) {
                    setAssignmentMode(e.value as "by_submission" | "by_rubric_part" | "by_filtered_parts");
                  }
                }}
                options={[
                  { label: "Assign by submission", value: "by_submission" },
                  { label: "Assign by rubric part", value: "by_rubric_part" },
                  { label: "Filter by rubric parts", value: "by_filtered_parts" }
                ]}
              />
              <Field.HelperText>
                {assignmentMode === "by_submission" &&
                  "Each grader will be assigned the same rubric parts that were originally assigned to the selected grader"}
                {assignmentMode === "by_rubric_part" && "Split rubric parts across graders evenly"}
                {assignmentMode === "by_filtered_parts" && "Select specific rubric parts to split across graders"}
              </Field.HelperText>
            </Field.Root>
            {assignmentMode === "by_filtered_parts" && (
              <Field.Root>
                <Field.Label>Select rubric parts to assign</Field.Label>
                <Select
                  isMulti={true}
                  onChange={(e) => {
                    setSelectedRubricPartsForFilter(e);
                  }}
                  value={selectedRubricPartsForFilter}
                  options={
                    selectedRubric?.rubric_parts.map((part) => ({
                      label: part.name,
                      value: part
                    })) || []
                  }
                />
                <Field.HelperText>
                  Select at least one rubric part to split across the selected graders
                </Field.HelperText>
              </Field.Root>
            )}
            <Text fontSize={"sm"}>
              {`There are ${submissionsToDo?.length ?? 0} active submissions assigned ${
                selectedUser?.profiles.name ? `to ${selectedUser?.profiles.name}` : ""
              } that are incomplete for this rubric on this assignment.`}
            </Text>
            {assignmentMode === "by_submission" && originalRubricParts.size > 0 && (
              <Text fontSize={"sm"} color="blue.600" fontStyle="italic">
                Note: Original rubric part assignments will be preserved. The new graders will get the same rubric parts
                that were originally assigned to {selectedUser?.profiles.name}.
              </Text>
            )}
            <Field.Root>
              <Field.Label>Select role to assign reviews to</Field.Label>
              <Select
                onChange={(e) => {
                  if (e?.value) {
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
              <Field.Label>Filter {role.toLowerCase()} by tag</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedTags(e);
                }}
                value={selectedTags}
                options={uniqueTags.map((tag) => ({ label: tag.name, value: tag }))}
                components={{
                  Option: ({ data, ...props }) => (
                    <Box
                      key={data.value.id}
                      {...props.innerProps}
                      p="4px 8px"
                      cursor="pointer"
                      _hover={{ bg: "gray.100" }}
                    >
                      {data.value ? <TagDisplay tag={data.value} /> : <div>{data.label}</div>}
                    </Box>
                  ),
                  MultiValue: ({ data, ...props }) => (
                    <Box key={data.value.id} {...props.innerProps} p="4px 8px" cursor="pointer">
                      {data.value ? <TagDisplay tag={data.value} /> : <div>{data.label}</div>}
                    </Box>
                  )
                }}
              />
              <Field.HelperText>Only assign work to {role.toLowerCase()} with one of these tags</Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label>Select specific {role.toLowerCase()} to assign work to</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedUsers(e);
                }}
                value={selectedUsers}
                options={selectedGraders().map((user) => ({
                  label: user.profiles.name,
                  value: user
                }))}
              />
              <Field.HelperText>
                {selectedUsers.length === 0
                  ? `All available ${role.toLowerCase()} will be assigned work`
                  : `Only ${selectedUsers.length} selected ${role.toLowerCase()} will be assigned work`}
              </Field.HelperText>
            </Field.Root>

            <Separator my={1} />

            <Heading size="sm">Grader Preferences</Heading>
            <Field.Root>
              <Field.Label>Prefer to use same grader as from a previous assignment</Field.Label>
              <Select
                value={
                  selectedReferenceAssignment
                    ? {
                        label: selectedReferenceAssignment.title,
                        value: selectedReferenceAssignment
                      }
                    : undefined
                }
                onChange={(e) => {
                  setSelectedReferenceAssignment(e?.value);
                  setSelectedReferenceRubric(undefined);
                }}
                options={
                  allAssignments?.data
                    .filter((assign) => assign.id !== Number(assignment_id))
                    .map((assign) => ({
                      label: assign.title,
                      value: assign
                    })) || []
                }
                isClearable
                placeholder="Select an assignment..."
              />
              <Field.HelperText>
                When possible, assign students to the same grader who reviewed their work on the selected assignment.
              </Field.HelperText>
            </Field.Root>

            {selectedReferenceAssignment && (
              <Field.Root>
                <Field.Label>Select rubric from reference assignment (optional)</Field.Label>
                <Select
                  value={
                    selectedReferenceRubric
                      ? {
                          label: selectedReferenceRubric.name,
                          value: selectedReferenceRubric
                        }
                      : undefined
                  }
                  onChange={(e) => setSelectedReferenceRubric(e?.value)}
                  options={
                    referenceRubrics?.data?.map((rubric) => ({
                      label: rubric.name,
                      value: rubric
                    })) || []
                  }
                  isClearable
                  placeholder="All rubrics"
                />
                <Field.HelperText>
                  If selected, only use grader assignments from this specific rubric. Leave empty to use all rubrics.
                </Field.HelperText>
              </Field.Root>
            )}

            <Separator my={1} />

            <Heading size="sm">Grader Exclusions</Heading>
            <Field.Root>
              <Field.Label>Exclude graders from a previous assignment</Field.Label>
              <Select
                value={
                  selectedExclusionAssignment
                    ? {
                        label: selectedExclusionAssignment.title,
                        value: selectedExclusionAssignment
                      }
                    : undefined
                }
                onChange={(e) => {
                  setSelectedExclusionAssignment(e?.value);
                  setSelectedExclusionRubric(undefined);
                }}
                options={
                  allAssignments?.data
                    .filter((assign) => assign.id !== Number(assignment_id))
                    .map((assign) => ({
                      label: assign.title,
                      value: assign
                    })) || []
                }
                isClearable
                placeholder="Select an assignment..."
              />
              <Field.HelperText>
                Prevent students from being assigned to the same grader who reviewed their work on the selected
                assignment. Useful for meta-grading where the meta-grader should not be the original grader.
              </Field.HelperText>
            </Field.Root>

            {selectedExclusionAssignment && (
              <Field.Root>
                <Field.Label>Select rubric to exclude from</Field.Label>
                <Select
                  value={
                    selectedExclusionRubric
                      ? {
                          label: selectedExclusionRubric.name,
                          value: selectedExclusionRubric
                        }
                      : undefined
                  }
                  onChange={(e) => setSelectedExclusionRubric(e?.value)}
                  options={
                    exclusionRubrics?.data?.map((rubric) => ({
                      label: rubric.name,
                      value: rubric
                    })) || []
                  }
                  placeholder="Select a rubric..."
                />
                <Field.HelperText>Required: Select which rubric&apos;s grader assignments to exclude.</Field.HelperText>
              </Field.Root>
            )}

            <Heading size="sm">Load balancing</Heading>
            <Field.Root>
              <Select
                value={
                  baseOnAll
                    ? { label: "Balance based on all assignments", value: true }
                    : { label: "Balance based on new assignments", value: false }
                }
                onChange={(e) => {
                  if (e) {
                    setBaseOnAll(e?.value);
                  }
                }}
                options={[
                  { label: "Balance based on new assignments", value: false },
                  { label: "Balance based on all assignments", value: true }
                ]}
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>Review due date ({course.time_zone ?? "America/New_York"})</Field.Label>
              <Input
                type="datetime-local"
                value={
                  dueDate
                    ? new Date(dueDate)
                        .toLocaleString("sv-SE", {
                          timeZone: course.time_zone ?? "America/New_York"
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
                      course.time_zone ?? "America/New_York"
                    );
                    setDueDate(tzDate.toString());
                  } else {
                    setDueDate("");
                  }
                }}
              />
            </Field.Root>
            <Button
              maxWidth={"md"}
              onClick={generateReviews}
              variant="subtle"
              loading={isGeneratingReviews}
              disabled={
                !dueDate ||
                !selectedRubric ||
                !role ||
                !selectedUser ||
                submissionsToDo?.length === 0 ||
                (assignmentMode === "by_filtered_parts" && selectedRubricPartsForFilter.length === 0)
              }
              marginBottom={"2"}
            >
              Generate Reviews
            </Button>
            {draftReviews.length > 0 && (
              <Flex flexDir={"column"} gap="3" padding="2">
                <DragAndDropExample
                  draftReviews={draftReviews}
                  setDraftReviews={setDraftReviews}
                  courseStaffWithConflicts={finalSelectedUsers() ?? []}
                />
                <Button maxWidth={"md"} variant="subtle" onClick={() => assignReviews()} float={"right"}>
                  Reassign
                </Button>
              </Flex>
            )}
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>
    </VStack>
  );
}
