"use client";

import { useEffect, useMemo } from "react";
import { HttpError, useCreate, useList, useUpdate } from "@refinedev/core";
import { useForm, Controller } from "react-hook-form";
import { format } from "date-fns";
import { VStack, Text, Input, IconButton } from "@chakra-ui/react";
import { Select as ChakraReactSelect } from "chakra-react-select";
import { FaPlus } from "react-icons/fa";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { Field } from "@/components/ui/field";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Type definitions - Copied from page.tsx, might need pruning if some are not used directly here
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"];
type SubmissionReviewRow = Database["public"]["Tables"]["submission_reviews"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
  assignments?: AssignmentRow;
  submission_reviews?: SubmissionReviewRow[];
};

type PopulatedReviewAssignment = ReviewAssignmentRow & {
  profiles?: ProfileRow;
  submissions?: PopulatedSubmission;
  rubrics?: RubricRow;
  meta: {
    select: "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews(completed_at, grader, rubric_id, submission_id))";
  };
  review_assignment_rubric_parts?: { rubric_part_id: number }[]; // Added this based on usage in defaultValues
};

type ReviewAssignmentFormData = {
  assignee_profile_id: string;
  submission_id: number;
  rubric_id: number;
  due_date?: string;
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
  initialData?: PopulatedReviewAssignment | null;
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
            due_date: initialData.due_date ? format(new Date(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : undefined,
            rubric_part_ids: initialData.review_assignment_rubric_parts?.map((p) => p.rubric_part_id) || [],
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
            due_date: undefined,
            release_date: undefined
          }
  });

  const { mutateAsync: createReviewAssignment } = useCreate<ReviewAssignmentRow, HttpError, ReviewAssignmentFormData>();
  const { mutateAsync: updateReviewAssignment } = useUpdate<ReviewAssignmentRow, HttpError, ReviewAssignmentFormData>();

  const selectedRubricId = watch("rubric_id");

  const { data: courseUsersData, isLoading: isLoadingCourseUsers } = useList<UserRoleRow>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "role", operator: "in", value: ["grader", "instructor"] }
    ],
    meta: { select: "private_profile_id" },
    queryOptions: { enabled: isOpen }
  });

  const assigneeOptions = useMemo(
    () =>
      courseUsersData?.data.map((userRole) => ({
        value: userRole.private_profile_id,
        label: `User ID: ${userRole.private_profile_id}` // Consider fetching profile names for better UX
      })) || [],
    [courseUsersData]
  );

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
  const submissionsOptions = useMemo(() => {
    return (
      submissionsData?.data.map((sub) => {
        let label = `Submission ID: ${sub.id}`;
        if (sub.assignment_groups?.name) {
          label = `Group: ${sub.assignment_groups.name} (ID: ${sub.id})`;
        } else if (sub.profiles?.name) {
          label = `Student: ${sub.profiles.name} (ID: ${sub.id})`;
        }
        return { value: sub.id, label };
      }) || []
    );
  }, [submissionsData]);

  const { data: rubricsData, isLoading: isLoadingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    meta: { select: "id, name, review_round" },
    queryOptions: { enabled: isOpen }
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
    const valuesToSubmit = {
      ...data,
      class_id: courseId,
      assignment_id: assignmentId,
      due_date: data.due_date || undefined,
      release_date: data.release_date || undefined,
      max_allowable_late_tokens:
        data.max_allowable_late_tokens === undefined || data.max_allowable_late_tokens === null
          ? undefined
          : Number(data.max_allowable_late_tokens)
    };

    try {
      if (isEditing && initialData?.id) {
        const { ...updateValues } = valuesToSubmit;
        await updateReviewAssignment({
          resource: "review_assignments",
          id: initialData.id,
          values: updateValues,
          successNotification: {
            message: "Review assignment updated successfully.",
            type: "success"
          },
          errorNotification: {
            message: "Error updating review assignment.",
            type: "error"
          }
        });
      } else {
        await createReviewAssignment({
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
      }
      onSuccess();
      onClose();
    } catch (error) {
      toaster.error({
        title: "Error in submission",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  useEffect(() => {
    resetForm(
      isEditing && initialData
        ? {
            assignee_profile_id: initialData.assignee_profile_id,
            submission_id: initialData.submission_id,
            rubric_id: initialData.rubric_id,
            due_date: initialData.due_date ? format(new Date(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : undefined,
            rubric_part_ids: initialData.review_assignment_rubric_parts?.map((p) => p.rubric_part_id) || [],
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
            due_date: undefined,
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
          <DialogCloseTrigger asChild>
            <IconButton aria-label="Close dialog" variant="ghost">
              <FaPlus style={{ transform: "rotate(45deg)" }} />
            </IconButton>
          </DialogCloseTrigger>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit(onSubmitHanlder)} id="review-assignment-form">
            <VStack gap={4} p={4} align="stretch">
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
                      isLoading={isLoadingCourseUsers}
                      placeholder="Select Assignee..."
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
                      placeholder="Select Rubric..."
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

              <Field label="Due Date (Optional)" invalid={!!errors.due_date}>
                <Input id="due_date" type="datetime-local" {...control.register("due_date")} />
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
          <Button variant="ghost" mr={3} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="review-assignment-form" loading={isSubmitting} colorPalette="blue">
            {isEditing ? "Save Changes" : "Assign Review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
