"use client";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import TagDisplay from "@/components/ui/tag";
import { toaster } from "@/components/ui/toaster";
import useTags from "@/hooks/useTags";
import type { Assignment, ClassSection, LabSection, RubricPart, Tag } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
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
import { useInvalidate, useList } from "@refinedev/core";
import type { CrudFilters } from "@refinedev/core";
import { type MultiValue, Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import { type AssignmentResult, TAAssignmentSolver } from "../assignmentCalculator";
import DragAndDropExample from "../dragAndDrop";
import type {
  DraftReviewAssignment,
  RubricWithParts,
  SubmissionWithGrading,
  UserRoleWithConflictsAndName
} from "../page";
import { useAssignmentController, useRubrics } from "@/hooks/useAssignment";
import { useLabSections } from "@/hooks/useCourseController";
import { Alert } from "@/components/ui/alert";
import { addDays } from "date-fns";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import type { GradingConflictWithPopulatedProfiles } from "../../../../course/grading-conflicts/gradingConflictsTable";

// Main Page Component
export default function BulkAssignGradingPage() {
  const { course_id, assignment_id } = useParams();
  const invalidate = useInvalidate();

  const handleReviewAssignmentChange = () => {
    invalidate({ resource: "review_assignments", invalidates: ["list"] });
    invalidate({ resource: "submissions", invalidates: ["list"] });
  };

  return (
    <Container maxW="container.xl" py={2} px={2}>
      <HStack justifyContent="space-between" mb={4}>
        <VStack gap={1} align="flex-start">
          <Heading size="lg">Bulk Assign Grading</Heading>
          <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews`}>
            <FaArrowLeft /> Back to Reviews
          </Link>
          <Text fontSize="sm" maxW="lg">
            Bulk assign grading, accounting for conflicts. This form will not allow you to re-assign work (see{" "}
            <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews/reassign`}>
              Reassigning Work
            </Link>
            ), and will only process submissions/rubric parts that have not been assigned yet.
          </Text>
          <Text fontSize="sm" maxW="lg">
            The algorithm will first split submissions between graders (assigning all selected rubric parts to each
            grader), or split the rubric parts between graders first (assigning each submission to different graders for
            each rubric part). You will be able to preview the assignments before creating them.
          </Text>
        </VStack>
      </HStack>{" "}
      <Separator mb={4} />
      <BulkAssignGradingForm handleReviewAssignmentChange={handleReviewAssignmentChange} />
    </Container>
  );
}

