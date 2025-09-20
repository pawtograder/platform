"use client";

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
import { Box, Text, VStack, Input } from "@chakra-ui/react";
import { HttpError, useList, useOne, useUpdate } from "@refinedev/core";
import { Select as ChakraReactSelect } from "chakra-react-select";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaPlus } from "react-icons/fa";
import { PopulatedReviewAssignment } from "./ReviewsTable";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"] & {
  profiles?: Pick<ProfileRow, "id" | "name">;
};
type GradingConflictRow = Database["public"]["Tables"]["grading_conflicts"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
};

type UpdateAssigneeData = {
  assignee_profile_id: string;
  due_date: string;
};

type EditReviewAssignmentModalProps = {
  isOpen: boolean;
  onCloseAction: () => void;
  courseId: number;
  onSuccessAction: () => void;
  initialData: PopulatedReviewAssignment;
};

export default function EditReviewAssignmentModal({
  isOpen,
  onCloseAction,
  courseId,
  onSuccessAction,
  initialData
}: EditReviewAssignmentModalProps) {
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    register
  } = useForm<UpdateAssigneeData>({
    defaultValues: {
      assignee_profile_id: initialData.assignee_profile_id,
      due_date: initialData.due_date ? format(new TZDate(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : ""
    }
  });

  useEffect(() => {
    reset({
      assignee_profile_id: initialData.assignee_profile_id,
      due_date: initialData.due_date ? format(new TZDate(initialData.due_date), "yyyy-MM-dd'T'HH:mm") : ""
    });
  }, [initialData, reset]);

  const { mutateAsync: updateReviewAssignment } = useUpdate<ReviewAssignmentRow, HttpError, UpdateAssigneeData>();

  // Load course users (graders and instructors)
  const { data: courseUsersData, isLoading: isLoadingCourseUsers } = useList<UserRoleRow>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "role", operator: "in", value: ["grader", "instructor"] }
    ],
    meta: { select: "private_profile_id, profiles!user_roles_private_profile_id_fkey!inner(id, name)" },
    queryOptions: { enabled: isOpen }
  });

  // Load grading conflicts to exclude conflicted graders
  const { data: gradingConflictsData, isLoading: isLoadingGradingConflicts } = useList<GradingConflictRow>({
    resource: "grading_conflicts",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    queryOptions: { enabled: isOpen }
  });

  // Load the specific submission for this assignment
  const { data: selectedSubmissionData, isLoading: isLoadingSelectedSubmission } = useOne<PopulatedSubmission>({
    resource: "submissions",
    id: initialData.submission_id,
    meta: {
      select:
        "*, profiles!profile_id(id, name), assignment_groups(id, name, assignment_groups_members(*,profiles!profile_id(*)))"
    },
    queryOptions: { enabled: isOpen && !!initialData.submission_id }
  });

  const assigneeOptions = useMemo(() => {
    if (!courseUsersData?.data) return [];

    let availableAssignees = courseUsersData.data;

    const selectedSubmission = selectedSubmissionData?.data;
    if (selectedSubmission && gradingConflictsData?.data) {
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

    return availableAssignees.map((userRole) => ({
      value: userRole.private_profile_id,
      label: userRole.profiles?.name
        ? `${userRole.profiles.name}`
        : `Name Missing (User ID: ${userRole.private_profile_id})`
    }));
  }, [courseUsersData, selectedSubmissionData, gradingConflictsData]);

  const onSubmitHandler = async (data: UpdateAssigneeData) => {
    try {
      await updateReviewAssignment({
        resource: "review_assignments",
        id: initialData.id,
        values: { assignee_profile_id: data.assignee_profile_id, due_date: data.due_date },
        successNotification: false,
        errorNotification: false
      });
      toaster.success({ title: "Review assignment updated", description: "Assignee and due date saved." });
      onSuccessAction();
    } catch (error) {
      toaster.error({
        title: "Error updating review assignment",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      onCloseAction();
    }
  };

  const submissionLabel = useMemo(() => {
    const sub = selectedSubmissionData?.data;
    if (!sub) return `Submission ID: ${initialData.submission_id}`;
    if (sub.assignment_groups?.name) return `Group: ${sub.assignment_groups.name}`;
    if (sub.profiles?.name) return `Student: ${sub.profiles.name}`;
    return `Submission ID: ${sub.id}`;
  }, [selectedSubmissionData, initialData.submission_id]);

  const rubricName = initialData.rubrics?.name || `Rubric ID: ${initialData.rubric_id}`;
  const rubricPartsText =
    initialData.review_assignment_rubric_parts?.map((p) => p.rubric_parts.name).join(", ") || "All";

  return (
    <DialogRoot
      open={isOpen}
      onOpenChange={(details) => {
        if (!details.open) onCloseAction();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Review Assignment</DialogTitle>
          <DialogCloseTrigger aria-label="Close dialog">
            <FaPlus style={{ transform: "rotate(45deg)" }} />
          </DialogCloseTrigger>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit(onSubmitHandler)} id="edit-review-assignment-form">
            <VStack gap={4} p={4} align="stretch">
              <Box>
                <Text fontWeight="bold">Submission</Text>
                <Text>{submissionLabel}</Text>
              </Box>

              <Box>
                <Text fontWeight="bold">Rubric</Text>
                <Text>{rubricName}</Text>
              </Box>

              <Box>
                <Text fontWeight="bold">Rubric Parts</Text>
                <Text>{rubricPartsText}</Text>
              </Box>

              <Field label="Due Date" invalid={!!errors.due_date}>
                <Input
                  id="due_date"
                  type="datetime-local"
                  {...register("due_date", { required: "Due date is required" })}
                />
                {errors.due_date && (
                  <Text color="red.500" fontSize="sm">
                    {errors.due_date.message}
                  </Text>
                )}
              </Field>

              <Field label="New Assignee" invalid={!!errors.assignee_profile_id}>
                <Controller
                  name="assignee_profile_id"
                  control={control}
                  rules={{ required: "Assignee is required" }}
                  render={({ field }) => (
                    <ChakraReactSelect
                      {...field}
                      inputId="assignee_profile_id_edit"
                      options={assigneeOptions}
                      isLoading={isLoadingCourseUsers || isLoadingGradingConflicts || isLoadingSelectedSubmission}
                      placeholder={"Select Assignee..."}
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
            </VStack>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" colorPalette="red" mr={3} onClick={onCloseAction}>
            Cancel
          </Button>
          <Button type="submit" form="edit-review-assignment-form" loading={isSubmitting} colorPalette="green">
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
