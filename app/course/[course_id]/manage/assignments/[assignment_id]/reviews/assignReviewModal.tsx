"use client";

import { createClient } from "@/utils/supabase/client";
import { Input, Text, VStack } from "@chakra-ui/react";
import { type HttpError, useCreate, useList, useUpdate } from "@refinedev/core";
import { Select as ChakraReactSelect } from "chakra-react-select";
import { format } from "date-fns";
import { useEffect, useMemo } from "react";
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
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { TZDate } from "@date-fns/tz";
import type { PopulatedReviewAssignment } from "./ReviewsTable";

// Type definitions
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];

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
  const selectedSubmissionId = watch("submission_id");

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

  const { data: submissionsData, isLoading: isLoadingSubmissions } = useList<PopulatedSubmission>({
    resource: "submissions",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "assignment_id", operator: "eq", value: assignmentId },
      { field: "is_active", operator: "eq", value: true }
    ],
    meta: {
      select: "*, profiles!profile_id(id, name), assignment_groups(id, name)"
    },
    queryOptions: { enabled: isOpen }
  });

  const assigneeOptions = useMemo(() => {
    if (!courseUsersData?.data) return [];

    let availableAssignees = courseUsersData.data;

    if (selectedSubmissionId && submissionsData?.data && gradingConflictsData?.data) {
      const selectedSubmission = submissionsData.data.find((sub) => sub.id === selectedSubmissionId);
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
  }, [courseUsersData, selectedSubmissionId, submissionsData, gradingConflictsData]);

  const submissionsOptions = useMemo(() => {
    return (
      submissionsData?.data.map((sub) => {
        let label = `Submission ID: ${sub.id}`;
        if (sub.assignment_groups?.name) {
          label = `Group: ${sub.assignment_groups.name} (Submission ID: ${sub.id})`;
        } else if (sub.profiles?.name) {
          label = `Student: ${sub.profiles.name} (Submission ID: ${sub.id})`;
        }
        return { value: sub.id, label };
      }) || []
    );
  }, [submissionsData]);

  const { data: rubricsData, isLoading: isLoadingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    meta: { select: "id, name, review_round" },
    queryOptions: {
      enabled: isOpen && !!assignmentId
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

  const onSubmitHanlder = async (data: ReviewAssignmentFormData) => {
    const { rubric_part_ids, ...restOfData } = data;
    let reviewAssignmentId: number | undefined = undefined;
    let mainOperationSuccessful = false;
    let rubricPartsOperationSuccessful = true; // Assume success unless proven otherwise

    const valuesToSubmit = {
      ...restOfData,
      class_id: courseId,
      assignment_id: assignmentId,
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
          // No further operations can proceed without reviewAssignmentId
          rubricPartsOperationSuccessful = false;
          // mainOperationSuccessful remains false
        } else {
          reviewAssignmentId = createdReviewAssignment.data.id;
          mainOperationSuccessful = true; // If it doesn't throw and ID is present
        }
      }

      // Proceed with rubric parts only if main operation was potentially successful and ID is available
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
                // A general toast for loop errors, specific ones are handled by errorNotification or catch
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
          rubricPartsOperationSuccessful = false; // Cannot manage parts without client
        }
      } else if (reviewAssignmentId === undefined && mainOperationSuccessful) {
        // This case should ideally be caught by the !createdReviewAssignment.data?.id check earlier
        // but as a fallback, if mainOp was flagged successful but ID is missing.
        rubricPartsOperationSuccessful = false;
      }
    } catch (error) {
      // This primarily catches errors from createReviewAssignment/updateReviewAssignment
      // if they throw an error not handled by their own errorNotification.
      // mainOperationSuccessful will remain false or be set to false.
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
    resetForm(
      isEditing && initialData
        ? {
            assignee_profile_id: initialData.assignee_profile_id,
            submission_id: initialData.submission_id,
            rubric_id: initialData.rubric_id,
            due_date: initialData.due_date ? format(new TZDate(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : "",
            rubric_part_ids: initialData.review_assignment_rubric_parts?.map((p) => p.rubric_parts.id) || [],
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
            rubric_id: undefined,
            due_date: "",
            release_date: undefined
          }
    );
  }, [isEditing, initialData, resetForm]);

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
          <form onSubmit={handleSubmit(onSubmitHanlder)} id="review-assignment-form">
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
                      isLoading={isLoadingSubmissions}
                      placeholder="Select Submission..."
                      onChange={(option) => field.onChange(option?.value)}
                      value={submissionsOptions.find((opt) => opt.value === field.value)}
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
                      isLoading={isLoadingRubrics}
                      placeholder={
                        isLoadingRubrics
                          ? "Loading rubrics..."
                          : rubricOptions.length === 0
                            ? "No rubrics available for this assignment"
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
                      isLoading={isLoadingRubricParts}
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

              <Field label="Release Date (Optional)" invalid={!!errors.release_date}>
                <Input id="release_date" type="datetime-local" {...control.register("release_date")} />
                {errors.release_date && (
                  <Text color="red.500" fontSize="sm">
                    {errors.release_date.message}
                  </Text>
                )}
              </Field>

              <Field label="Max Late Tokens (Optional)" invalid={!!errors.max_allowable_late_tokens}>
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
              </Field>
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
