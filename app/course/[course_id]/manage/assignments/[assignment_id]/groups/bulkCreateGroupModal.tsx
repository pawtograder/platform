import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import {
  Button,
  Dialog,
  DialogActionTrigger,
  Field,
  Flex,
  Heading,
  NumberInput,
  Portal,
  Table
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { useStudentRoster } from "@/hooks/useClassProfiles";
import { GroupCreateData, useGroupManagement } from "./GroupManagementContext";
import { createClient } from "@/utils/supabase/client";

export function useUngroupedStudentProfiles(groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[]) {
  const students = useStudentRoster();
  const ungroupedProfiles = useMemo(() => {
    if (!groups) {
      return [];
    }
    return students.filter(
      (p: { is_private_profile: boolean; id: string }) =>
        p.is_private_profile && !groups.some((g) => g.assignment_groups_members.some((m) => m.profile_id === p.id))
    );
  }, [students, groups]);
  return ungroupedProfiles;
}

export default function BulkCreateGroup({
  groups,
  assignment
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  const [groupTextField, setGroupTextField] = useState<string>("");
  const [groupSize, setGroupSize] = useState<number>(0);
  const ungroupedProfiles = useUngroupedStudentProfiles(groups);
  const [generatedGroups, setGeneratedGroups] = useState<GroupCreateData[]>([]);
  const { addGroupsToCreate } = useGroupManagement();
  const supabase = createClient();
  /**
   * When group field is changed to a new number, update groupsize
   */
  useEffect(() => {
    if (typeof parseInt(groupTextField) === "number") {
      setGroupSize(parseInt(groupTextField));
    }
  }, [setGroupTextField]);

  const generateGroups = async () => {
    const newGroups = [];
    // shuffle ungrouped profiles
    for (let i = ungroupedProfiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ungroupedProfiles[i], ungroupedProfiles[j]] = [ungroupedProfiles[j], ungroupedProfiles[i]];
    }
    // create as many even groups as possible
    let index = 0;
    while (index <= ungroupedProfiles.length - groupSize) {
      const response = await supabase.rpc("generate_anon_name");
      newGroups.push({
        name: response.data ?? "",
        member_ids: ungroupedProfiles.slice(index, index + groupSize).map((profile) => {
          return profile.id;
        })
      });
      index += groupSize;
    }
    // spread extras across created groups
    while (index < ungroupedProfiles.length && newGroups.length > 0) {
      const createdGroup: GroupCreateData = newGroups.pop()!;
      createdGroup?.member_ids.push(ungroupedProfiles[index].id);
      newGroups.push(createdGroup);
      index += 1;
    }
    setGeneratedGroups(newGroups);
  };

  const isGroupSizeInvalid = (size: number) => {
    return size > (assignment.max_group_size ?? ungroupedProfiles.length) || size < (assignment.min_group_size ?? 1);
  };

  return (
    <Dialog.Root key={"center"} placement={"center"} motionPreset="slide-in-bottom" size="lg">
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          Bulk Create Groups
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Bulk Create Groups</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex flexDir="column" gap="10px">
                <Heading size="md">
                  {ungroupedProfiles.length} student profile{ungroupedProfiles.length !== 1 ? "s are" : " is"}{" "}
                  unassigned for this assignment.
                </Heading>
                <Field.Root invalid={isGroupSizeInvalid(groupSize)}>
                  <Field.Label>How many students would you like in each group?</Field.Label>
                  <NumberInput.Root
                    value={groupTextField}
                    onValueChange={(e) => {
                      setGroupTextField(e.value);
                      setGroupSize(e.valueAsNumber);
                    }}
                  >
                    <NumberInput.Input />
                  </NumberInput.Root>
                  <Field.ErrorText>
                    Warning: Groups for this assignment should be in range {assignment.min_group_size ?? "1"} -{" "}
                    {assignment.max_group_size ?? ungroupedProfiles.length}
                  </Field.ErrorText>
                  <Field.HelperText>In the case of an uneven number, we will prefer larger groups.</Field.HelperText>
                </Field.Root>
                <Button onClick={() => generateGroups()} colorPalette={"gray"} disabled={Number.isNaN(groupSize)}>
                  Generate Groups
                </Button>
                {generatedGroups.length > 0 && (
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Name</Table.ColumnHeader>
                        <Table.ColumnHeader>Members</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {generatedGroups.map((group, index) => {
                        return (
                          <Table.Row key={index}>
                            <Table.Cell>{group.name}</Table.Cell>
                            <Table.Cell>
                              {group.member_ids.map(
                                (member_id) =>
                                  ungroupedProfiles?.find((prof) => {
                                    return prof.id == member_id;
                                  })?.name + " "
                              )}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                )}
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Flex gap="var(--chakra-spacing-3)">
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline" colorPalette={"gray"}>
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <DialogActionTrigger asChild>
                  <Button
                    onClick={() => addGroupsToCreate(generatedGroups)}
                    colorPalette={"green"}
                    disabled={generatedGroups.length === 0}
                  >
                    Stage changes
                  </Button>
                </DialogActionTrigger>
              </Flex>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
