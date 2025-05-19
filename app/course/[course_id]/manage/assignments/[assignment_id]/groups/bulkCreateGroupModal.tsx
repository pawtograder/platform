import { toaster } from "@/components/ui/toaster";
import {
  Assignment,
  AssignmentGroupWithMembersInvitationsAndJoinRequests,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
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
import { createClient } from "@/utils/supabase/client";
import { useInvalidate } from "@refinedev/core";
import { useStudentRoster } from "@/hooks/useClassProfiles";
import { assignmentGroupInstructorCreateGroup, assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { useCourseController } from "@/hooks/useCourseController";

type SampleGroup = {
  name: string;
  members: UserProfile[];
};

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
  const supabase = createClient();
  const invalidate = useInvalidate();
  const { courseId } = useCourseController();
  const [groupTextField, setGroupTextField] = useState<string>("");
  const [groupSize, setGroupSize] = useState<number>(0);
  const ungroupedProfiles = useUngroupedStudentProfiles(groups);
  const [generatedGroups, setGeneratedGroups] = useState<SampleGroup[]>([]);

  /**
   * When group field is changed to a new number, update groupsize
   */
  useEffect(() => {
    if (typeof parseInt(groupTextField) === "number") {
      setGroupSize(parseInt(groupTextField));
    }
  }, [setGroupTextField]);

  const createGroupsWithAssignees = async () => {
    generatedGroups.forEach(async (group) => {
      await createGroupWithAssignees(group);
    });
    invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
    invalidate({ resource: "user_roles", invalidates: ["all", "list"] });
    invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
    invalidate({ resource: "assignment_group_invitations", invalidates: ["all", "list"] });
    toaster.create({ title: "Groups created", description: "", type: "success" });
  };

  /**
   * put this where create group with assignees is
   * @param group
   */
  const createAssignment = async (group: SampleGroup) => {
    try {
      const { id } = await assignmentGroupInstructorCreateGroup(
        {
          name: group.name,
          course_id: courseId,
          assignment_id: assignment.id
        },
        supabase
      );
      group.members.map(async (member) => {
        try {
          await assignmentGroupInstructorMoveStudent(
            {
              new_assignment_group_id: id || null,
              old_assignment_group_id: null,
              profile_id: member.id,
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
    } catch (e) {
      console.error(e);
      toaster.create({
        title: "Error creating group",
        description: e instanceof Error ? e.message : "Unknown error",
        type: "error"
      });
    }
  };

  const createGroupWithAssignees = async (group: SampleGroup) => {
    const { data: createdGroup } = await supabase
      .from("assignment_groups")
      .insert({
        name: group.name,
        assignment_id: assignment.id,
        class_id: assignment.class_id
      })
      .select("id")
      .single();

    if (!createdGroup?.id) {
      return;
    }
    group.members.map((member) => {
      assignMemberToGroup(member, createdGroup);
    });
  };

  const assignMemberToGroup = async (member: UserProfile, createdGroup: { id: number } | null) => {
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
      added_by: member.id,
      assignment_group_id: createdGroup?.id,
      profile_id: member.id,
      class_id: assignment.class_id,
      assignment_id: assignment.id
    });
  };

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
      newGroups.push({ name: crypto.randomUUID(), members: ungroupedProfiles.slice(index, index + groupSize) });
      index += groupSize;
    }
    // spread extras across created groups
    while (index < ungroupedProfiles.length && newGroups.length > 0) {
      const createdGroup: SampleGroup = newGroups.pop()!;
      createdGroup?.members.push(ungroupedProfiles[index]);
      newGroups.push(createdGroup);
      index += 1;
    }
    setGeneratedGroups(newGroups);
  };

  function isGroupSizeInvalid(size: number) {
    return size > (assignment.max_group_size ?? ungroupedProfiles.length) || size < (assignment.min_group_size ?? 1);
  }

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
                            <Table.Cell>{group.members.map((member) => member.name + " ")}</Table.Cell>
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
                    onClick={createGroupsWithAssignees}
                    colorPalette={"green"}
                    disabled={generatedGroups.length === 0}
                  >
                    Assign these groups
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
