"use client";

import { useMemo } from "react";
import {
  Heading,
  IconButton,
  Container,
  HStack,
  Table,
  useDisclosure,
  VStack,
  Text,
  Spinner,
  Input
} from "@chakra-ui/react";
import * as Dialog from "@/components/ui/dialog";
import * as Field from "@/components/ui/field";
import { useList, useDelete, useCreate, HttpError, CreateResponse } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaTrash, FaEdit, FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import PersonName from "@/components/ui/person-name";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useForm, Controller } from "react-hook-form";
import { Select as ChakraReactSelect } from "chakra-react-select";

// Type definitions
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
  assignments?: AssignmentRow;
};

type PopulatedReviewAssignment = ReviewAssignmentRow & {
  profiles?: ProfileRow;
  submissions?: PopulatedSubmission;
  rubrics?: RubricRow;
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

// Main Page Component
export default function ReviewAssignmentsPage() {
  const { course_id, assignment_id } = useParams();
  const { open, onOpen, onClose } = useDisclosure();

  const {
    data: reviewAssignmentsData,
    isLoading: isLoadingReviewAssignments,
    refetch
  } = useList<PopulatedReviewAssignment>({
    resource: "review_assignments",
    filters: [{ field: "assignment_id", operator: "eq", value: Number(assignment_id) }],
    sorters: [{ field: "created_at", order: "desc" }],
    meta: {
      select:
        "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*))"
    }
  });

  const { mutate: deleteReviewAssignment } = useDelete();

  const handleDelete = (id: number) => {
    deleteReviewAssignment(
      {
        resource: "review_assignments",
        id: id
      },
      {
        onSuccess: () => {
          toaster.create({ title: "Review assignment deleted", type: "success" });
          refetch();
        },
        onError: (error) => {
          toaster.create({ title: "Error deleting review assignment", description: error.message, type: "error" });
        }
      }
    );
  };

  const reviewAssignments = useMemo(() => reviewAssignmentsData?.data || [], [reviewAssignmentsData]);

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <HStack justifyContent="space-between" mb={4}>
        <Heading size="lg">Manage Review Assignments</Heading>
        <Button onClick={onOpen} variant="solid" colorPalette="blue">
          <FaPlus style={{ marginRight: "8px" }} /> Assign Reviews
        </Button>
      </HStack>

      {isLoadingReviewAssignments && <Spinner />}
      {!isLoadingReviewAssignments && reviewAssignments.length === 0 && (
        <Text>No review assignments found for this assignment.</Text>
      )}

      {!isLoadingReviewAssignments && reviewAssignments.length > 0 && (
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Assignee</Table.ColumnHeader>
              <Table.ColumnHeader>Submission (Student/Group)</Table.ColumnHeader>
              <Table.ColumnHeader>Rubric</Table.ColumnHeader>
              <Table.ColumnHeader>Due Date</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {reviewAssignments.map((ra) => {
              const submission = ra.submissions;
              let submitterName = "N/A";
              if (submission) {
                if (submission.assignment_groups && submission.assignment_groups.name) {
                  submitterName = `Group: ${submission.assignment_groups.name}`;
                } else if (submission.profiles && submission.profiles.name) {
                  submitterName = submission.profiles.name;
                } else {
                  submitterName = `Submission ID: ${submission.id}`;
                }
              }
              // Since ReviewAssignmentRow does not have a status, we default to Pending for display for now
              const displayStatus = "Pending";

              return (
                <Table.Row key={ra.id}>
                  <Table.Cell>
                    {ra.profiles?.name ? <PersonName uid={ra.assignee_profile_id} /> : ra.assignee_profile_id}
                  </Table.Cell>
                  <Table.Cell>{submitterName}</Table.Cell>
                  <Table.Cell>{ra.rubrics?.name || "N/A"}</Table.Cell>
                  <Table.Cell>{ra.due_date ? new Date(ra.due_date).toLocaleDateString() : "N/A"}</Table.Cell>
                  <Table.Cell>{displayStatus}</Table.Cell>
                  <Table.Cell textAlign="center">
                    <HStack gap={1} justifyContent="center">
                      <IconButton
                        aria-label="Edit review assignment"
                        variant="ghost"
                        size="sm"
                        onClick={() => toaster.create({ title: "Edit not implemented yet.", type: "info" })}
                      >
                        <FaEdit />
                      </IconButton>
                      <PopConfirm
                        triggerLabel="Delete review assignment"
                        confirmHeader="Delete Review Assignment"
                        confirmText="Are you sure you want to delete this review assignment?"
                        onConfirm={() => handleDelete(ra.id)}
                        onCancel={() => {}}
                        trigger={
                          <IconButton aria-label="Delete review assignment" colorScheme="red" variant="ghost" size="sm">
                            <FaTrash />
                          </IconButton>
                        }
                      />
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      )}
      <AssignReviewModal
        isOpen={open}
        onClose={onClose}
        courseId={Number(course_id)}
        assignmentId={Number(assignment_id)}
        onSuccess={refetch}
      />
    </Container>
  );
}

function AssignReviewModal({
  isOpen,
  onClose,
  courseId,
  assignmentId,
  onSuccess
}: {
  isOpen: boolean;
  onClose: () => void;
  courseId: number;
  assignmentId: number;
  onSuccess: () => void;
}) {
  const {
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    reset,
    watch
  } = useForm<ReviewAssignmentFormData>({
    defaultValues: {
      max_allowable_late_tokens: 0
    }
  });

  const { mutateAsync: createReviewAssignment } = useCreate<ReviewAssignmentRow, HttpError, ReviewAssignmentFormData>();

  const selectedRubricId = watch("rubric_id");

  const { data: courseUsersData, isLoading: isLoadingCourseUsers } = useList<
    ProfileRow & { user_roles: Array<Pick<UserRoleRow, "role" | "class_id">> }
  >({
    resource: "profiles",
    filters: [
      { field: "user_roles.class_id", operator: "eq", value: courseId },
      { field: "user_roles.role", operator: "in", value: ["grader", "instructor"] }
    ],
    meta: { select: "id, name, user_roles!inner(role, class_id)" },
    queryOptions: {
      enabled: isOpen
    }
  });

  const assigneeOptions = useMemo(
    () =>
      courseUsersData?.data
        .filter(
          (user) =>
            user.user_roles &&
            user.user_roles.some(
              (role) => role.class_id === courseId && (role.role === "instructor" || role.role === "grader")
            )
        )
        .map((user) => ({ label: user.name || user.id, value: user.id })) || [],
    [courseUsersData, courseId]
  );

  const { data: submissionsData, isLoading: isLoadingSubmissions } = useList<PopulatedSubmission>({
    resource: "submissions",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    meta: { select: "id, profile_id, assignment_group_id, profiles!profile_id(id, name), assignment_groups(id, name)" },
    queryOptions: { enabled: isOpen }
  });
  const submissionOptions = useMemo(
    () =>
      submissionsData?.data.map((sub) => {
        let label = `Submission ID: ${sub.id}`;
        if (sub.assignment_groups && sub.assignment_groups.name) {
          label = `Group: ${sub.assignment_groups.name} (ID: ${sub.id})`;
        } else if (sub.profiles && sub.profiles.name) {
          label = `Student: ${sub.profiles.name} (ID: ${sub.id})`;
        }
        return { label, value: sub.id };
      }) || [],
    [submissionsData]
  );

  const { data: rubricsData, isLoading: isLoadingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    meta: { select: "id, name, review_round" },
    queryOptions: { enabled: isOpen }
  });
  const rubricOptions = useMemo(
    () =>
      rubricsData?.data.map((rubric) => ({
        label: `${rubric.name || `Rubric ID ${rubric.id}`} (${rubric.review_round || "N/A"})`,
        value: rubric.id
      })) || [],
    [rubricsData]
  );

  const { data: rubricPartsData, isLoading: isLoadingRubricParts } = useList<
    Database["public"]["Tables"]["rubric_parts"]["Row"]
  >({
    resource: "rubric_parts",
    filters: [{ field: "rubric_id", operator: "eq", value: selectedRubricId }],
    queryOptions: { enabled: !!selectedRubricId && isOpen },
    meta: { select: "id, name" }
  });

  const rubricPartOptions = useMemo(
    () => rubricPartsData?.data.map((part) => ({ label: part.name || `Part ID ${part.id}`, value: part.id })) || [],
    [rubricPartsData]
  );

  const onSubmitHanlder = async (data: ReviewAssignmentFormData) => {
    try {
      // Prepare the values, being careful with optional fields
      const valuesToSubmit: ReviewAssignmentFormData & { assignment_id: number; class_id: number } = {
        assignee_profile_id: data.assignee_profile_id!,
        submission_id: data.submission_id!,
        rubric_id: data.rubric_id!,
        assignment_id: assignmentId,
        class_id: courseId,
        // Optional fields from ReviewAssignmentFormData are handled below
        due_date: data.due_date,
        rubric_part_ids:
          data.rubric_part_ids && data.rubric_part_ids.length > 0
            ? data.rubric_part_ids.map((id) => Number(id))
            : undefined,
        release_date: data.release_date,
        max_allowable_late_tokens:
          data.max_allowable_late_tokens !== undefined && data.max_allowable_late_tokens !== null
            ? data.max_allowable_late_tokens
            : 0
      };

      // Clean up undefined optional fields if the backend expects them to be absent
      if (valuesToSubmit.due_date === undefined || valuesToSubmit.due_date === "") {
        delete valuesToSubmit.due_date;
      }
      if (valuesToSubmit.rubric_part_ids === undefined) {
        delete valuesToSubmit.rubric_part_ids;
      }
      if (valuesToSubmit.release_date === undefined || valuesToSubmit.release_date === "") {
        delete valuesToSubmit.release_date;
      }
      // max_allowable_late_tokens is defaulted to 0, so it should always be present unless we want to omit it if 0.
      // For now, assume 0 is a valid value to send.

      await createReviewAssignment({
        resource: "review_assignments",
        values: valuesToSubmit,
        successNotification: (response?: CreateResponse<ReviewAssignmentRow>) => ({
          message: "Review Assigned",
          description: `Successfully assigned review. ID: ${response?.data?.id || "N/A"}`,
          type: "success"
        }),
        errorNotification: (error?: HttpError) => ({
          message: "Error Assigning Review",
          description: error?.message || "An unknown error occurred.",
          type: "error"
        })
      });
      onSuccess();
      onClose();
      reset();
    } catch {
      // Error is handled by errorNotification
    }
  };

  const handleModalOpenChange = (details: { open: boolean }) => {
    if (!details.open) {
      onClose();
      reset();
    }
  };

  return (
    <Dialog.DialogRoot open={isOpen} onOpenChange={handleModalOpenChange}>
      <Dialog.DialogContent as="form" onSubmit={handleSubmit(onSubmitHanlder)}>
        <Dialog.DialogHeader>
          <Dialog.DialogTitle>Assign New Review</Dialog.DialogTitle>
          <Dialog.DialogCloseTrigger onClick={onClose} />
        </Dialog.DialogHeader>
        <Dialog.DialogBody>
          <VStack gap={4} align="stretch">
            <Field.Field
              label="Assignee"
              invalid={!!errors.assignee_profile_id}
              required
              errorText={errors.assignee_profile_id?.message}
            >
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
                  />
                )}
              />
            </Field.Field>

            <Field.Field
              label="Submission"
              invalid={!!errors.submission_id}
              required
              errorText={errors.submission_id?.message}
            >
              <Controller
                name="submission_id"
                control={control}
                rules={{ required: "Submission is required" }}
                render={({ field }) => (
                  <ChakraReactSelect
                    {...field}
                    inputId="submission_id"
                    options={submissionOptions}
                    isLoading={isLoadingSubmissions}
                    placeholder="Select Submission..."
                    onChange={(option) => field.onChange(option?.value)}
                    value={submissionOptions.find((opt) => opt.value === field.value)}
                  />
                )}
              />
            </Field.Field>

            <Field.Field label="Rubric" invalid={!!errors.rubric_id} required errorText={errors.rubric_id?.message}>
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
                  />
                )}
              />
            </Field.Field>

            <Field.Field label="Due Date (Optional)" invalid={!!errors.due_date} errorText={errors.due_date?.message}>
              <Input id="due_date" type="datetime-local" {...control.register("due_date")} />
            </Field.Field>

            <Field.Field
              label="Specific Rubric Parts (Optional)"
              invalid={!!errors.rubric_part_ids}
              errorText={errors.rubric_part_ids?.message}
            >
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
                  />
                )}
              />
            </Field.Field>

            <Field.Field
              label="Release Date (Optional)"
              invalid={!!errors.release_date}
              errorText={errors.release_date?.message}
            >
              <Input id="release_date" type="datetime-local" {...control.register("release_date")} />
            </Field.Field>

            <Field.Field
              label="Max Late Tokens (Optional)"
              invalid={!!errors.max_allowable_late_tokens}
              errorText={errors.max_allowable_late_tokens?.message}
            >
              <Input
                id="max_allowable_late_tokens"
                type="number"
                {...control.register("max_allowable_late_tokens", { valueAsNumber: true })}
              />
            </Field.Field>
          </VStack>
        </Dialog.DialogBody>
        <Dialog.DialogFooter>
          <Button
            variant="ghost"
            mr={3}
            onClick={() => {
              onClose();
              reset();
            }}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} colorPalette="blue" variant="solid">
            Assign Review
          </Button>
        </Dialog.DialogFooter>
      </Dialog.DialogContent>
    </Dialog.DialogRoot>
  );
}
