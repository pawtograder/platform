import { toaster } from "@/components/ui/toaster";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Button, Dialog, Field, Flex, Input, Portal } from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useInvalidate } from "@refinedev/core";
import { useUngroupedStudentProfiles } from "./bulkCreateGroupModal";
import { assignmentGroupInstructorCreateGroup, assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { useCourseController } from "@/hooks/useCourseController";

export default function CreateNewGroup({
  groups,
  assignment
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  const supabase = createClient();
  const invalidate = useInvalidate();
  const [newGroupName, setNewGroupName] = useState<string>("");
  const [selectedMembers, setSelectedMembers] = useState<
    MultiValue<{
      label: string | null;
      value: string;
    }>
  >([]);
  const { courseId } = useCourseController();
  const ungroupedProfiles = useUngroupedStudentProfiles(groups);

  /**
   * Draft using edge functions instead
   */
  const createAssignment = async () => {
    try {
      const { id } = await assignmentGroupInstructorCreateGroup(
        {
          name: newGroupName,
          course_id: courseId,
          assignment_id: assignment.id
        },
        supabase
      );
      selectedMembers.map(async (member) => {
        try {
          await assignmentGroupInstructorMoveStudent(
            {
              new_assignment_group_id: id || null,
              old_assignment_group_id: null,
              profile_id: member.value,
              class_id: Number(courseId)
            },
            supabase
          );
          toaster.create({ title: "Student moved", description: "", type: "success" });
        } catch (e) {
          console.error(e);
          toaster.create({
            title: "Error moving student",
            description: e instanceof Error ? e.message : "Unknown error",
            type: "error"
          });
        }
      });
      toaster.create({ title: "New group created", description: "", type: "success" });
      setNewGroupName("");
      invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
      invalidate({ resource: "user_roles", invalidates: ["list"] });
      invalidate({ resource: "profiles", invalidates: ["all", "list"] });
      invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
      invalidate({ resource: "assignment_group_invitations", invalidates: ["all", "list"] });
    } catch (e) {
      console.error(e);
      toaster.create({
        title: "Error creating group",
        description: e instanceof Error ? e.message : "Unknown error",
        type: "error"
      });
    }
  };

  const createGroupWithAssignees = async () => {
    const { data: createdGroup } = await supabase
      .from("assignment_groups")
      .insert({
        name: newGroupName,
        assignment_id: assignment.id,
        class_id: assignment.class_id
      })
      .select("id")
      .single();
    selectedMembers.map((member) => {
      assignMemberToGroup(member, createdGroup);
    });
    toaster.create({ title: "Group created", description: "", type: "success" });
    setNewGroupName("");
    invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
    invalidate({ resource: "user_roles", invalidates: ["list"] });
    invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
    invalidate({ resource: "assignment_group_invitations", invalidates: ["all", "list"] });
  };

  const assignMemberToGroup = async (
    member: { label?: string | null; value: string },
    createdGroup: { id: number } | null
  ) => {
    const supabase = createClient();

    if (!createdGroup) {
      return;
    }
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user?.id || !createdGroup?.id) {
      return;
    }
    await supabase.from("assignment_groups_members").insert({
      added_by: member.value,
      assignment_group_id: createdGroup?.id,
      profile_id: member.value,
      class_id: assignment.class_id,
      assignment_id: assignment.id
    });
  };

  function isGroupInvalid() {
    return (
      (assignment.min_group_size !== null && selectedMembers.length < assignment.min_group_size) ||
      (assignment.max_group_size !== null && selectedMembers.length > assignment.max_group_size)
    );
  }
  return (
    <Dialog.Root key={"center"} placement={"center"} motionPreset="slide-in-bottom">
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          Create New Group
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Create New Group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex flexDir="column" gap="15px">
                <Field.Root invalid={newGroupName.length > 0 && !/^[a-zA-Z0-9_-]{1,36}$/.test(newGroupName)}>
                  <Field.Label>
                    Choose a name for the group or
                    <Button
                      size="sm"
                      colorPalette={"gray"}
                      onClick={() => {
                        setNewGroupName(crypto.randomUUID());
                      }}
                    >
                      generate a random name
                    </Button>
                  </Field.Label>
                  <Input name="name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
                  <Field.ErrorText>
                    The name must consist only of alphanumeric, hyphens, or underscores, and be less than 36 characters.
                  </Field.ErrorText>
                </Field.Root>
                <Field.Root invalid={isGroupInvalid()}>
                  <Field.Label>Select unassigned students to place in the group</Field.Label>
                  <Select
                    onChange={(e) => setSelectedMembers(e)}
                    isMulti={true}
                    options={ungroupedProfiles.map((p) => ({ label: p.name, value: p.id }))}
                  />
                  <Field.ErrorText>
                    Warning: Groups for this assignment should contain minimum {assignment.min_group_size ?? "1"} and
                    maximum {assignment.max_group_size ?? "any"} members.
                  </Field.ErrorText>
                </Field.Root>
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Flex gap="var(--chakra-spacing-3)">
                <Dialog.ActionTrigger asChild>
                  <Button
                    variant="outline"
                    colorPalette={"gray"}
                    onClick={() => {
                      setNewGroupName("");
                      setSelectedMembers([]);
                    }}
                  >
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <Dialog.ActionTrigger asChild>
                  <Button
                    onClick={createGroupWithAssignees}
                    colorPalette={"green"}
                    disabled={newGroupName.length === 0}
                  >
                    Assign
                  </Button>
                </Dialog.ActionTrigger>
              </Flex>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
