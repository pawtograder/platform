"use client";

import UploadSubmission from "@/components/submissions/upload-submission";
import { useUserRolesWithProfiles } from "@/hooks/useCourseController";
import { Box, Button, CloseButton, Dialog, Field, Icon, Portal, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useMemo, useState } from "react";
import { FaUserPlus } from "react-icons/fa";

type Target = { profile_id?: string; assignment_group_id?: number };
type Option = { label: string; value: string };

/**
 * Instructor/grader control for `repo_mode='none'` assignments: pick a student
 * (or group) and upload a submission on their behalf. Works for students who
 * have no submission yet (they don't appear in the submissions table).
 */
export default function CreateSubmissionForStudentDialog({
  assignmentId,
  groupConfig,
  onSubmissionCreated
}: {
  assignmentId: number;
  groupConfig: "individual" | "groups" | "both";
  /**
   * Called after a submission is successfully created, so the parent can refresh
   * its submissions table. A manual submission for a student who previously had
   * none isn't an update to an existing row, so it doesn't arrive via realtime —
   * the parent must refetch or the table only reflects it after a page reload.
   */
  onSubmissionCreated?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<Option | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<Option | null>(null);

  const roles = useUserRolesWithProfiles();
  const { data: groupsData } = useList({
    resource: "assignment_groups",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: open && groupConfig !== "individual" }
  });

  const studentOptions: Option[] = useMemo(
    () =>
      roles
        .filter((r) => r.role === "student" && !r.disabled && r.private_profile_id)
        .map((r) => ({ label: r.profiles?.name ?? "Unknown student", value: r.private_profile_id as string }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [roles]
  );
  const groupOptions: Option[] = useMemo(
    () =>
      ((groupsData?.data ?? []) as { id: number; name: string }[]).map((g) => ({ label: g.name, value: String(g.id) })),
    [groupsData]
  );

  const showStudents = groupConfig !== "groups";
  const showGroups = groupConfig !== "individual";

  const reset = () => {
    setTarget(null);
    setSelectedStudent(null);
    setSelectedGroup(null);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        setOpen(d.open);
        if (!d.open) reset();
      }}
    >
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          <Icon as={FaUserPlus} /> Create submission for a student
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Create a submission on behalf of a student</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Text fontSize="sm" color="fg.muted">
                  Choose who this submission is for, then upload their file(s). This creates a new active submission for
                  them.
                </Text>
                {showStudents && (
                  <Field.Root>
                    <Field.Label>Student</Field.Label>
                    <Box w="100%">
                      <Select
                        isClearable
                        placeholder="Select a student…"
                        value={selectedStudent}
                        options={studentOptions}
                        onChange={(opt) => {
                          const o = (opt as Option | null) ?? null;
                          setSelectedStudent(o);
                          setSelectedGroup(null);
                          setTarget(o ? { profile_id: o.value } : null);
                        }}
                      />
                    </Box>
                  </Field.Root>
                )}
                {showGroups && (
                  <Field.Root>
                    <Field.Label>Group</Field.Label>
                    <Box w="100%">
                      <Select
                        isClearable
                        placeholder="Select a group…"
                        value={selectedGroup}
                        options={groupOptions}
                        onChange={(opt) => {
                          const o = (opt as Option | null) ?? null;
                          setSelectedGroup(o);
                          setSelectedStudent(null);
                          setTarget(o ? { assignment_group_id: Number(o.value) } : null);
                        }}
                      />
                    </Box>
                  </Field.Root>
                )}
                {target ? (
                  <UploadSubmission
                    assignmentId={assignmentId}
                    target={target}
                    helperText="Upload the file(s) this student submitted. They will become the student's active submission."
                    buttonLabel="Create submission"
                    onUploaded={async () => {
                      // Refresh the parent table before closing so the new
                      // submission is visible without a manual page reload.
                      await onSubmissionCreated?.();
                      setOpen(false);
                      reset();
                    }}
                  />
                ) : (
                  <Text fontSize="sm" color="fg.muted">
                    Select a {showStudents && showGroups ? "student or group" : showGroups ? "group" : "student"} to
                    upload files.
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
