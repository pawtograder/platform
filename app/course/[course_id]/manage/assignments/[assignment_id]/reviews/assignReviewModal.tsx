"use client";

import { createClient } from "@/utils/supabase/client";
import { Input, Text, VStack } from "@chakra-ui/react";
import { HttpError, useCreate, useList, useOne, useUpdate } from "@refinedev/core";
import { Select as ChakraReactSelect } from "chakra-react-select";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { TZDate } from "@date-fns/tz";
import { PopulatedReviewAssignment } from "./ReviewsTable";
import { useCourseController } from "@/hooks/useCourseController";
import TableController from "@/lib/TableController";

// Type definitions
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"] & {
  profiles?: Pick<ProfileRow, "id" | "name">;
};
type SubmissionReviewRow = Database["public"]["Tables"]["submission_reviews"]["Row"];
type GradingConflictRow = Database["public"]["Tables"]["grading_conflicts"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
  assignments?: AssignmentRow;
  submission_reviews?: SubmissionReviewRow[];
};

type ReviewAssignmentFormData = {
  assignee_profile_id: string;
  submission_id: number;
  rubric_id: number;
  due_date: string;
  rubric_part_ids?: number[];
  release_date?: string;
  max_allowable_late_tokens?: number;
};

type AssignReviewModalProps = {
  isOpen: boolean;
  onClose: () => void;
  courseId: number;
  assignmentId: number;
  onSuccess: () => void;
  initialData?: PopulatedReviewAssignment | null | undefined;
  isEditing?: boolean;
};

