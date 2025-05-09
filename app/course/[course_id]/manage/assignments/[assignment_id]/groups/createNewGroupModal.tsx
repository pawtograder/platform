import { useUngroupedProfiles } from "@/app/course/[course_id]/assignments/[assignment_id]/manageGroupWidget";
import { toaster } from "@/components/ui/toaster";
import { assignmentGroupCreate, EdgeFunctionError } from "@/lib/edgeFunctions";
import {
  Assignment,
  AssignmentGroupWithMembersInvitationsAndJoinRequests
} from "@/utils/supabase/DatabaseTypes";
import { Button, Dialog, Field, Flex, Input, Portal } from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useInvalidate } from "@refinedev/core";

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
  const [selectedMembers, setSelectedMembers] = useState<MultiValue<{ label: string | null; value: string }>>([]);
  const ungroupedProfiles = useUngroupedProfiles(groups);

  const createGroupWithAssignees = async () => {
    assignmentGroupCreate(
      {
        course_id: assignment.class_id,
        assignment_id: assignment.id,
        name: newGroupName,
        invitees: selectedMembers.map((member) => member.value)
      },
      supabase
    )
      .then(() => {
        toaster.create({ title: "Group created", description: "", type: "success" });
        setNewGroupName("");
        invalidate({ resource: "assignment_groups", invalidates: ["all"] });
        invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
        invalidate({ resource: "assignment_group_invitations", invalidates: ["all"] });
      })
      .catch((e) => {
        if (e instanceof EdgeFunctionError) {
          toaster.create({ title: "Error: " + e.message, description: e.details, type: "error" });
        }
      });
  };
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
                      generate a random group id
                    </Button>
                  </Field.Label>
                  <Input name="name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
                  <Field.ErrorText>
                    The name must consist only of alphanumeric, hyphens, or underscores, and be less than 36 characters.
                  </Field.ErrorText>
                </Field.Root>
                <Field.Root
                  invalid={
                    (assignment.min_group_size !== null && selectedMembers.length < assignment.min_group_size) ||
                    (assignment.max_group_size !== null && selectedMembers.length > assignment.max_group_size)
                  }
                >
                  <Field.Label>Select unassigned students to place in the group</Field.Label>
                  <Select
                    onChange={(e) => setSelectedMembers(e)}
                    isMulti={true}
                    options={ungroupedProfiles.map((p) => ({ label: p.name, value: p.id }))}
                  />
                  <Field.ErrorText>
                    Groups for this assignment must contain minimum ${assignment.min_group_size ?? "1"} and maximum $
                    {assignment.max_group_size ?? "any"} members.
                  </Field.ErrorText>
                </Field.Root>
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" colorPalette={"gray"}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button onClick={createGroupWithAssignees} colorPalette={"green"}>
                Save
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
