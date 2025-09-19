"use client";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import TagDisplay from "@/components/ui/tag";
import { toaster } from "@/components/ui/toaster";
import { useActiveSubmissions, useAssignmentController } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController, useUserRolesWithProfiles } from "@/hooks/useCourseController";
import useTags from "@/hooks/useTags";
import TableController, { useListTableControllerValues, useTableControllerTableValues, PossiblyTentativeResult } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { RubricPart, Tag } from "@/utils/supabase/DatabaseTypes";
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
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import { AssignmentResult, TAAssignmentSolver } from "../assignmentCalculator";
import DragAndDropExample from "../dragAndDrop";
import { DraftReviewAssignment, RubricWithParts, SubmissionWithGrading, UserRoleWithConflictsAndName } from "../page";


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
        <VStack gap={2} align="flex-start">
          <Heading size="lg">Reassign Grading by Grader</Heading>
          <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews`}>
            <FaArrowLeft style={{ marginRight: "8px" }} /> Back to Reviews
          </Link>
        </VStack>
      </HStack>
      <Separator mb={4} />

      <ReassignGradingForm handleReviewAssignmentChange={handleReviewAssignmentChange} />
    </Container>
  );
}

function ReassignGradingForm({ handleReviewAssignmentChange }: { handleReviewAssignmentChange: () => void }) {
  const { course_id, assignment_id } = useParams();
  const assignmentController = useAssignmentController();
  const allActiveSubmissions = useActiveSubmissions();
  const courseController = useCourseController();
  const currentReviewAssignments = useTableControllerTableValues(assignmentController.reviewAssignments);
  const [selectedRubric, setSelectedRubric] = useState<RubricWithParts>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<string>("Graders");
  const [draftReviews, setDraftReviews] = useState<DraftReviewAssignment[]>([]);
  const [dueDate, setDueDate] = useState<string>(() => {
    // Default to 72 hours from now
    const now = new Date();
    now.setHours(now.getHours() + 72);
    return now.toISOString();
  });
  const [selectedUser, setSelectedUser] = useState<UserRoleWithConflictsAndName>();
  const [baseOnAll, setBaseOnAll] = useState<boolean>(false);
  const [selectedTags, setSelectedTags] = useState<
    MultiValue<{
      label: string;
      value: Tag;
    }>
  >([]);
  const [selectedUsers, setSelectedUsers] = useState<
    MultiValue<{
      label: string;
      value: UserRoleWithConflictsAndName;
    }>
  >([]);
  const [originalRubricParts, setOriginalRubricParts] = useState<Map<number, RubricPart[]>>(new Map());
  const [isGeneratingReviews, setIsGeneratingReviews] = useState(false);
  const supabase = useMemo(() => createClient(), []);

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
    if (ids.length === 0) {
      setReviewAssignmentPartsById(new Map());
      return;
    }
    const map = new Map<number, number[]>();
    reviewAssignmentParts.forEach((part) => {
      const list = map.get(part.review_assignment_id) ?? [];
      list.push(part.rubric_part_id);
      map.set(part.review_assignment_id, list);
    });
    setReviewAssignmentPartsById(map);
  }, [currentReviewAssignments, reviewAssignmentParts]);

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

  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const { tags } = useTags();

  const [gradingRubrics, setGradingRubrics] = useState<RubricWithParts[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("rubrics")
        .select("id, name, assignment_id, review_round, rubric_parts(id, name)")
        .eq("class_id", Number(course_id))
        .eq("assignment_id", Number(assignment_id))
        .neq("review_round", "self-review")
        .limit(1000);
      const rubrics = (data as unknown as RubricWithParts[]) ?? [];
      setGradingRubrics(rubrics);

      // Auto-select "grading rubric" if available and no rubric is currently selected
      if (!selectedRubric && rubrics.length > 0) {
        const gradingRubric = rubrics.find(r => r.name.toLowerCase().includes('grading'));
        if (gradingRubric) {
          setSelectedRubric(gradingRubric);
        }
      }
    };
    if (course_id && assignment_id) void load();
  }, [supabase, course_id, assignment_id, selectedRubric]);

  const userRolesData = useUserRolesWithProfiles();
  const userRoles = useMemo(() => {
    return { data: (userRolesData as unknown) as UserRoleWithConflictsAndName[] };
  }, [userRolesData]);

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
    (userRoles?.data as UserRoleWithConflictsAndName[]).filter((user: UserRoleWithConflictsAndName) => {
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
    selectedUsers,
    originalRubricParts
  ]);

  /**
   * Populate submissions to do for reassigning grading
   */
  useEffect(() => {
    if (!selectedUser || !selectedRubric) {
      setSubmissionsToDo([]);
      setOriginalRubricParts(new Map());
      return;
    }

    // Collect incomplete review assignments for this grader/rubric
    const matchingIncompleteRAs = currentReviewAssignments.filter((ra) => {
      if (ra.assignee_profile_id !== selectedUser.private_profile_id) return false;
      if (ra.rubric_id !== selectedRubric.id) return false;
      if (ra.completed_by) return false; // Only not-yet-completed assignments
      return true;
    });

    const submissionIds = new Set(matchingIncompleteRAs.map((ra) => ra.submission_id));

    // Build SubmissionWithGrading[] from allActiveSubmissions
    const buildMemberIds = (submission: { assignment_group_id: number | null; profile_id: string | null }) => {
      if (submission.assignment_group_id && groupMembersByGroupId.has(submission.assignment_group_id)) {
        return groupMembersByGroupId.get(submission.assignment_group_id)!;
      }
      return submission.profile_id ? [submission.profile_id] : [];
    };

    const filteredSubmissions = (allActiveSubmissions || [])
      .filter((sub) => submissionIds.has(sub.id))
      .map((sub) => {
        const memberIds = buildMemberIds(sub);
        return {
          ...(sub as unknown as SubmissionWithGrading),
          submission_reviews: [],
          review_assignments: [],
          assignment_groups:
            memberIds.length > 0
              ? { assignment_groups_members: memberIds.map((profile_id) => ({ profile_id })) }
              : null
        } as SubmissionWithGrading;
      });

    setSubmissionsToDo(filteredSubmissions);

    // Derive and preserve original parts for each submission (union across matching RAs)
    const rubricPartsMap = new Map<number, RubricPart[]>();
    filteredSubmissions.forEach((submission) => {
      const rasForSubmission = matchingIncompleteRAs.filter((ra) => ra.submission_id === submission.id);
      // If any RA has no specific parts, treat as whole-rubric (empty array -> will assign without part)
      const hasWholeRubric = rasForSubmission.some((ra) => (reviewAssignmentPartsById.get(ra.id) ?? []).length === 0);
      if (hasWholeRubric) {
        rubricPartsMap.set(submission.id, []);
        return;
      }
      const partIds = new Set<number>();
      rasForSubmission.forEach((ra) => (reviewAssignmentPartsById.get(ra.id) ?? []).forEach((pid) => partIds.add(pid)));
      const parts: RubricPart[] = selectedRubric.rubric_parts
        .filter((rp) => partIds.has(rp.id));
      rubricPartsMap.set(submission.id, parts);
    });
    setOriginalRubricParts(rubricPartsMap);
  }, [
    selectedUser,
    selectedRubric,
    currentReviewAssignments,
    reviewAssignmentPartsById,
    allActiveSubmissions,
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
   * Only auto-populate if no users are selected and it's not due to a manual clear
   */
  useEffect(() => {
    const availableUsers = selectedGraders();
    const userOptions = availableUsers.map((user) => ({
      label: user.profiles.name,
      value: user
    }));

    // Only auto-populate if no users are currently selected AND some users are available
    // Don't auto-populate if users were manually cleared
    if (selectedUsers.length === 0 && availableUsers.length > 0) {
      // Check if any selected users are no longer available due to filter changes
      const hasInvalidUsers = selectedUsers.some(
        (selected) => !availableUsers.find((user) => user.private_profile_id === selected.value.private_profile_id)
      );

      // Only set if we haven't manually cleared or if filters changed
      if (hasInvalidUsers) {
        setSelectedUsers(userOptions);
      }
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

      if (baseOnAll) {
        baseOnAllCalculator(historicalWorkload);
      }

      // Ensure users have proper grading_conflicts structure
      const usersWithConflicts = users.map((user) => ({
        ...user,
        profiles: {
          ...user.profiles,
          grading_conflicts: Array.isArray(user.profiles.grading_conflicts) 
            ? user.profiles.grading_conflicts 
            : []
        }
      }));

      // For "by_submission" mode, preserve the original rubric parts that were assigned
      const reviewAssignments = generateReviewsByRubric(
        usersWithConflicts,
        submissionsToDo,
        historicalWorkload
      );
      setDraftReviews(reviewAssignments);
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
    historicalWorkload: Map<string, number>
  ) => {
    const result = new TAAssignmentSolver(users, submissionsToDo, historicalWorkload, undefined, 1).solve();
    if (result.error) {
      toaster.error({ title: "Error drafting reviews", description: result.error });
    }
    return toReviewWithOriginalParts(result);
  };


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

    // Clear remaining work for the selected grader first
    await clearIncompleteAssignmentsForUser();

    // Build RPC payload from draftReviews
    const rpcDraftAssignments = (draftReviews ?? []).map((review: DraftReviewAssignment) => ({
      assignee_profile_id: review.assignee.private_profile_id,
      submission_id: review.submission.id,
      rubric_part_id: review.part?.id ?? null
    }));

    if (rpcDraftAssignments.length === 0) {
      toaster.error({ title: "Error", description: "No valid reviews to assign" });
      return false;
    }

    // Call bulk_assign_reviews RPC
    const { data: result, error: rpcError } = await supabase.rpc("bulk_assign_reviews", {
      p_class_id: Number(course_id),
      p_assignment_id: Number(assignment_id),
      p_rubric_id: selectedRubric.id,
      p_draft_assignments: rpcDraftAssignments,
      p_due_date: new TZDate(dueDate, course.time_zone ?? "America/New_York").toISOString()
    });

    if (rpcError) {
      toaster.error({ title: "Error creating review assignments", description: rpcError.message });
      return false;
    }

    const typed = result as unknown as {
      success: boolean;
      assignments_created: number;
      assignments_updated: number;
      parts_created: number;
      submission_reviews_created: number;
      total_processed: number;
      error?: string;
    } | null;

    if (!typed?.success) {
      toaster.error({ title: "Error creating review assignments", description: typed?.error || "Unknown error" });
      return false;
    }

    toaster.success({
      title: "Reviews Reassigned",
      description: `Created ${typed.assignments_created} and updated ${typed.assignments_updated} assignments`
    });

    handleReviewAssignmentChange();
    clearStateData();
    return true;
  };

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
    // Reset due date to 72 hours from now
    const now = new Date();
    now.setHours(now.getHours() + 72);
    setDueDate(now.toISOString());
    setSelectedUser(undefined);
    setBaseOnAll(false);
    setSelectedTags([]);
    setSelectedUsers([]);
    setOriginalRubricParts(new Map());
  }, []);

  /**
   * Deletes all of the review-assignments for the selected user that are incomplete for this
   * rubric and assignment. Used when review assignments are being reassigned.
   */
  const clearIncompleteAssignmentsForUser = useCallback(async () => {
    if (!selectedUser) return;
    const { error } = await supabase.rpc("clear_incomplete_assignments_for_user", {
      p_class_id: Number(course_id),
      p_assignment_id: Number(assignment_id),
      p_assignee_profile_id: selectedUser.private_profile_id,
      p_rubric_id: selectedRubric?.id ?? undefined,
      p_rubric_part_ids: undefined
    });
    if (error) {
      toaster.error({ title: "Error clearing assignments", description: error.message });
    }
  }, [supabase, course_id, assignment_id, selectedUser, selectedRubric]);

  // Note: clearUnfinishedAssignments function moved to shared ClearAssignmentsButton component

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
                options={gradingRubrics.map((rubric: RubricWithParts) => {
                  return { label: rubric.name, value: rubric };
                })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Assignment method</Field.Label>
              <Text fontSize="md" fontWeight="medium">By submission</Text>
              <Field.HelperText>
                Each grader will be assigned the same rubric parts that were originally assigned to the selected grader. This preserves the original part assignments.
              </Field.HelperText>
            </Field.Root>
            <Text fontSize={"sm"}>
              {`There are ${submissionsToDo?.length ?? 0} active submissions assigned ${selectedUser?.profiles.name ? `to ${selectedUser?.profiles.name}` : ""
                } that are incomplete for this rubric on this assignment.`}
            </Text>
            {originalRubricParts.size > 0 && (
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
                isClearable={true}
                onChange={(e) => {
                  setSelectedUsers(e || []);
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

            <Separator my={2} />

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
            <HStack gap={4} my={"2"}>
              <Button
                w="100%"
                onClick={generateReviews}
                variant="subtle"
                colorPalette="green"
                loading={isGeneratingReviews}
                disabled={
                  !dueDate ||
                  !selectedRubric ||
                  !role ||
                  !selectedUser ||
                  submissionsToDo?.length === 0
                }
              >
                Prepare Reassignments
              </Button>
            </HStack>

            {draftReviews.length > 0 && (
              <Flex flexDir={"column"} gap="3" padding="2">
                <DragAndDropExample
                  draftReviews={draftReviews}
                  setDraftReviews={setDraftReviews}
                  courseStaffWithConflicts={finalSelectedUsers() ?? []}
                  currentReviewAssignments={currentReviewAssignments}
                  selectedRubric={selectedRubric}
                  allActiveSubmissions={allActiveSubmissions}
                  groupMembersByGroupId={groupMembersByGroupId}
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