function BulkAssignGradingForm({ handleReviewAssignmentChange }: { handleReviewAssignmentChange: () => void }) {
  const { assignment } = useAssignmentController();
  const rubrics = useRubrics();
  const labSections = useLabSections();
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<RubricWithParts>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<string>("Graders");
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>([]);
  const [dueDate, setDueDate] = useState<string>(addDays(assignment.due_date, 7).toISOString());
  const [baseOnAll, setBaseOnAll] = useState<boolean>(false);
  const [selectedTags, setSelectedTags] = useState<
    MultiValue<{
      label: string;
      value: Tag;
    }>
  >([]);
  const [assignmentMode, setAssignmentMode] = useState<"by_submission" | "by_rubric_part">("by_submission");
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
  const [selectedClassSections, setSelectedClassSections] = useState<
    MultiValue<{
      label: string;
      value: ClassSection;
    }>
  >([]);
  const [selectedLabSections, setSelectedLabSections] = useState<
    MultiValue<{
      label: string;
      value: LabSection;
    }>
  >([]);
  const [selectedStudentTags, setSelectedStudentTags] = useState<
    MultiValue<{
      label: string;
      value: Tag;
    }>
  >([]);
  const [selectedReferenceAssignment, setSelectedReferenceAssignment] = useState<Assignment>();
  const [selectedReferenceRubric, setSelectedReferenceRubric] = useState<RubricWithParts>();
  const [selectedExclusionAssignment, setSelectedExclusionAssignment] = useState<Assignment>();
  const [selectedExclusionRubric, setSelectedExclusionRubric] = useState<RubricWithParts>();
  const [numGradersToSelect, setNumGradersToSelect] = useState<number>(0);
  const [isGraderListExpanded, setIsGraderListExpanded] = useState<boolean>(false);

  // const { mutateAsync } = useCreate();
  const [isGeneratingReviews, setIsGeneratingReviews] = useState(false);
  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const { tags } = useTags();
  const supabase = createClient();

  // Fetch class sections
  const { data: classSections } = useList<ClassSection>({
    resource: "class_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id as string }],
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  });

  // Fetch all assignments for reference selection
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

  const gradingRubric = rubrics.find((rubric) => rubric.review_round === "grading-review");
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
  const referenceFilters: CrudFilters = [
    { field: "assignment_id", operator: "eq", value: selectedReferenceAssignment?.id },
    { field: "class_id", operator: "eq", value: course_id }
  ];
  if (selectedReferenceRubric) {
    referenceFilters.push({ field: "rubric_id", operator: "eq", value: selectedReferenceRubric.id });
  }

  const { data: referenceReviewAssignments } = useList({
    resource: "review_assignments",
    meta: {
      select:
        "assignee_profile_id, submission_id, rubric_id, submissions!review_assignments_submission_id_fkey(profile_id, assignment_groups!submissions_assignment_group_id_fkey(assignment_groups_members!assignment_groups_members_assignment_group_id_fkey(profile_id)))"
    },
    filters: referenceFilters,
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
  const { data: exclusionReviewAssignments } = useList({
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
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }

  // shuffled course staff to avoid those created first from consistently getting more assignments when
  // submissions / course_staff has a remainder
  const courseStaff = useMemo(
    () =>
      shuffle(
        userRoles?.data.filter((user) => {
          return user.role === "grader" || user.role === "instructor";
        }) ?? []
      ),
    [userRoles]
  );

  useEffect(() => {
    setSelectedRubricPartsForFilter(
      selectedRubric?.rubric_parts.map((part) => ({
        label: part.name,
        value: part
      })) || []
    );
  }, [selectedRubric]);

  /**
   * If any of the prior fields are changed, draft reviews should be cleared.
   */
  useEffect(() => {
    setDraftReviews([]);
  }, [
    selectedRubric,
    role,
    dueDate,
    assignmentMode,
    selectedRubricPartsForFilter,
    selectedUsers,
    selectedClassSections,
    selectedLabSections,
    selectedStudentTags,
    selectedReferenceAssignment,
    numGradersToSelect
  ]);

  /**
   * Populate submissions to do for assigning grading
   */
  useEffect(() => {
    if (selectedRubric && activeSubmissions) {
      setSubmissionsToDo(
        activeSubmissions.data.filter((sub) => {
          // Check if already assigned
          const isAlreadyAssigned = sub.review_assignments.find(
            (assign) =>
              assign.rubric_id === selectedRubric.id &&
              (assign.review_assignment_rubric_parts.length === 0 ||
                selectedRubricPartsForFilter.every((filter) =>
                  assign.review_assignment_rubric_parts.some((part) => part.rubric_part_id === filter.value.id)
                ))
          );
          if (isAlreadyAssigned) return false;

          // Apply new filters: class section, lab section, and student tags
          const groupMembers = sub.assignment_groups?.assignment_groups_members || [{ profile_id: sub.profile_id }];

          // For class section filtering
          if (selectedClassSections.length > 0) {
            const hasMatchingClassSection = groupMembers.some((member) => {
              // Get user roles for this profile ID
              const memberUserRoles =
                userRoles?.data.filter((role) => role.private_profile_id === member.profile_id) || [];
              return memberUserRoles.some((role) =>
                selectedClassSections.some((section) => section.value.id === role.class_section_id)
              );
            });
            if (!hasMatchingClassSection) return false;
          }

          // For lab section filtering
          if (selectedLabSections.length > 0) {
            const hasMatchingLabSection = groupMembers.some((member) => {
              // Get user roles for this profile ID
              const memberUserRoles =
                userRoles?.data.filter((role) => role.private_profile_id === member.profile_id) || [];
              return memberUserRoles.some((role) =>
                selectedLabSections.some((section) => section.value.id === role.lab_section_id)
              );
            });
            if (!hasMatchingLabSection) return false;
          }

          // For student tag filtering
          if (selectedStudentTags.length > 0) {
            const memberProfileIds = groupMembers.map((member) => member.profile_id);
            const hasMatchingTag = tags.some(
              (tag) =>
                memberProfileIds.includes(tag.profile_id) &&
                selectedStudentTags.some(
                  (selectedTag) => selectedTag.value.color === tag.color && selectedTag.value.name === tag.name
                )
            );
            if (!hasMatchingTag) return false;
          }

          return true;
        })
      );
    }
  }, [
    selectedRubric,
    activeSubmissions,
    selectedRubricPartsForFilter,
    selectedClassSections,
    selectedLabSections,
    selectedStudentTags,
    tags,
    userRoles
  ]);

  /**
   * Creates a preference map from the reference assignment: student profile ID -> preferred grader profile ID
   */
  const buildGraderPreferenceMap = useCallback(() => {
    const preferenceMap = new Map<string, string>();

    if (!selectedReferenceAssignment || !referenceReviewAssignments?.data) {
      return preferenceMap;
    }

    referenceReviewAssignments.data.forEach((reviewAssignment) => {
      // Filter by selected rubric if one is chosen
      if (selectedReferenceRubric && reviewAssignment["rubric_id"] !== selectedReferenceRubric.id) {
        return; // Skip this assignment if it's not for the selected rubric
      }

      const submission = reviewAssignment["submissions"];
      if (submission) {
        // Handle individual submissions
        if (submission.profile_id) {
          preferenceMap.set(submission.profile_id, reviewAssignment["assignee_profile_id"]);
        }

        // Handle group submissions
        if (submission.assignment_groups?.assignment_groups_members) {
          submission.assignment_groups.assignment_groups_members.forEach((member: { profile_id: string }) => {
            preferenceMap.set(member.profile_id, reviewAssignment["assignee_profile_id"]);
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

    exclusionReviewAssignments.data.forEach((reviewAssignment) => {
      const submission = reviewAssignment["submissions"];
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
          addExclusion(submission.profile_id, reviewAssignment["assignee_profile_id"]);
        }

        // Handle group submissions
        if (submission.assignment_groups?.assignment_groups_members) {
          submission.assignment_groups.assignment_groups_members.forEach((member: { profile_id: string }) => {
            addExclusion(member.profile_id, reviewAssignment["assignee_profile_id"]);
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
      return users;
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
    return users.filter((user) => matchingProfileIds.has(user.private_profile_id));
  }, [courseStaff, role, selectedTags, tags]);

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

  // Memoized sorted version of selectedUsers for display
  const sortedSelectedUsers = useMemo(() => {
    return [...selectedUsers].sort((a, b) => a.label.localeCompare(b.label));
  }, [selectedUsers]);

  /**
   * Auto-populate selectedUsers when the available users change based on role/tag filters
   * or when numGradersToSelect changes
   */
  useEffect(() => {
    const availableUsers = selectedGraders();

    // Set default number of graders to select to all available users
    if (numGradersToSelect === 0 || numGradersToSelect > availableUsers.length) {
      setNumGradersToSelect(availableUsers.length);
      return; // Exit early to avoid setting users twice
    }

    const userOptions = availableUsers.map((user) => ({
      label: user.profiles.name,
      value: user
    }));

    // Always regenerate the selected users when dependencies change
    const numToSelect = Math.min(numGradersToSelect || availableUsers.length, availableUsers.length);
    const shuffledUsers = shuffle(userOptions);
    const selectedSubset = shuffledUsers.slice(0, numToSelect);
    setSelectedUsers(selectedSubset);
  }, [selectedGraders, numGradersToSelect]);

  /**
   * Reset grader list expansion when selected users change
   */
  useEffect(() => {
    setIsGraderListExpanded(false);
  }, [selectedUsers]);

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
        title: "Strict Grader Preferences Enabled",
        description: `Will enforce exact grader assignments from ${selectedReferenceAssignment?.title}${rubricInfo} for ${graderPreferences.size} students, overriding all load balancing.`,
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
      const userCopy = {
        ...user,
        profiles: {
          ...user.profiles,
          grading_conflicts: [...(user.profiles.grading_conflicts ?? [])]
        }
      };

      // For each student in the exclusion map, check if this grader should be excluded
      graderExclusions.forEach((excludedGraders, studentId) => {
        if (excludedGraders.has(user.private_profile_id)) {
          // Add a temporary conflict
          const tempConflict: GradingConflictWithPopulatedProfiles = {
            id: -1,
            grader_profile_id: user.private_profile_id,
            student_profile_id: studentId,
            class_id: Number(course_id),
            created_at: new Date().toISOString(),
            created_by_profile_id: user.private_profile_id,
            reason: `Excluded based on ${selectedExclusionAssignment?.title} - ${selectedExclusionRubric?.name}`
          };
          userCopy.profiles.grading_conflicts.push(tempConflict);
        }
      });

      return userCopy;
    });

    // Handle sticky preferences first - these override any optimization
    const stickyAssignments: DraftReviewAssignment[] = [];
    const remainingSubmissions: SubmissionWithGrading[] = [];

    if (graderPreferences.size > 0) {
      // Process each submission to check for preferred graders
      submissionsToDo.forEach((submission) => {
        // Get all group members or just the single submitter
        const groupMembers = submission.assignment_groups?.assignment_groups_members || [
          { profile_id: submission.profile_id }
        ];

        // Check if any group member has a preferred grader
        let preferredGrader: UserRoleWithConflictsAndName | undefined;
        for (const member of groupMembers) {
          if (member.profile_id) {
            const preferredGraderId = graderPreferences.get(member.profile_id);
            if (preferredGraderId) {
              preferredGrader = usersWithExclusions.find((user) => user.private_profile_id === preferredGraderId);
              break;
            }
          }
        }

        if (preferredGrader) {
          // Create sticky assignment - this bypasses all optimization
          const submitters: UserRoleWithConflictsAndName[] = [];
          for (const member of groupMembers) {
            const memberUserRole = userRoles?.data.find((item) => {
              return item.private_profile_id === member.profile_id;
            });
            if (memberUserRole) {
              submitters.push(memberUserRole);
            }
          }

          if (selectedRubricPartsForFilter.length === selectedRubric?.rubric_parts.length) {
            // All rubric parts - create one assignment
            stickyAssignments.push({
              assignee: preferredGrader,
              submitters: submitters,
              submission: submission,
              part: undefined
            });
          } else {
            // Specific rubric parts - create assignment for each part
            selectedRubricPartsForFilter.forEach((part) => {
              stickyAssignments.push({
                assignee: preferredGrader,
                submitters: submitters,
                submission: submission,
                part: part.value
              });
            });
          }
        } else {
          // No preferred grader, add to remaining submissions for optimization
          remainingSubmissions.push(submission);
        }
      });

      toaster.create({
        title: "Sticky Preferences Applied",
        description: `${stickyAssignments.length} assignments made based on strict grader preferences. ${remainingSubmissions.length} submissions will be optimized.`,
        type: "info"
      });
    } else {
      // No preferences, all submissions go to optimization
      remainingSubmissions.push(...submissionsToDo);
    }

    // Now run optimization on remaining submissions
    let optimizedAssignments: DraftReviewAssignment[] = [];
    if (remainingSubmissions.length > 0) {
      if (assignmentMode === "by_rubric_part") {
        optimizedAssignments = generateReviewsByRubricPart(
          usersWithExclusions,
          remainingSubmissions,
          historicalWorkload,
          new Map() // No preferences for optimization - we handled them above
        );
      } else {
        optimizedAssignments = generateReviewsBySubmission(
          usersWithExclusions,
          remainingSubmissions,
          historicalWorkload,
          new Map() // No preferences for optimization - we handled them above
        );
      }
    }

    // Combine sticky assignments with optimized assignments
    setDraftReviews([...stickyAssignments, ...optimizedAssignments]);
    setIsGeneratingReviews(false);
  };

  const generateReviewsBySubmission = (
    users: UserRoleWithConflictsAndName[],
    submissionsToDo: SubmissionWithGrading[],
    historicalWorkload: Map<string, number>,
    graderPreferences?: Map<string, string>
  ) => {
    const result = new TAAssignmentSolver(users, submissionsToDo, historicalWorkload, graderPreferences, 1).solve();
    if (result.error) {
      toaster.error({ title: "Error drafting reviews", description: result.error });
    }

    if (selectedRubricPartsForFilter.length === selectedRubric?.rubric_parts.length) {
      return toReview(result);
    } else {
      return selectedRubricPartsForFilter.map((part) => toReview(result, part.value)).flat();
    }
  };

  const generateReviewsByRubricPart = (
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
    if (selectedParts.length > users.length) {
      toaster.error({
        title: "Error drafting reviews",
        description:
          "Not enough graders to assign all parts. Please select fewer parts or more graders, or use 'Assign by Submission' mode"
      });
      return [];
    }

    const groups = splitIntoGroups(users, selectedParts.length);
    const returnResult = [];
    for (let x = 0; x < groups.length && x < selectedParts.length; x += 1) {
      const result = new TAAssignmentSolver(
        groups[x]!,
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
    try {
      if (!selectedRubric) {
        toaster.error({ title: "Error creating review assignments", description: "Failed to find rubric" });
        return false;
      } else if (!course_id) {
        toaster.error({ title: "Error creating review assignments", description: "Failed to find current course" });
        return false;
      }

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
        toaster.error({
          title: "Error",
          description: existingAssignmentsError.message || "Error fetching existing review assignments"
        });
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

      if (assignmentsToUpdate.length > 0) {
        const { error: updateAssignmentsError } = await supabase
          .from("review_assignments")
          .update({ completed_at: null })
          .in("id", assignmentsToUpdate);
        if (updateAssignmentsError) {
          toaster.error({
            title: "Error updating review assignments",
            description: updateAssignmentsError.message
          });
          return false;
        }
      }

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

      if (assignmentsToCreate.length > 0) {
        const { error: insertAssignmentsError } = await supabase.from("review_assignments").insert(assignmentsToCreate);
        if (insertAssignmentsError) {
          toaster.error({ title: "Error creating review assignments", description: insertAssignmentsError.message });
          return false;
        }
      }

      const { data: allReviewAssignments, error: allReviewAssignmentsError } = await supabase
        .from("review_assignments")
        .select(
          "id, completed_at, review_assignment_rubric_parts(id, rubric_part_id), assignee_profile_id, submission_review_id"
        )
        .eq("assignment_id", Number(assignment_id))
        .eq("rubric_id", selectedRubric.id);

      if (allReviewAssignmentsError) {
        toaster.error({
          title: "Error",
          description: allReviewAssignmentsError.message || "Error fetching all review assignments"
        });
        return false;
      }

      //Now insert all the review assignment parts as needed (skip any that already exist)
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
            // Skip if the part already exists on this review assignment
            const alreadyHasPart = assignment.review_assignment_rubric_parts?.some(
              (p) => p.rubric_part_id === review.part!.id
            );
            if (alreadyHasPart) {
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
        .filter((part) => part !== undefined) as Array<{
        review_assignment_id: number;
        rubric_part_id: number;
        class_id: number;
      }>;

      // Ensure final payload only contains unique (review_assignment_id, rubric_part_id) pairs
      const seenPairs = new Set<string>();
      const uniqueReviewAssignmentPartsToCreate = reviewAssignmentPartsToCreate.filter((part) => {
        const key = `${part.review_assignment_id}:${part.rubric_part_id}`;
        if (seenPairs.has(key)) return false;
        seenPairs.add(key);
        return true;
      });

      if (uniqueReviewAssignmentPartsToCreate.length > 0) {
        const { error: insertPartsError } = await supabase
          .from("review_assignment_rubric_parts")
          .insert(uniqueReviewAssignmentPartsToCreate);
        // Alternatively, if a unique constraint exists, prefer upsert with onConflict("review_assignment_id,rubric_part_id")
        if (insertPartsError) {
          toaster.error({ title: "Error creating review assignment parts", description: insertPartsError.message });
          return false;
        }
      }

      toaster.success({
        title: "Reviews Assigned",
        description: `Successfully assigned ${validReviews.length} review assignments`
      });

      handleReviewAssignmentChange();
      clearStateData();
      return true;
    } catch (e: unknown) {
      const errMsg =
        (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : undefined) ||
        "An unexpected error occurred while confirming assignments";
      toaster.error({
        title: "Error confirming assignments",
        description: errMsg
      });
      return false;
    }
  };

  /**
   * Searches for the submission review id for this review assignment. If none found, creates a new submission
   * review to use.
   * @param review draft assignment to search
   * @returns submission review id for review assignment creation
   */
  const submissionReviewIdForReview = useCallback(
    async (review: DraftReviewAssignment) => {
      // 1) Prefer in-memory match for the selected rubric
      const localMatch = review.submission.submission_reviews?.find((sr) => sr.rubric_id === selectedRubric?.id);
      if (localMatch?.id) {
        return Number(localMatch.id);
      }

      // 2) Try fetching an existing row
      const { data: sr, error: fetchErr } = await supabase
        .from("submission_reviews")
        .select("id")
        .eq("submission_id", review.submission.id)
        .eq("rubric_id", Number(selectedRubric?.id))
        .single();
      if (!fetchErr && sr?.id) {
        return Number(sr.id);
      }

      // 3) Fallback: create it
      const { data: created, error: insertErr } = await supabase
        .from("submission_reviews")
        .insert({
          total_score: 0,
          total_autograde_score: 0,
          tweak: 0,
          class_id: Number(course_id),
          submission_id: review.submission.id,
          name: selectedRubric?.name ?? "Review",
          rubric_id: Number(selectedRubric?.id)
        })
        .select("id")
        .single();
      if (insertErr || !created?.id) {
        toaster.error({
          title: "Error creating submission review",
          description:
            insertErr?.message ??
            `Failed to create submission review for ${review.submitters.map((s) => s.profiles.name).join(", ")}`
        });
        return 0;
      }
      return Number(created.id);
    },
    [selectedRubric, supabase, course_id]
  );

  useEffect(() => {
    if (gradingRubric) {
      setSelectedRubric(gradingRubric);
    }
  }, [gradingRubric]);

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

  const invalidate = useInvalidate();

  /**
   * Clear state data
   */
  const clearStateData = useCallback(() => {
    setSelectedRubric(gradingRubric);
    setDraftReviews([]);
    setSelectedTags([]);
    setSelectedUsers([]);
    setSelectedClassSections([]);
    setSelectedLabSections([]);
    setSelectedStudentTags([]);
    setSelectedReferenceAssignment(undefined);
    setSelectedReferenceRubric(undefined);
    setSelectedExclusionAssignment(undefined);
    setSelectedExclusionRubric(undefined);
    setNumGradersToSelect(0);
    setIsGraderListExpanded(false);
    invalidate({ resource: "submissions", invalidates: ["all"] });
  }, [invalidate, gradingRubric]);

  /**
   * Returns a list of rubrics that are not self-review rubrics.
   */
  const availableRubrics = useMemo(() => {
    return rubrics
      .filter((rubric) => rubric.review_round !== "self-review")
      .map((rubric) => {
        return { label: rubric.name, value: rubric };
      });
  }, [rubrics]);

  return (
    <VStack align="stretch" w="100%" gap={2}>
      {/* Rubric Selection Section */}
      <Fieldset.Root borderColor="border.emphasized" borderWidth={1} borderRadius="md" p={2}>
        <Fieldset.Legend>
          <Heading size="md">Rubric Selection</Heading>
        </Fieldset.Legend>
        <Fieldset.Content m={0}>
          <VStack align="flex-start" maxW={"lg"} gap={1}>
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
                    setAssignmentMode(e.value as "by_submission" | "by_rubric_part");
                  }
                }}
                options={[
                  { label: "By submission", value: "by_submission" },
                  { label: "By rubric part", value: "by_rubric_part" }
                ]}
              />
              <Field.HelperText>
                {assignmentMode === "by_submission" && "Submissions are split between graders first"}
                {assignmentMode === "by_rubric_part" && "Rubric parts are split between graders first"}
              </Field.HelperText>
            </Field.Root>
            <Field.Root>
              <Field.Label>Choose rubric</Field.Label>
              <Select
                value={{ label: selectedRubric?.name, value: selectedRubric }}
                onChange={(e) => setSelectedRubric(e?.value)}
                options={availableRubrics}
              />
            </Field.Root>
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
              <Field.HelperText>Select at least one rubric part to split across the selected graders</Field.HelperText>
            </Field.Root>
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>

      {/* Submission Selection Section */}
      <Fieldset.Root borderColor="border.emphasized" borderWidth={1} borderRadius="md" p={2}>
        <Fieldset.Legend>
          <Heading size="md">Submission Selection</Heading>
        </Fieldset.Legend>
        <Fieldset.Content m={0}>
          <VStack align="flex-start" maxW={"lg"} gap={1}>
            <Field.Root>
              <Field.Label>Filter by class section</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedClassSections(e);
                }}
                value={selectedClassSections}
                options={
                  classSections?.data.map((section) => ({
                    label: section.name,
                    value: section
                  })) || []
                }
              />
              <Field.HelperText>Only include submissions from students in these class sections</Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label>Filter by lab section</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedLabSections(e);
                }}
                value={selectedLabSections}
                options={
                  labSections.map((section) => ({
                    label: section.name,
                    value: section
                  })) || []
                }
              />
              <Field.HelperText>Only include submissions from students in these lab sections</Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label>Filter by student tag</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedStudentTags(e);
                }}
                value={selectedStudentTags}
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
              <Field.HelperText>Only include submissions from students with these tags</Field.HelperText>
            </Field.Root>
            <Alert status="info">
              {submissionsToDo && submissionsToDo.length > 0
                ? `There are ${submissionsToDo.length} active submissions that match your criteria and are unassigned for at least one selected rubric part. Choose who to assign them to below.`
                : `No submissions match your criteria or all submissions have been assigned for all selected rubric parts.`}
            </Alert>
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>

      {/* Assignee Selection Section */}
      <Fieldset.Root borderColor="border.emphasized" borderWidth={1} borderRadius="md" p={2}>
        <Fieldset.Legend>
          <Heading size="md">Assignee Selection</Heading>
        </Fieldset.Legend>
        <Fieldset.Content m={0}>
          <VStack align="flex-start" maxW={"lg"} gap={1}>
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
              <Field.Label>Number of {role.toLowerCase()} to select</Field.Label>
              <Input
                type="number"
                min={1}
                max={selectedGraders().length}
                value={numGradersToSelect || ""}
                onChange={(e) => {
                  const value = parseInt(e.target.value);
                  if (!isNaN(value) && value > 0) {
                    setNumGradersToSelect(Math.min(value, selectedGraders().length));
                  }
                }}
                placeholder={`Max ${selectedGraders().length}`}
              />
              <Field.HelperText>
                Select how many {role.toLowerCase()} to randomly choose from {selectedGraders().length} available.
                Defaults to all available {role.toLowerCase()}.
              </Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label>Select specific {role.toLowerCase()} to assign work to</Field.Label>
              <Select
                isMulti={true}
                onChange={(e) => {
                  setSelectedUsers(e);
                }}
                value={sortedSelectedUsers}
                options={selectedGraders().map((user) => ({
                  label: user.profiles.name,
                  value: user
                }))}
                components={{
                  MultiValue: ({ data, removeProps, ...props }) => {
                    const allValues = props.selectProps.value as typeof selectedUsers;
                    const currentIndex = allValues.findIndex(
                      (item) => item.value.private_profile_id === data.value.private_profile_id
                    );

                    // If more than 10 selected and not expanded, only show first 9 and a "+X more" indicator
                    if (allValues.length > 10 && !isGraderListExpanded) {
                      if (currentIndex < 9) {
                        return (
                          <Box
                            key={data.value.private_profile_id}
                            display="inline-flex"
                            alignItems="center"
                            bg="bg.subtle"
                            borderRadius="md"
                            m={1}
                            p={1}
                            fontSize="sm"
                          >
                            {data.label}
                            <Button
                              size="xs"
                              variant="ghost"
                              minH="auto"
                              h="18px"
                              w="18px"
                              p={0}
                              onClick={(e) => removeProps.onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>)}
                              onMouseDown={(e) =>
                                removeProps.onMouseDown?.(e as unknown as React.MouseEvent<HTMLDivElement>)
                              }
                              onTouchEnd={(e) =>
                                removeProps.onTouchEnd?.(e as unknown as React.TouchEvent<HTMLDivElement>)
                              }
                            >
                              ×
                            </Button>
                          </Box>
                        );
                      } else if (currentIndex === 9) {
                        return (
                          <Box
                            key="more-indicator"
                            display="inline-flex"
                            alignItems="center"
                            bg="bg.info"
                            borderRadius="md"
                            p={1}
                            m={1}
                            fontSize="sm"
                            fontWeight="medium"
                            cursor="pointer"
                            _hover={{ bg: "blue.200" }}
                            onClick={() => setIsGraderListExpanded(true)}
                          >
                            +{allValues.length - 9} more
                          </Box>
                        );
                      } else {
                        return null;
                      }
                    }

                    // Default behavior: show all items (either ≤10 items or expanded view)
                    const isLastItem = currentIndex === allValues.length - 1;

                    return (
                      <>
                        <Box
                          key={data.value.private_profile_id}
                          display="inline-flex"
                          alignItems="center"
                          bg="bg.subtle"
                          borderRadius="md"
                          p={1}
                          m={1}
                          fontSize="sm"
                        >
                          {data.label}
                          <Button
                            size="xs"
                            variant="ghost"
                            minH="auto"
                            h="18px"
                            w="18px"
                            p={0}
                            ml={1}
                            onClick={(e) => removeProps.onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>)}
                            onMouseDown={(e) =>
                              removeProps.onMouseDown?.(e as unknown as React.MouseEvent<HTMLDivElement>)
                            }
                            onTouchEnd={(e) =>
                              removeProps.onTouchEnd?.(e as unknown as React.TouchEvent<HTMLDivElement>)
                            }
                          >
                            ×
                          </Button>
                        </Box>
                        {/* Show "Show less" button only when expanded and this is the last item and there are >10 total */}
                        {isLastItem && isGraderListExpanded && allValues.length > 10 && (
                          <Box
                            key="show-less-indicator"
                            display="inline-flex"
                            alignItems="center"
                            bg="gray.200"
                            borderRadius="md"
                            px={2}
                            py={1}
                            fontSize="sm"
                            fontWeight="medium"
                            cursor="pointer"
                            _hover={{ bg: "gray.300" }}
                            onClick={() => setIsGraderListExpanded(false)}
                          >
                            Show less
                          </Box>
                        )}
                      </>
                    );
                  }
                }}
              />
              <Field.HelperText>
                {sortedSelectedUsers.length} out of {selectedGraders().length} available {role.toLowerCase()} selected.
                {sortedSelectedUsers.length === 0
                  ? ` All available ${role.toLowerCase()} will be assigned work.`
                  : ` These ${sortedSelectedUsers.length} ${role.toLowerCase()} will be assigned work.`}
              </Field.HelperText>
            </Field.Root>

            <Separator my={2} />

            {/* Grader Assignment Rules Section */}
            <Fieldset.Root borderColor="border.emphasized" borderWidth={1} borderRadius="md" p={2}>
              <Fieldset.Legend>
                <Heading size="md">Grader Assignment Rules</Heading>
              </Fieldset.Legend>
              <Fieldset.Content m={0}>
                <VStack align="flex-start" maxW={"2xl"} gap={3}>
                  {/* Preferences Subsection */}
                  <Box w="100%">
                    <VStack align="flex-start" gap={2}>
                      <Heading size="sm">Strict Grader Preferences</Heading>
                      <Text fontSize="sm" color="text.muted" mb={1}>
                        Force specific student-grader pairings (overrides all load balancing)
                      </Text>

                      <Field.Root w="100%">
                        <Field.Label>Copy grader assignments from</Field.Label>
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
                            setSelectedReferenceRubric(undefined); // Reset rubric when assignment changes
                          }}
                          options={
                            allAssignments?.data.map((assign) => ({
                              label: assign.title,
                              value: assign
                            })) || []
                          }
                          isClearable
                          placeholder="Select an assignment to copy from..."
                        />
                        <Field.HelperText>
                          Students will be assigned to the exact same graders from the selected assignment. Choose
                          current assignment to copy from a different rubric.
                        </Field.HelperText>
                      </Field.Root>

                      {selectedReferenceAssignment && (
                        <Field.Root w="100%">
                          <Field.Label>Specific rubric to copy from</Field.Label>
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
                              referenceRubrics?.data.map((rubric) => ({
                                label: rubric.name,
                                value: rubric
                              })) || []
                            }
                            isClearable
                            placeholder="All rubrics (recommended)"
                          />
                          <Field.HelperText>
                            Optional: Narrow down to a specific rubric. Example: Copy from &quot;grading review&quot;
                            when assigning &quot;code walk review&quot;.
                          </Field.HelperText>
                        </Field.Root>
                      )}
                    </VStack>
                  </Box>

                  <Separator w="100%" />

                  {/* Exclusions Subsection */}
                  <Box w="100%">
                    <VStack align="flex-start" gap={2}>
                      <Heading size="sm">Grader Exclusions</Heading>
                      <Text fontSize="sm" color="text.muted" mb={1}>
                        Prevent certain student-grader pairings (useful for meta-grading)
                      </Text>

                      <Field.Root w="100%">
                        <Field.Label>Exclude grader assignments from</Field.Label>
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
                            setSelectedExclusionRubric(undefined); // Reset rubric when assignment changes
                          }}
                          options={
                            allAssignments?.data.map((assign) => ({
                              label: assign.title,
                              value: assign
                            })) || []
                          }
                          isClearable
                          placeholder="Select an assignment to exclude from..."
                        />
                        <Field.HelperText>
                          Students will NOT be assigned to graders who reviewed their work on the selected assignment.
                        </Field.HelperText>
                      </Field.Root>

                      {selectedExclusionAssignment && (
                        <Field.Root w="100%">
                          <Field.Label>Specific rubric to exclude from</Field.Label>
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
                              exclusionRubrics?.data.map((rubric) => ({
                                label: rubric.name,
                                value: rubric
                              })) || []
                            }
                            placeholder="Select a rubric..."
                          />
                          <Field.HelperText>
                            Required: Choose which rubric&apos;s assignments to exclude. Example: Exclude &quot;grading
                            review&quot; graders when assigning &quot;meta-grading review&quot;.
                          </Field.HelperText>
                        </Field.Root>
                      )}
                    </VStack>
                  </Box>
                </VStack>
              </Fieldset.Content>
            </Fieldset.Root>

            <Separator my={1} />

            <Heading size="sm">Load Balancing & Due Date</Heading>
            <Field.Root>
              <Field.Label>Load balancing strategy</Field.Label>
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
                    if (!date || !time) return;
                    const [year, month, day] = date.split("-");
                    const [hour, minute] = time.split(":");
                    if (!year || !month || !day || !hour || !minute) return;

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
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>

      {/* Action Buttons */}
      <VStack align="flex-start" gap={4}>
        <Button
          maxWidth={"md"}
          onClick={generateReviews}
          variant="subtle"
          colorPalette="green"
          disabled={
            !dueDate ||
            !selectedRubric ||
            !role ||
            submissionsToDo?.length === 0 ||
            selectedRubricPartsForFilter.length === 0
          }
          loading={isGeneratingReviews}
        >
          Prepare Review Assignments
        </Button>
        {draftReviews.length > 0 && (
          <Flex
            flexDir={"column"}
            gap="3"
            padding="0"
            w="100%"
            border="1px solid"
            borderColor="border.emphasized"
            borderRadius="lg"
            p={4}
          >
            <Heading size="sm">Review and Confirm Assignments</Heading>
            <Text fontSize="sm" color="text.muted">
              Review the assignments and confirm them before assigning. Tweak as needed by dragging and dropping
              submissions between graders.
            </Text>
            <Separator my={1} />
            <DragAndDropExample
              draftReviews={draftReviews}
              setDraftReviews={setDraftReviews}
              courseStaffWithConflicts={finalSelectedUsers() ?? []}
            />
            <Flex justify="center" w="100%">
              <Button w={"lg"} variant="solid" colorPalette="green" onClick={() => assignReviews()}>
                Confirm Assignments
              </Button>
            </Flex>
          </Flex>
        )}
      </VStack>
    </VStack>
  );
}
