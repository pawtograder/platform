"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import TagDisplay from "@/components/ui/tag";
import { toaster } from "@/components/ui/toaster";
import { useActiveSubmissions, useAssignmentController, useRubricParts, useRubrics } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useActiveUserRolesWithProfiles,
  useAssignments,
  useClassSections,
  useCourseController,
  useGradersAndInstructors,
  useLabSections
} from "@/hooks/useCourseController";
import useTags from "@/hooks/useTags";
import TableController, {
  PossiblyTentativeResult,
  useListTableControllerValues,
  useTableControllerTableValues
} from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Assignment, ClassSection, LabSection, Rubric, RubricPart, Tag } from "@/utils/supabase/DatabaseTypes";
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
import { useInvalidate } from "@refinedev/core";
import * as Sentry from "@sentry/nextjs";
import { MultiValue, Select } from "chakra-react-select";
import { addDays } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import { GradingConflictWithPopulatedProfiles } from "../../../../course/grading-conflicts/gradingConflictsTable";
import { AssignmentResult, TAAssignmentSolver } from "../assignmentCalculator";
import ClearAssignmentsButton from "../ClearAssignmentsButton";
import DragAndDropExample from "../dragAndDrop";
import { DraftReviewAssignment, RubricWithParts, SubmissionWithGrading, UserRoleWithConflictsAndName } from "../page";

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
  const assignmentController = useAssignmentController();
  const assignment = assignmentController.assignment;
  const rubrics = useRubrics();
  const labSections = useLabSections();
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<Rubric>();
  const rubricParts = useRubricParts(selectedRubric?.id);
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

  const [isGeneratingReviews, setIsGeneratingReviews] = useState(false);
  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const { tags } = useTags();
  const supabase = useMemo(() => createClient(), []);

  const classSections = useClassSections();
  const allAssignments = useAssignments();

  const gradingRubric = rubrics.find((rubric) => rubric.review_round === "grading-review");
  const allActiveSubmissions = useActiveSubmissions();

  const userRoles = useActiveUserRolesWithProfiles();

  const courseController = useCourseController();

  // Map of assignment_group_id -> member profile ids
  const [groupMembersByGroupId, setGroupMembersByGroupId] = useState<Map<number, string[]>>(new Map());
  useEffect(() => {
    const buildMap = (rows: Array<{ id: number; assignment_groups_members?: { profile_id: string }[] }>) => {
      const map = new Map<number, string[]>();
      for (const row of rows) {
        const members = row.assignment_groups_members?.map((m) => m.profile_id) ?? [];
        map.set(row.id, members);
      }
      return map;
    };
    const { data, unsubscribe } = courseController.assignmentGroupsWithMembers.list(
      (rows: Array<{ id: number; assignment_groups_members?: { profile_id: string }[] }>) => {
        setGroupMembersByGroupId(buildMap(rows));
      }
    );
    setGroupMembersByGroupId(
      buildMap(data as Array<{ id: number; assignment_groups_members?: { profile_id: string }[] }>)
    );
    return unsubscribe;
  }, [courseController]);

  useEffect(() => {
    if (assignmentController.reviewAssignments) {
      assignmentController.reviewAssignments.refetchAll();
    }
  }, [assignmentController.reviewAssignments]);

  // Current assignment review assignments rows (live via TableController)
  const currentReviewAssignments = useTableControllerTableValues(assignmentController.reviewAssignments);

  // Map of review_assignment_id -> assigned rubric_part_ids
  const [reviewAssignmentPartsById, setReviewAssignmentPartsById] = useState<Map<number, number[]>>(new Map());
  const reviewAssignmentPartsController = useMemo(() => {
    const controller = new TableController<
      "review_assignment_rubric_parts",
      "id, review_assignment_id, rubric_part_id"
    >({
      client: supabase,
      table: "review_assignment_rubric_parts",
      query: supabase
        .from("review_assignment_rubric_parts")
        .select("id,review_assignment_id, rubric_part_id")
        .eq("class_id", Number(course_id))
    });
    return controller;
  }, [supabase, course_id]);
  const reviewAssignmentsPredicate = useCallback(
    (
      row: PossiblyTentativeResult<{
        id: number;
        review_assignment_id: number;
        rubric_part_id: number;
      }>
    ) => {
      return currentReviewAssignments.some((r) => r.id === row.review_assignment_id);
    },
    [currentReviewAssignments]
  );
  const reviewAssignmentParts = useListTableControllerValues(
    reviewAssignmentPartsController,
    reviewAssignmentsPredicate
  );
  useEffect(() => {
    const ids = currentReviewAssignments.map((r) => r.id);
    if (ids.length === 0 || !reviewAssignmentParts) {
      setReviewAssignmentPartsById(new Map());
      return;
    }
    const map = new Map<number, number[]>();
    for (const part of reviewAssignmentParts) {
      const list = map.get(part.review_assignment_id) ?? [];
      list.push(part.rubric_part_id);
      map.set(part.review_assignment_id, list);
    }
    setReviewAssignmentPartsById(map);
  }, [currentReviewAssignments, reviewAssignmentParts]);

  // Grading conflicts via local TableController scoped to current class
  const gradingConflictsController = useMemo(() => {
    return new TableController({
      client: supabase,
      table: "grading_conflicts",
      query: supabase
        .from("grading_conflicts")
        .select("id, grader_profile_id, student_profile_id, class_id, created_at, created_by_profile_id, reason")
        .eq("class_id", Number(course_id)),
      classRealTimeController: courseController.classRealTimeController,
      realtimeFilter: { class_id: Number(course_id) }
    });
  }, [supabase, course_id, courseController.classRealTimeController]);
  const gradingConflicts = useTableControllerTableValues(gradingConflictsController);
  const gradersAndInstructors = useGradersAndInstructors();

  // Reference/exclusion rubric and assignments (loaded table-by-table)
  const [referenceRubrics, setReferenceRubrics] = useState<RubricWithParts[] | undefined>(undefined);
  const [exclusionRubrics, setExclusionRubrics] = useState<RubricWithParts[] | undefined>(undefined);
  // Reference & Exclusion review_assignments via local TableControllers
  const referenceReviewAssignmentsController = useMemo(() => {
    if (!selectedReferenceAssignment) return null;
    //Note EXPLICLTLY NOT REALTIME FOR THIS! Need to do bulk realtime updates to avoid herding, fix later...
    return new TableController({
      client: supabase,
      table: "review_assignments",
      query: supabase
        .from("review_assignments")
        .select("id, assignee_profile_id, submission_id, rubric_id, assignment_id, class_id")
        .eq("assignment_id", selectedReferenceAssignment.id)
        .eq("class_id", Number(course_id))
    });
  }, [supabase, selectedReferenceAssignment, course_id]);
  const exclusionReviewAssignmentsController = useMemo(() => {
    if (!selectedExclusionAssignment) return null;
    //Note EXPLICLTLY NOT REALTIME FOR THIS! Need to do bulk realtime updates to avoid herding, fix later...
    return new TableController({
      client: supabase,
      table: "review_assignments",
      query: supabase
        .from("review_assignments")
        .select("id, assignee_profile_id, submission_id, rubric_id, assignment_id, class_id")
        .eq("assignment_id", selectedExclusionAssignment.id)
        .eq("class_id", Number(course_id))
    });
  }, [supabase, selectedExclusionAssignment, course_id]);
  const referenceReviewAssignments = useMemo(() => {
    if (!referenceReviewAssignmentsController)
      return [] as { assignee_profile_id: string; submission_id: number; rubric_id: number }[];
    const { data } = referenceReviewAssignmentsController.list();
    return data as unknown[] as { assignee_profile_id: string; submission_id: number; rubric_id: number }[];
  }, [referenceReviewAssignmentsController]);
  const exclusionReviewAssignments = useMemo(() => {
    if (!exclusionReviewAssignmentsController)
      return [] as { assignee_profile_id: string; submission_id: number; rubric_id: number }[];
    const { data } = exclusionReviewAssignmentsController.list();
    return data as unknown[] as { assignee_profile_id: string; submission_id: number; rubric_id: number }[];
  }, [exclusionReviewAssignmentsController]);
  const [referenceSubmissionsMap, setReferenceSubmissionsMap] = useState<
    Record<number, { profile_id: string | null; assignment_group_id: number | null }>
  >({});
  const [exclusionSubmissionsMap, setExclusionSubmissionsMap] = useState<
    Record<number, { profile_id: string | null; assignment_group_id: number | null }>
  >({});
  const [isAssigningReviews, setIsAssigningReviews] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!selectedReferenceAssignment || !course_id) {
        setReferenceRubrics(undefined);
        setReferenceSubmissionsMap({});
        return;
      }
      const { data: rubrics } = await supabase
        .from("rubrics")
        .select("id, name, assignment_id")
        .eq("assignment_id", selectedReferenceAssignment.id)
        .limit(1000);
      setReferenceRubrics((rubrics as unknown as RubricWithParts[]) || []);
      const { data: submissions } = await supabase
        .from("submissions")
        .select("id, profile_id, assignment_group_id")
        .eq("assignment_id", selectedReferenceAssignment.id)
        .eq("class_id", Number(course_id))
        .limit(1000);
      type MinimalSubmission = { id: number; profile_id: string | null; assignment_group_id: number | null };
      const subMap: Record<number, { profile_id: string | null; assignment_group_id: number | null }> = {};
      for (const s of (submissions as unknown as MinimalSubmission[]) || []) {
        subMap[s.id] = { profile_id: s.profile_id, assignment_group_id: s.assignment_group_id };
      }
      setReferenceSubmissionsMap(subMap);
    };
    void load();
  }, [selectedReferenceAssignment, course_id, supabase]);

  useEffect(() => {
    const load = async () => {
      if (!selectedExclusionAssignment || !course_id) {
        setExclusionRubrics(undefined);
        setExclusionSubmissionsMap({});
        return;
      }
      const { data: rubrics } = await supabase
        .from("rubrics")
        .select("id, name, assignment_id")
        .eq("assignment_id", selectedExclusionAssignment.id);
      setExclusionRubrics((rubrics as unknown as RubricWithParts[]) || []);
      const { data: submissions } = await supabase
        .from("submissions")
        .select("id, profile_id, assignment_group_id")
        .eq("assignment_id", selectedExclusionAssignment.id)
        .eq("class_id", Number(course_id));
      type MinimalSubmission = { id: number; profile_id: string | null; assignment_group_id: number | null };
      const subMap: Record<number, { profile_id: string | null; assignment_group_id: number | null }> = {};
      for (const s of (submissions as unknown as MinimalSubmission[]) || []) {
        subMap[s.id] = { profile_id: s.profile_id, assignment_group_id: s.assignment_group_id };
      }
      setExclusionSubmissionsMap(subMap);
    };
    void load();
  }, [selectedExclusionAssignment, course_id, supabase]);

  // Replaced refine.dev filters with explicit loads above

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
  const courseStaff = useMemo(() => {
    const staffBase = userRoles.filter((user) => user.role === "grader" || user.role === "instructor");
    const enriched: UserRoleWithConflictsAndName[] = staffBase.map((u) => ({
      ...(u as unknown as UserRoleWithConflictsAndName),
      profiles: {
        ...(u.profiles as unknown as UserRoleWithConflictsAndName["profiles"]),
        name: (u.profiles as unknown as UserRoleWithConflictsAndName["profiles"]).name,
        grading_conflicts: gradingConflicts.filter((gc) => gc.grader_profile_id === u.private_profile_id)
      }
    }));
    return shuffle(enriched);
  }, [userRoles, gradingConflicts]);

  useEffect(() => {
    setSelectedRubricPartsForFilter(
      rubricParts?.map((part) => ({
        label: part.name,
        value: part
      })) || []
    );
  }, [selectedRubric, rubricParts]);

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
    if (!selectedRubric) {
      setSubmissionsToDo([]);
      return;
    }

    // Normalize empty selection to mean "all parts selected"
    const selectedPartIds =
      selectedRubricPartsForFilter.length === 0
        ? rubricParts?.map((p) => p.id) || []
        : selectedRubricPartsForFilter.map((p) => p.value.id);
    const selectedClassSectionIds = new Set(selectedClassSections.map((s) => s.value.id));
    const selectedLabSectionIds = new Set(selectedLabSections.map((s) => s.value.id));

    const buildMemberIds = (submission: { assignment_group_id: number | null; profile_id: string | null }) => {
      if (submission.assignment_group_id && groupMembersByGroupId.has(submission.assignment_group_id)) {
        return groupMembersByGroupId.get(submission.assignment_group_id)!;
      }
      return submission.profile_id ? [submission.profile_id] : [];
    };

    const isAssignedForSelectedParts = (submissionId: number): boolean => {
      const ras = currentReviewAssignments.filter(
        (ra) => ra.submission_id === submissionId && ra.rubric_id === selectedRubric.id
      );

      // First check if any RA has no specific parts (whole rubric assigned)
      for (const ra of ras) {
        const parts = reviewAssignmentPartsById.get(ra.id) ?? [];
        if (parts.length === 0) {
          return true; // whole rubric assigned
        }
      }

      // Build union of all parts from all matching RAs
      const allAssignedParts = new Set<number>();
      for (const ra of ras) {
        const parts = reviewAssignmentPartsById.get(ra.id) ?? [];
        parts.forEach((partId) => allAssignedParts.add(partId));
      }

      // Check if every selected part is covered by the union
      return selectedPartIds.every((pid) => allAssignedParts.has(pid));
    };

    const filtered = allActiveSubmissions
      .filter((sub) => sub.assignment_id === Number(assignment_id))
      .filter((sub) => !isAssignedForSelectedParts(sub.id))
      .filter((sub) => {
        if (gradersAndInstructors.some((gi) => gi.id === sub.profile_id)) {
          return false;
        }
        const memberIds = buildMemberIds(sub);
        // Class section filter
        if (selectedClassSectionIds.size > 0) {
          const ok = memberIds.some((pid) =>
            userRoles.some(
              (ur) => ur.private_profile_id === pid && selectedClassSectionIds.has(ur.class_section_id || 0)
            )
          );
          if (!ok) return false;
        }
        // Lab section filter
        if (selectedLabSectionIds.size > 0) {
          const ok = memberIds.some((pid) =>
            userRoles.some((ur) => ur.private_profile_id === pid && selectedLabSectionIds.has(ur.lab_section_id || 0))
          );
          if (!ok) return false;
        }
        // Tag filter
        if (selectedStudentTags.length > 0) {
          const memberSet = new Set(memberIds);
          const ok = tags.some(
            (tag) =>
              memberSet.has(tag.profile_id) &&
              selectedStudentTags.some((sel) => sel.value.color === tag.color && sel.value.name === tag.name)
          );
          if (!ok) return false;
        }
        // Exclude submissions where all members are disabled
        const anyActive = memberIds.some((pid) =>
          userRoles.some((ur) => ur.private_profile_id === pid && !ur.disabled)
        );
        return anyActive;
      })
      .map((sub) => {
        const memberIds = buildMemberIds(sub);
        return {
          ...(sub as unknown as SubmissionWithGrading),
          submission_reviews: [],
          review_assignments: [],
          assignment_groups:
            memberIds.length > 0 ? { assignment_groups_members: memberIds.map((profile_id) => ({ profile_id })) } : null
        } as SubmissionWithGrading;
      });

    setSubmissionsToDo(filtered);
  }, [
    selectedRubric,
    selectedRubricPartsForFilter,
    selectedClassSections,
    gradersAndInstructors,
    selectedLabSections,
    selectedStudentTags,
    tags,
    userRoles,
    groupMembersByGroupId,
    allActiveSubmissions,
    currentReviewAssignments,
    rubricParts,
    reviewAssignmentPartsById,
    assignment_id
  ]);

  /**
   * Creates a preference map from the reference assignment: student profile ID -> preferred grader profile ID
   */
  const buildGraderPreferenceMap = useCallback(() => {
    const preferenceMap = new Map<string, string>();
    if (!selectedReferenceAssignment || !referenceReviewAssignments) return preferenceMap;

    const rubricIdFilter = selectedReferenceRubric?.id;

    for (const ra of referenceReviewAssignments) {
      if (rubricIdFilter && ra.rubric_id !== rubricIdFilter) continue;
      const sub = referenceSubmissionsMap[ra.submission_id];
      if (!sub) continue;
      const memberIds =
        sub.assignment_group_id && groupMembersByGroupId.get(sub.assignment_group_id)
          ? groupMembersByGroupId.get(sub.assignment_group_id)!
          : sub.profile_id
            ? [sub.profile_id]
            : [];
      for (const pid of memberIds) {
        preferenceMap.set(pid, ra.assignee_profile_id);
      }
    }
    return preferenceMap;
  }, [
    selectedReferenceAssignment,
    selectedReferenceRubric,
    referenceReviewAssignments,
    referenceSubmissionsMap,
    groupMembersByGroupId
  ]);

  const buildGraderExclusionMap = useCallback(() => {
    const exclusionMap = new Map<string, Set<string>>();
    if (!selectedExclusionAssignment || !selectedExclusionRubric || !exclusionReviewAssignments) return exclusionMap;

    for (const ra of exclusionReviewAssignments) {
      if (ra.rubric_id !== selectedExclusionRubric.id) continue;
      const sub = exclusionSubmissionsMap[ra.submission_id];
      if (!sub) continue;
      const memberIds =
        sub.assignment_group_id && groupMembersByGroupId.get(sub.assignment_group_id)
          ? groupMembersByGroupId.get(sub.assignment_group_id)!
          : sub.profile_id
            ? [sub.profile_id]
            : [];
      for (const pid of memberIds) {
        if (!exclusionMap.has(pid)) exclusionMap.set(pid, new Set<string>());
        exclusionMap.get(pid)!.add(ra.assignee_profile_id);
      }
    }
    return exclusionMap;
  }, [
    selectedExclusionAssignment,
    selectedExclusionRubric,
    exclusionReviewAssignments,
    exclusionSubmissionsMap,
    groupMembersByGroupId
  ]);

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
            const memberUserRole = userRoles.find(
              (item) => item.private_profile_id === member.profile_id
            ) as unknown as UserRoleWithConflictsAndName | undefined;
            if (memberUserRole) {
              submitters.push(memberUserRole);
            }
          }

          // Treat empty selection as selecting all parts
          const isAllPartsSelected =
            selectedRubricPartsForFilter.length === 0 ||
            selectedRubricPartsForFilter.length === (rubricParts?.length || 0);

          if (isAllPartsSelected) {
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

    // Treat empty selection as selecting all parts
    const isAllPartsSelected =
      selectedRubricPartsForFilter.length === 0 || selectedRubricPartsForFilter.length === (rubricParts?.length || 0);

    if (isAllPartsSelected) {
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
    if (!rubricParts || !rubricParts.length || rubricParts.length === 0) {
      toaster.error({
        title: "Error drafting reviews",
        description: "Unable to create assignments by part because rubric has no parts"
      });
      return [];
    }

    // Treat empty selection as selecting all parts
    const selectedParts =
      selectedRubricPartsForFilter.length === 0
        ? rubricParts || []
        : selectedRubricPartsForFilter.map((option) => option.value);
    if (!selectedParts || selectedParts.length > users.length) {
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
      for (const ra of currentReviewAssignments) {
        if (selectedRubric && ra.rubric_id === selectedRubric.id) {
          historicalWorkload.set(ra.assignee_profile_id, (historicalWorkload.get(ra.assignee_profile_id) ?? 0) + 1);
        }
      }
    },
    [currentReviewAssignments, selectedRubric]
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
            const memberUserRole = userRoles.find(
              (item) => item.private_profile_id === member.profile_id
            ) as unknown as UserRoleWithConflictsAndName | undefined;
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
   * Creates the review assignments based on the draft reviews using the bulk_assign_reviews RPC.
   */
  const assignReviews = async () => {
    setIsAssigningReviews(true);
    try {
      if (!selectedRubric) {
        toaster.error({ title: "Error creating review assignments", description: "Failed to find rubric" });
        return false;
      } else if (!course_id) {
        toaster.error({ title: "Error creating review assignments", description: "Failed to find current course" });
        return false;
      }

      if (!draftReviews || draftReviews.length === 0) {
        toaster.error({ title: "Error", description: "No draft reviews to assign" });
        return false;
      }

      // Add Sentry breadcrumb for tracking
      Sentry.addBreadcrumb({
        message: "Starting bulk review assignment",
        category: "bulk_assign",
        data: {
          course_id: Number(course_id),
          assignment_id: Number(assignment_id),
          rubric_id: selectedRubric.id,
          draft_count: draftReviews.length
        },
        level: "info"
      });

      // Transform draft reviews to the format expected by the RPC
      const rpcDraftAssignments = draftReviews.map((review) => ({
        assignee_profile_id: review.assignee.private_profile_id,
        submission_id: review.submission.id,
        rubric_part_id: review.part?.id || null
      }));

      // Call the bulk_assign_reviews RPC
      const { data: result, error: rpcError } = await supabase.rpc("bulk_assign_reviews", {
        p_class_id: Number(course_id),
        p_assignment_id: Number(assignment_id),
        p_rubric_id: selectedRubric.id,
        p_draft_assignments: rpcDraftAssignments,
        p_due_date: new TZDate(dueDate, course.time_zone ?? "America/New_York").toISOString()
      });

      if (rpcError) {
        Sentry.withScope((scope) => {
          scope.setContext("bulk_assign", {
            error: rpcError.message,
            code: rpcError.code
          });
          Sentry.captureException(rpcError);
        });

        toaster.error({
          title: "Error creating review assignments",
          description: rpcError.message || "Failed to create bulk assignments"
        });
        return false;
      }

      // Type cast the result for proper access to properties
      const typedResult = result as {
        success: boolean;
        error?: string;
        assignments_created: number;
        assignments_updated: number;
        parts_created: number;
        submission_reviews_created: number;
        total_processed: number;
      };
      await exclusionReviewAssignmentsController?.refetchAll();
      await referenceReviewAssignmentsController?.refetchAll();

      if (!typedResult?.success) {
        Sentry.withScope((scope) => {
          scope.setContext("bulk_assign", {
            result: typedResult
          });
          Sentry.captureException(
            new Error(`Bulk assignment RPC returned failure: ${typedResult?.error || "Unknown error"}`)
          );
        });

        toaster.error({
          title: "Error creating review assignments",
          description: typedResult?.error || "Unknown error occurred during bulk assignment"
        });
        return false;
      }

      // Log successful operation
      Sentry.addBreadcrumb({
        message: "Bulk assignment completed successfully",
        category: "bulk_assign",
        data: {
          assignments_created: typedResult.assignments_created,
          assignments_updated: typedResult.assignments_updated,
          parts_created: typedResult.parts_created,
          submission_reviews_created: typedResult.submission_reviews_created,
          total_processed: typedResult.total_processed
        },
        level: "info"
      });

      // Show detailed success message
      const details = [];
      if (typedResult.assignments_created > 0) details.push(`${typedResult.assignments_created} new assignments`);
      if (typedResult.assignments_updated > 0) details.push(`${typedResult.assignments_updated} updated assignments`);
      if (typedResult.parts_created > 0) details.push(`${typedResult.parts_created} rubric parts`);
      if (typedResult.submission_reviews_created > 0)
        details.push(`${typedResult.submission_reviews_created} submission reviews`);

      toaster.success({
        title: "Reviews Assigned Successfully",
        description: `Created ${details.join(", ")} from ${typedResult.total_processed} draft assignments`
      });

      handleReviewAssignmentChange();
      clearStateData();
      return true;
    } catch (e: unknown) {
      const errId = Sentry.captureException(e);
      const errMsg =
        (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : undefined) ||
        `An unexpected error occurred while confirming assignments, our team has been notified with error ID ${errId}`;

      toaster.error({
        title: "Error confirming assignments",
        description: errMsg
      });
      return false;
    } finally {
      setIsAssigningReviews(false);
    }
  };

  // Note: submissionReviewIdForReview function removed - now handled by bulk_assign_reviews RPC
  // Note: clearUnfinishedAssignments function moved to shared ClearAssignmentsButton component

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
                  setSelectedRubricPartsForFilter([...e]);
                }}
                value={selectedRubricPartsForFilter}
                options={
                  rubricParts?.map((part) => ({
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
                options={classSections.map((section) => ({ label: section.name, value: section }))}
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
                          options={allAssignments.map((assign) => ({ label: assign.title, value: assign }))}
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
                            options={(referenceRubrics || []).map((rubric) => ({ label: rubric.name, value: rubric }))}
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
                          options={allAssignments.map((assign) => ({ label: assign.title, value: assign }))}
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
                            options={(exclusionRubrics || []).map((rubric) => ({ label: rubric.name, value: rubric }))}
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
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>

      {/* Action Buttons */}
      <VStack align="flex-start" gap={4}>
        <VStack align="flex-start" gap={2}>
          <HStack gap={4}>
            <Button
              maxWidth={"md"}
              onClick={generateReviews}
              variant="subtle"
              colorPalette="green"
              disabled={!dueDate || !selectedRubric || !role || submissionsToDo?.length === 0}
              loading={isGeneratingReviews}
            >
              Prepare Review Assignments
            </Button>
            <ClearAssignmentsButton
              selectedRubric={selectedRubric}
              selectedRubricPartsForFilter={selectedRubricPartsForFilter}
              selectedClassSections={selectedClassSections}
              selectedLabSections={selectedLabSections}
              selectedStudentTags={selectedStudentTags}
              submissionsToDo={submissionsToDo}
              course_id={course_id as string}
              assignment_id={assignment_id as string}
              onSuccess={handleReviewAssignmentChange}
            />
          </HStack>
          <Text fontSize="sm" color="text.muted" maxW="2xl">
            Use &quot;Clear Unfinished Assignments&quot; to remove incomplete review assignments for the selected rubric
            and rubric parts. If no specific parts are selected, all incomplete assignments for the rubric will be
            cleared. This is useful for starting fresh with a new assignment strategy.
          </Text>
        </VStack>
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
              currentReviewAssignments={currentReviewAssignments}
              selectedRubric={selectedRubric}
              allActiveSubmissions={allActiveSubmissions}
              groupMembersByGroupId={groupMembersByGroupId}
            />
            <Flex justify="center" w="100%">
              <Button
                w={"lg"}
                variant="solid"
                colorPalette="green"
                onClick={() => assignReviews()}
                loading={isAssigningReviews}
              >
                Confirm Assignments
              </Button>
            </Flex>
          </Flex>
        )}
      </VStack>
    </VStack>
  );
}
