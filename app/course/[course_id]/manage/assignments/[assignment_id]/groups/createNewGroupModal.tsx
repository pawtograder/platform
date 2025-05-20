import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Button, Dialog, Field, Flex, Input, Portal } from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { useUngroupedStudentProfiles } from "./bulkCreateGroupModal";
import { useGroupManagement } from "./GroupManagementContext";

export default function CreateNewGroup({
  groups,
  assignment
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  const [newGroupName, setNewGroupName] = useState<string>("");
  const [selectedMembers, setSelectedMembers] = useState<
    MultiValue<{
      label: string | null;
      value: string;
    }>
  >([]);
  const ungroupedProfiles = useUngroupedStudentProfiles(groups);
  const { addGroupsToCreate } = useGroupManagement();
  const isGroupInvalid = () => {
    return (
      (assignment.min_group_size !== null && selectedMembers.length < assignment.min_group_size) ||
      (assignment.max_group_size !== null && selectedMembers.length > assignment.max_group_size)
    );
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
                      onClick={async () => {
                        setNewGroupName(crypto.randomUUID());
                        /* returns 200 OK but null data
                        supabase.rpc("generate_anon_name").then((response) => {
                          console.log(response);
                        });
                        */
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
                    onClick={() => {
                      addGroupsToCreate([
                        {
                          name: newGroupName,
                          member_ids: selectedMembers.map((member) => {
                            return member.value;
                          })
                        }
                      ]);
                      setNewGroupName("");
                      setSelectedMembers([]);
                    }}
                    colorPalette={"green"}
                    disabled={newGroupName.length === 0}
                  >
                    Stage changes
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