export default function AssignReviewModal({
  isOpen,
  onClose,
  courseId,
  assignmentId,
  onSuccess,
  initialData,
  isEditing
}: AssignReviewModalProps) {
  const {
    reset: resetForm,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch
  } = useForm<ReviewAssignmentFormData>({
    defaultValues:
      isEditing && initialData
        ? {
            assignee_profile_id: initialData.assignee_profile_id,
            submission_id: initialData.submission_id,
            rubric_id: initialData.rubric_id,
            due_date: initialData.due_date ? format(new TZDate(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : "",
            rubric_part_ids: initialData.review_assignment_rubric_parts?.map((p) => p.rubric_parts.id) || [],
            release_date: initialData.release_date
              ? format(new Date(initialData.release_date), "yyyy-MM-dd'T'HH:mm")
              : undefined,
            max_allowable_late_tokens: initialData.max_allowable_late_tokens ?? 0
          }
        : {
            max_allowable_late_tokens: 0,
            rubric_part_ids: [],
            assignee_profile_id: undefined,
            submission_id: undefined,
            rubric_id: undefined,
            due_date: "",
            release_date: undefined
          }
  });

  const { mutateAsync: createReviewAssignment } = useCreate<ReviewAssignmentRow, HttpError, ReviewAssignmentFormData>();
  const { mutateAsync: updateReviewAssignment } = useUpdate<ReviewAssignmentRow, HttpError, ReviewAssignmentFormData>();
  const { mutateAsync: createReviewAssignmentRubricPart } = useCreate<
    Database["public"]["Tables"]["review_assignment_rubric_parts"]["Row"],
    HttpError,
    Database["public"]["Tables"]["review_assignment_rubric_parts"]["Insert"]
  >();

  const supabaseClient = createClient();
  const selectedRubricId = watch("rubric_id");
  const selectedRubricPartIds = watch("rubric_part_ids");
  const selectedSubmissionId = watch("submission_id");

  const { data: assignmentData, isLoading: isLoadingAssignment } = useOne<AssignmentRow>({
    resource: "assignments",
    id: assignmentId,
    queryOptions: { enabled: isOpen && !!assignmentId },
    meta: { select: "id, grading_rubric_id" }
  });
  const gradingRubricId = assignmentData?.data?.grading_rubric_id;

  const { data: courseUsersData, isLoading: isLoadingCourseUsers } = useList<UserRoleRow>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      // Add student when self-reviews are implemented
      { field: "role", operator: "in", value: ["grader", "instructor"] }
    ],
    meta: { select: "private_profile_id, profiles!user_roles_private_profile_id_fkey!inner(id, name)" },
    queryOptions: { enabled: isOpen }
  });

  const { data: gradingConflictsData, isLoading: isLoadingGradingConflicts } = useList<GradingConflictRow>({
    resource: "grading_conflicts",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    queryOptions: { enabled: isOpen }
  });

  const { classRealTimeController, client: supabase } = useCourseController();

  // Create a TableController for populated submissions using AssignmentController pattern
  const populatedSubmissionsSelect =
    "*, profiles!profile_id(id, name), assignment_groups(id, name, assignment_groups_members(profiles!profile_id(id, name)))";
  const [submissionsTableController, setSubmissionsTableController] = useState<TableController<
    "submissions",
    typeof populatedSubmissionsSelect,
    number
  > | null>(null);

  useEffect(() => {
    if (!isOpen || !assignmentId || !classRealTimeController) {
      setSubmissionsTableController(null);
      return;
    }

    const query = supabase
      .from("submissions")
      .select(populatedSubmissionsSelect)
      .eq("assignment_id", assignmentId)
      .eq("is_active", true)
      .eq("class_id", courseId);

    const tc = new TableController<"submissions", typeof populatedSubmissionsSelect, number>({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      table: "submissions",
      classRealTimeController
    });

    setSubmissionsTableController(tc);

    return () => {
      tc.close();
    };
  }, [isOpen, assignmentId, courseId, supabase, classRealTimeController]);

  // Get all submissions from the table controller
  const [submissionsDataArray, setSubmissionsDataArray] = useState<PopulatedSubmission[]>([]);
  const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(true);

  useEffect(() => {
    if (!submissionsTableController) {
      setSubmissionsDataArray([]);
      setIsLoadingSubmissions(true);
      return;
    }

    setIsLoadingSubmissions(true);
    const { data, unsubscribe } = submissionsTableController.list((newData) => {
      setSubmissionsDataArray(newData as PopulatedSubmission[]);
      setIsLoadingSubmissions(false);
    });
    setSubmissionsDataArray(data as PopulatedSubmission[]);
    setIsLoadingSubmissions(!submissionsTableController.ready);

    // Wait for controller to be ready
    submissionsTableController.readyPromise.then(() => {
      setIsLoadingSubmissions(false);
    });

    return unsubscribe;
  }, [submissionsTableController]);

  const assigneeOptions = useMemo(() => {
    if (!courseUsersData?.data) return [];

    let availableAssignees = courseUsersData.data;

    if (selectedSubmissionId && submissionsDataArray && gradingConflictsData?.data) {
      const selectedSubmission = submissionsDataArray.find((sub) => sub.id === selectedSubmissionId);
      if (selectedSubmission) {
        const studentIdsForSubmission: string[] = [];
        if (selectedSubmission.profiles?.id) {
          studentIdsForSubmission.push(selectedSubmission.profiles.id);
        }
        selectedSubmission.assignment_groups?.assignment_groups_members?.forEach((member) => {
          if (member.profiles?.id) {
            studentIdsForSubmission.push(member.profiles.id);
          }
        });

        if (studentIdsForSubmission.length > 0) {
          availableAssignees = courseUsersData.data.filter((userRole) => {
            const isConflicted = gradingConflictsData.data.some(
              (conflict) =>
                conflict.grader_profile_id === userRole.private_profile_id &&
                studentIdsForSubmission.includes(conflict.student_profile_id)
            );
            return !isConflicted;
          });
        }
      }
    }

    return availableAssignees.map((userRole) => ({
      value: userRole.private_profile_id,
      label: userRole.profiles?.name
        ? `${userRole.profiles.name}`
        : `Name Missing (User ID: ${userRole.private_profile_id})`
    }));
  }, [courseUsersData, selectedSubmissionId, submissionsDataArray, gradingConflictsData]);

  // Review assignments to detect which submissions are already assigned (respecting selected rubric/parts)
  const reviewAssignmentsSelect = "id, submission_id, rubric_id, review_assignment_rubric_parts(rubric_part_id)";
  const [reviewAssignments, setReviewAssignments] = useState<
    {
      id: number;
      submission_id: number;
      rubric_id: number;
      review_assignment_rubric_parts: { rubric_part_id: number | null }[] | null;
    }[]
  >([]);
  const [isLoadingReviewAssignments, setIsLoadingReviewAssignments] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setReviewAssignments([]);
      return;
    }
    const load = async () => {
      setIsLoadingReviewAssignments(true);
      const query = supabaseClient
        .from("review_assignments")
        .select(reviewAssignmentsSelect)
        .eq("assignment_id", assignmentId);
      if (selectedRubricId) {
        query.eq("rubric_id", selectedRubricId);
      }
      const { data, error } = await query;
      if (!error && data) {
        setReviewAssignments(
          data as {
            id: number;
            submission_id: number;
            rubric_id: number;
            review_assignment_rubric_parts: { rubric_part_id: number | null }[] | null;
          }[]
        );
      } else {
        setReviewAssignments([]);
      }
      setIsLoadingReviewAssignments(false);
    };
    void load();
  }, [isOpen, assignmentId, selectedRubricId, supabaseClient]);

  const submissionsOptions = useMemo(() => {
    const partsToCheck =
      selectedRubricPartIds && selectedRubricPartIds.length > 0 ? new Set(selectedRubricPartIds) : null;

    const isSubmissionAssigned = (submissionId: number) => {
      const ras = reviewAssignments.filter(
        (ra) => ra.submission_id === submissionId && (!selectedRubricId || ra.rubric_id === selectedRubricId)
      );
      if (ras.length === 0) return false;
      if (!partsToCheck || partsToCheck.size === 0) return true;

      // If any RA has no specific parts, treat as fully assigned
      if (ras.some((ra) => !ra.review_assignment_rubric_parts || ra.review_assignment_rubric_parts.length === 0)) {
        return true;
      }

      const covered = new Set<number>();
      ras.forEach((ra) => {
        ra.review_assignment_rubric_parts?.forEach((p) => {
          if (p.rubric_part_id) covered.add(p.rubric_part_id);
        });
      });
      return Array.from(partsToCheck).every((pid) => covered.has(pid));
    };

    const baseOptions =
      submissionsDataArray.map((sub) => {
        let label = `Submission ID: ${sub.id}`;
        if (sub.assignment_groups?.name) {
          label = `Group: ${sub.assignment_groups.name} (Submission ID: ${sub.id})`;
        } else if (sub.profiles?.name) {
          label = `Student: ${sub.profiles.name} (Submission ID: ${sub.id})`;
        }
        return { value: sub.id, label, assigned: isSubmissionAssigned(sub.id) };
      }) || [];

    const unassigned = baseOptions.filter((opt) => !opt.assigned);
    const assigned = baseOptions.filter((opt) => opt.assigned);

    const groups: { label: string; options: typeof baseOptions }[] = [];
    if (unassigned.length > 0) {
      groups.push({ label: "Unassigned submissions", options: unassigned });
    }
    if (assigned.length > 0) {
      groups.push({ label: "Already assigned", options: assigned });
    }
    return groups;
  }, [submissionsDataArray, reviewAssignments, selectedRubricId, selectedRubricPartIds]);

  const rubricsFilters = useMemo(() => {
    if (isLoadingAssignment) return undefined;
    return [
      { field: "class_id", operator: "eq" as const, value: courseId },
      { field: "assignment_id", operator: "eq" as const, value: assignmentId },
      { field: "review_round", operator: "ne" as const, value: "self-review" }
    ];
  }, [isLoadingAssignment, courseId, assignmentId]);

  const { data: rubricsData, isLoading: isLoadingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    filters: rubricsFilters,
    meta: { select: "id, name, review_round" },
    queryOptions: {
      enabled: isOpen && !isLoadingAssignment && rubricsFilters !== undefined
    }
  });

  const rubricOptions = useMemo(
    () =>
      rubricsData?.data.map((rubric) => ({
        value: rubric.id,
        label: `${rubric.name} (${rubric.review_round || "N/A"})`
      })) || [],
    [rubricsData]
  );

  // Default rubric to grading rubric when modal opens
  useEffect(() => {
    if (!isOpen) return;
    if (gradingRubricId === null) return;
    resetForm((prev) => ({
      ...prev,
      rubric_id: gradingRubricId ?? prev.rubric_id
    }));
  }, [isOpen, gradingRubricId, resetForm]);

  const { data: rubricPartsData, isLoading: isLoadingRubricParts } = useList<
    Database["public"]["Tables"]["rubric_parts"]["Row"]
  >({
    resource: "rubric_parts",
    filters: [{ field: "rubric_id", operator: "eq", value: selectedRubricId }],
    queryOptions: { enabled: !!selectedRubricId && isOpen }
  });

  const rubricPartOptions = useMemo(
    () => rubricPartsData?.data.map((part) => ({ label: part.name || `Part ID ${part.id}`, value: part.id })) || [],
    [rubricPartsData]
  );

  const onSubmitHandler = async (data: ReviewAssignmentFormData) => {
    const { rubric_part_ids, ...restOfData } = data;
    let reviewAssignmentId: number | undefined = undefined;
    let mainOperationSuccessful = false;
    let rubricPartsOperationSuccessful = true; // Assume success unless proven otherwise

    // Validate required fields
    if (!restOfData.submission_id || !restOfData.rubric_id) {
      toaster.error({
        title: "Error",
        description: "Submission and rubric must be selected."
      });
      return;
    }

    // Resolve submission_review_id for this submission + rubric (required by DB)
    let submissionReviewId: number | undefined;
    try {
      const { data: sr, error: selectError } = await supabaseClient
        .from("submission_reviews")
        .select("id")
        .eq("submission_id", restOfData.submission_id)
        .eq("rubric_id", restOfData.rubric_id)
        .single();

      if (sr?.id) {
        submissionReviewId = Number(sr.id);
      } else {
        // Create the submission_review if it's missing
        const rubricName = rubricsData?.data?.find((r) => r.id === restOfData.rubric_id)?.name || "Review";
        const { data: created, error: insertError } = await supabaseClient
          .from("submission_reviews")
          .insert({
            class_id: courseId,
            submission_id: restOfData.submission_id,
            rubric_id: restOfData.rubric_id,
            name: rubricName,
            total_score: 0,
            total_autograde_score: 0,
            tweak: 0,
            released: false
          })
          .select("id")
          .single();

        if (created?.id) {
          submissionReviewId = Number(created.id);
        } else {
          // Handle potential race: if insert failed due to conflict, try fetching again once
          const { data: sr2 } = await supabaseClient
            .from("submission_reviews")
            .select("id")
            .eq("submission_id", restOfData.submission_id)
            .eq("rubric_id", restOfData.rubric_id)
            .single();

          if (sr2?.id) {
            submissionReviewId = Number(sr2.id);
          } else {
            toaster.error({
              title: "Error creating review assignment",
              description:
                insertError?.message ||
                (selectError?.message ?? "Failed to find or create submission review for this submission and rubric.")
            });
            return;
          }
        }
      }
    } catch (e) {
      toaster.error({
        title: "Error creating review assignment",
        description: e instanceof Error ? e.message : "Unable to look up or create submission review."
      });
      return;
    }

    const valuesToSubmit = {
      ...restOfData,
      class_id: courseId,
      assignment_id: assignmentId,
      submission_review_id: submissionReviewId,
      due_date: restOfData.due_date,
      release_date: restOfData.release_date || undefined,
      max_allowable_late_tokens:
        restOfData.max_allowable_late_tokens === undefined || restOfData.max_allowable_late_tokens === null
          ? undefined
          : Number(restOfData.max_allowable_late_tokens)
    };

    try {
      if (isEditing && initialData?.id) {
        reviewAssignmentId = initialData.id;
        await updateReviewAssignment({
          resource: "review_assignments",
          id: reviewAssignmentId,
          values: valuesToSubmit,
          successNotification: {
            message: "Review assignment updated successfully.",
            type: "success"
          },
          errorNotification: {
            message: "Error updating review assignment.",
            type: "error"
          }
        });
        mainOperationSuccessful = true; // If it doesn't throw, it's successful
      } else {
        const createdReviewAssignment = await createReviewAssignment({
          resource: "review_assignments",
          values: valuesToSubmit,
          successNotification: {
            message: "Review assignment created successfully.",
            type: "success"
          },
          errorNotification: {
            message: "Error creating review assignment.",
            type: "error"
          }
        });
        if (!createdReviewAssignment.data?.id) {
          toaster.error({ title: "Error", description: "Failed to get ID of the created review assignment." });
          rubricPartsOperationSuccessful = false;
        } else {
          reviewAssignmentId = createdReviewAssignment.data.id;
          mainOperationSuccessful = true;
        }
      }

      // Proceed with rubric parts only if main operation was successful and ID is available
      if (mainOperationSuccessful && reviewAssignmentId !== undefined) {
        const newSelectedRubricPartIds = rubric_part_ids || [];

        if (supabaseClient) {
          // 1. Delete existing review_assignment_rubric_parts
          const { error: deleteError } = await supabaseClient
            .from("review_assignment_rubric_parts")
            .delete()
            .eq("review_assignment_id", reviewAssignmentId);

          if (deleteError) {
            toaster.error({
              title: "Error updating rubric parts",
              description: `Could not remove old associations: ${deleteError.message}`
            });
            rubricPartsOperationSuccessful = false;
          } else {
            // 2. Insert the new ones if delete was successful
            if (newSelectedRubricPartIds.length > 0) {
              const partsToCreate = newSelectedRubricPartIds.map((partId) => ({
                review_assignment_id: reviewAssignmentId!,
                rubric_part_id: partId,
                class_id: courseId
              }));

              let creationErrorsInLoop = false;
              for (const partToCreate of partsToCreate) {
                try {
                  await createReviewAssignmentRubricPart({
                    resource: "review_assignment_rubric_parts",
                    values: partToCreate,
                    successNotification: false,
                    errorNotification: (error) => {
                      creationErrorsInLoop = true;
                      return {
                        message: `Failed to associate rubric part (ID: ${partToCreate.rubric_part_id}): ${error?.message || "Unknown error"}`,
                        type: "error"
                      };
                    }
                  });
                } catch (partCreateError) {
                  creationErrorsInLoop = true;
                  toaster.error({
                    title: `Error associating rubric part (ID: ${partToCreate.rubric_part_id})`,
                    description: `${partCreateError instanceof Error ? partCreateError.message : String(partCreateError)}`
                  });
                }
              }
              if (creationErrorsInLoop) {
                rubricPartsOperationSuccessful = false;
                toaster.error({
                  id: "batch-rubric-part-error",
                  title: "Error saving some rubric parts",
                  description:
                    "Not all rubric part associations could be saved. Please check notifications for details."
                });
              }
            }
          }
        } else {
          toaster.create({
            title: "Configuration Warning",
            description:
              "Could not manage specific rubric parts due to a setup issue. Skipping delete/create of parts.",
            type: "warning"
          });
          rubricPartsOperationSuccessful = false;
        }
      } else if (reviewAssignmentId === undefined && mainOperationSuccessful) {
        rubricPartsOperationSuccessful = false;
      }
    } catch (error) {
      mainOperationSuccessful = false;
      toaster.error({
        title: "Error in review assignment submission process",
        description: error instanceof Error ? error.message : "An unknown error occurred during the main operation."
      });
    } finally {
      if (mainOperationSuccessful && rubricPartsOperationSuccessful) {
        onSuccess();
      }
      onClose(); // Always close the modal
    }
  };

  useEffect(() => {
    const gradingRubricId = assignmentData?.data?.grading_rubric_id ?? undefined;
    const defaults: Partial<ReviewAssignmentFormData> =
      isEditing && initialData
        ? {
            assignee_profile_id: initialData.assignee_profile_id,
            submission_id: initialData.submission_id,
            rubric_id: initialData.rubric_id ?? gradingRubricId,
            due_date: initialData.due_date ? format(new TZDate(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : "",
            rubric_part_ids:
              initialData.review_assignment_rubric_parts
                ?.map((p) => p.rubric_parts.id)
                .filter((id): id is number => id !== null && id !== undefined) || [],
            release_date: initialData.release_date
              ? format(new TZDate(initialData.release_date), "yyyy-MM-dd'T'HH:mm")
              : undefined,
            max_allowable_late_tokens: initialData.max_allowable_late_tokens ?? 0
          }
        : {
            max_allowable_late_tokens: 0,
            rubric_part_ids: [],
            assignee_profile_id: undefined,
            submission_id: undefined,
            rubric_id: gradingRubricId,
            due_date: "",
            release_date: undefined
          };
    resetForm(defaults as ReviewAssignmentFormData);
  }, [isEditing, initialData, resetForm, assignmentData]);

  return (
    <DialogRoot
      open={isOpen}
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Review Assignment" : "Assign New Review"}</DialogTitle>
          <DialogCloseTrigger aria-label="Close dialog">
            <FaPlus style={{ transform: "rotate(45deg)" }} />
          </DialogCloseTrigger>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit(onSubmitHandler)} id="review-assignment-form">
            <VStack gap={4} p={4} align="stretch">
              <Field label="Submission" invalid={!!errors.submission_id}>
                <Controller
                  name="submission_id"
                  control={control}
                  rules={{ required: "Submission is required" }}
                  render={({ field }) => (
                    <ChakraReactSelect
                      {...field}
                      inputId="submission_id"
                      options={submissionsOptions}
                      isLoading={isLoadingSubmissions || isLoadingReviewAssignments}
                      placeholder="Select Submission..."
                      onChange={(option) => field.onChange(option?.value)}
                      value={
                        Array.isArray(submissionsOptions)
                          ? submissionsOptions
                              .flatMap((group) => group.options)
                              .find((opt) => opt.value === field.value)
                          : undefined
                      }
                      chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                    />
                  )}
                />
                {errors.submission_id && (
                  <Text color="red.500" fontSize="sm">
                    {errors.submission_id.message}
                  </Text>
                )}
              </Field>

              <Field label="Assignee" invalid={!!errors.assignee_profile_id}>
                <Controller
                  name="assignee_profile_id"
                  control={control}
                  rules={{ required: "Assignee is required" }}
                  render={({ field }) => (
                    <ChakraReactSelect
                      {...field}
                      inputId="assignee_profile_id"
                      options={assigneeOptions}
                      isLoading={
                        isLoadingCourseUsers ||
                        isLoadingGradingConflicts ||
                        (!!selectedSubmissionId && isLoadingSubmissions)
                      }
                      placeholder={
                        selectedSubmissionId ? "Select Assignee..." : "Select Submission first to see Assignees"
                      }
                      isDisabled={!selectedSubmissionId || isLoadingCourseUsers || isLoadingGradingConflicts}
                      onChange={(option) => field.onChange(option?.value)}
                      value={assigneeOptions.find((opt) => opt.value === field.value)}
                      chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                    />
                  )}
                />
                {errors.assignee_profile_id && (
                  <Text color="red.500" fontSize="sm">
                    {errors.assignee_profile_id.message}
                  </Text>
                )}
              </Field>

              <Field label="Rubric" invalid={!!errors.rubric_id}>
                <Controller
                  name="rubric_id"
                  control={control}
                  rules={{ required: "Rubric is required" }}
                  render={({ field }) => (
                    <ChakraReactSelect
                      {...field}
                      inputId="rubric_id"
                      options={rubricOptions}
                      isLoading={isLoadingAssignment || isLoadingRubrics}
                      placeholder={
                        isLoadingAssignment
                          ? "Loading assignment info..."
                          : rubricOptions.length === 0
                            ? "No rubric specified for this assignment"
                            : "Select Rubric..."
                      }
                      onChange={(option) => field.onChange(option?.value)}
                      value={rubricOptions.find((opt) => opt.value === field.value)}
                      chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                    />
                  )}
                />
                {errors.rubric_id && (
                  <Text color="red.500" fontSize="sm">
                    {errors.rubric_id.message}
                  </Text>
                )}
              </Field>

              <Field label="Due Date" invalid={!!errors.due_date}>
                <Input
                  id="due_date"
                  type="datetime-local"
                  {...control.register("due_date", { required: "Due date is required" })}
                />
                {errors.due_date && (
                  <Text color="red.500" fontSize="sm">
                    {errors.due_date.message}
                  </Text>
                )}
              </Field>

              <Field label="Specific Rubric Parts (Optional)" invalid={!!errors.rubric_part_ids}>
                <Controller
                  name="rubric_part_ids"
                  control={control}
                  render={({ field }) => (
                    <ChakraReactSelect
                      isMulti
                      {...field}
                      inputId="rubric_part_ids"
                      options={rubricPartOptions}
                      isLoading={selectedRubricId !== undefined && isLoadingRubricParts}
                      isDisabled={!selectedRubricId || isLoadingRubricParts}
                      placeholder={!selectedRubricId ? "Select a Rubric first" : "Select specific parts..."}
                      onChange={(options: readonly { label: string; value: number }[] | null) =>
                        field.onChange(options ? options.map((opt) => opt.value) : [])
                      }
                      value={rubricPartOptions.filter((opt) => field.value?.includes(opt.value))}
                      chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                    />
                  )}
                />
                {errors.rubric_part_ids && (
                  <Text color="red.500" fontSize="sm">
                    {errors.rubric_part_ids.message}
                  </Text>
                )}
              </Field>

              {/* <Field label="Release Date (Optional)" invalid={!!errors.release_date}>
                <Input id="release_date" type="datetime-local" {...control.register("release_date")} />
                {errors.release_date && (
                  <Text color="red.500" fontSize="sm">
                    {errors.release_date.message}
                  </Text>
                )}
              </Field> */}

              {/* <Field label="Max Late Tokens (Optional)" invalid={!!errors.max_allowable_late_tokens}>
                <Input
                  id="max_allowable_late_tokens"
                  type="number"
                  {...control.register("max_allowable_late_tokens", { valueAsNumber: true })}
                />
                {errors.max_allowable_late_tokens && (
                  <Text color="red.500" fontSize="sm">
                    {errors.max_allowable_late_tokens.message}
                  </Text>
                )}
              </Field> */}
            </VStack>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" colorPalette="red" mr={3} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="review-assignment-form" loading={isSubmitting} colorPalette="green">
            {isEditing ? "Save Changes" : "Assign Review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
