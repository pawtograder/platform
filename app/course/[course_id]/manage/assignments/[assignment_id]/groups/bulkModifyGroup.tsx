import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Button, Dialog, Field, Flex, Portal, Text } from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useInvalidate } from "@refinedev/core";
import { RolesWithProfilesAndGroupMemberships } from "./page";
import { useParams } from "next/navigation";
import { assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { toaster } from "@/components/ui/toaster";

export default function BulkModifyGroup({
  groups,
  assignment,
  profiles
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
  profiles: RolesWithProfilesAndGroupMemberships[];
}) {
  const supabase = createClient();
  const invalidate = useInvalidate();

  const [selectedMembers, setSelectedMembers] = useState<
    MultiValue<{ value: RolesWithProfilesAndGroupMemberships; label: string | null }>
  >([]);

  const [findStrategy, setFindStrategy] = useState<string>("");
  const [groupToMod, setGroupToMod] = useState<AssignmentGroupWithMembersInvitationsAndJoinRequests | null>(null);
  const { course_id } = useParams();
  const [chosenStudentHasGroup, setChosenStudentHasGroup] = useState<boolean>(true);

  const addSelectedToGroup = async () => {
    if (!groupToMod) {
      console.log("no group");
      return;
    }
    selectedMembers.forEach(async (member) => {
      await updateGroupForStudent(groupToMod, member.value);
    });
  };
  const updateGroupForStudent = async (
    group: AssignmentGroupWithMembersInvitationsAndJoinRequests | undefined,
    student: RolesWithProfilesAndGroupMemberships
  ) => {
    try {
      await assignmentGroupInstructorMoveStudent(
        {
          new_assignment_group_id: group?.id || null,
          old_assignment_group_id:
            student.profiles.assignment_groups_members.length > 0
              ? student.profiles.assignment_groups_members[0].assignment_group_id
              : null,
          profile_id: student.private_profile_id,
          class_id: Number(course_id)
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
    invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
  };

  return (
    <Dialog.Root key={"center"} placement={"center"} motionPreset="slide-in-bottom">
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          Bulk Modify Group
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Bulk Modify Group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex flexDir="column" gap="15px">
                <Field.Root>
                  <Field.Label>Find group by</Field.Label>
                  <Select
                    onChange={(e) => {
                      setGroupToMod(null);
                      setFindStrategy(e?.value ?? "");
                    }}
                    options={[
                      { value: "by_member", label: "Member" },
                      { value: "by_team_name", label: "Group name" }
                    ]}
                  />
                </Field.Root>
                {findStrategy === "by_member" && (
                  <Field.Root invalid={!chosenStudentHasGroup}>
                    <Field.Label>Search students</Field.Label>
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
                        group to add them to first, or create a new group.
                      </Field.ErrorText>
                    )}
                  </Field.Root>
                )}{" "}
                {findStrategy === "by_team_name" && (
                  <Field.Root>
                    <Field.Label>Search groups</Field.Label>
                    <Select
                      onChange={(e) => setGroupToMod(groups.find((group) => group.id === e?.value) ?? null)}
                      options={groups.map((group) => ({ value: group.id, label: group.name }))}
                    />
                  </Field.Root>
                )}
                {groupToMod && (
                  <>
                    <Flex flexDir="column" justifyContent={"left"}>
                      <Text>Name: {groupToMod.name}</Text>
                      <Text>Current member count: {groupToMod.assignment_groups_members?.length ?? 0}</Text>
                    </Flex>

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
                        options={profiles?.map((profile: RolesWithProfilesAndGroupMemberships) => ({
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
                    setFindStrategy("");
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
                      addSelectedToGroup();
                    }}
                  >
                    {" "}
                    Assign
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
