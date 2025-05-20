import PersonName from "@/components/ui/person-name";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Button, Dialog, Field, Flex, Portal, SegmentGroup } from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { useGroupManagement } from "./GroupManagementContext";
import { RolesWithProfilesAndGroupMemberships } from "./page";

export default function BulkModifyGroup({
  groups,
  assignment,
  profiles
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
  profiles: RolesWithProfilesAndGroupMemberships[];
}) {
  const [selectedMembers, setSelectedMembers] = useState<
    MultiValue<{ value: RolesWithProfilesAndGroupMemberships; label: string | null }>
  >([]);
  const { addMovesToFulfill } = useGroupManagement();

  const [findStrategy, setFindStrategy] = useState<"by_member" | "by_team_name">("by_team_name");
  const [groupToMod, setGroupToMod] = useState<AssignmentGroupWithMembersInvitationsAndJoinRequests | null>(null);
  const [chosenStudentHasGroup, setChosenStudentHasGroup] = useState<boolean>(true);

  return (
    <Dialog.Root key={"center"} placement={"center"} motionPreset="slide-in-bottom">
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          Tweak a Group
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Tweak a Group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex flexDir="column" gap="15px">
                <Field.Root>
                  <SegmentGroup.Root
                    value={findStrategy}
                    onValueChange={(details) => {
                      setGroupToMod(null);
                      setFindStrategy(details.value as "by_member" | "by_team_name");
                    }}
                  >
                    <SegmentGroup.Indicator />
                    <SegmentGroup.Item value="by_member">
                      <SegmentGroup.ItemText>Find group by student</SegmentGroup.ItemText>
                      <SegmentGroup.ItemHiddenInput />
                    </SegmentGroup.Item>
                    <SegmentGroup.Item value="by_team_name">
                      <SegmentGroup.ItemText>Find group by name</SegmentGroup.ItemText>
                      <SegmentGroup.ItemHiddenInput />
                    </SegmentGroup.Item>
                  </SegmentGroup.Root>
                </Field.Root>
                {findStrategy === "by_member" && (
                  <Field.Root invalid={!chosenStudentHasGroup}>
                    <Field.Label>Select a student to add others to their group</Field.Label>
                    <Select
                      id="chosen_student"
                      onChange={(e) => {
                        setChosenStudentHasGroup(
                          e?.value.profiles.assignment_groups_members[0] === undefined ? false : true
                        );
                        setGroupToMod(
                          groups.find(
                            (group) => group.id === e?.value.profiles.assignment_groups_members[0]?.assignment_group_id
                          ) ?? null
                        );
                      }}
                      options={profiles?.map((profile: RolesWithProfilesAndGroupMemberships) => ({
                        value: profile,
                        label: profile.profiles.name
                      }))}
                    />
                    {!chosenStudentHasGroup && (
                      <Field.ErrorText>
                        The user you have selected is not currently in a group. To group this user, either select a
                        group to add them to, or create a new group.
                      </Field.ErrorText>
                    )}
                  </Field.Root>
                )}{" "}
                {findStrategy === "by_team_name" && (
                  <Field.Root>
                    <Field.Label>Select a group to add students to</Field.Label>
                    <Select
                      onChange={(e) => setGroupToMod(groups.find((group) => group.id === e?.value) ?? null)}
                      options={groups.map((group) => ({ value: group.id, label: group.name }))}
                    />
                  </Field.Root>
                )}
                {groupToMod && (
                  <>
                    <Field.Root>
                      <Field.Label>Group name</Field.Label>
                      {groupToMod.name}
                    </Field.Root>
                    <Field.Root>
                      <Field.Label>Current members ({groupToMod.assignment_groups_members.length})</Field.Label>
                      {groupToMod.assignment_groups_members?.map((member) => (
                        <PersonName key={member.id} uid={member.profile_id} />
                      ))}
                    </Field.Root>
                    <Field.Root
                      invalid={
                        selectedMembers.length + groupToMod.assignment_groups_members?.length >
                        (assignment.max_group_size ?? Infinity)
                      }
                    >
                      <Field.Label>Select students to move to this group</Field.Label>
                      <Select
                        onChange={(e) => {
                          setSelectedMembers(e);
                        }}
                        isMulti={true}
                        options={profiles
                          ?.filter((profile) => {
                            return (
                              profile.profiles.assignment_groups_members[0] === undefined ||
                              profile.profiles.assignment_groups_members[0].assignment_group_id !== groupToMod.id
                            );
                          })
                          .map((profile: RolesWithProfilesAndGroupMemberships) => ({
                            value: profile,
                            label: profile.profiles.name
                          }))}
                      />
                      <Field.ErrorText>
                        Warning: Adding {selectedMembers.length} new student{selectedMembers.length !== 1 ? "s" : ""} to
                        this group will make the group larger than the maximum group size of {assignment.max_group_size}{" "}
                        for this assignment
                      </Field.ErrorText>
                    </Field.Root>
                  </>
                )}
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Flex gap="var(--chakra-spacing-3)">
                <Dialog.CloseTrigger
                  asChild
                  onClick={() => {
                    setGroupToMod(null);
                    setSelectedMembers([]);
                    setFindStrategy("by_team_name");
                  }}
                >
                  <Button variant="outline" colorPalette={"gray"}>
                    Cancel
                  </Button>
                </Dialog.CloseTrigger>
                <Dialog.CloseTrigger asChild>
                  <Button
                    colorPalette={"green"}
                    disabled={selectedMembers.length == 0 || groupToMod == null}
                    onClick={() => {
                      if (groupToMod) {
                        addMovesToFulfill(
                          selectedMembers.map((member) => {
                            return {
                              profile_id: member.value.private_profile_id,
                              old_group_id: member.value.profiles.assignment_groups_members[0].id,
                              new_group_id: groupToMod.id
                            };
                          })
                        );
                      }
                    }}
                  >
                    {" "}
                    Stage changes
                  </Button>
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
