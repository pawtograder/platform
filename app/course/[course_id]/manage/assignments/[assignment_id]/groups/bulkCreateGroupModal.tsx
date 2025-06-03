import {
  Assignment,
  AssignmentGroupWithMembersInvitationsAndJoinRequests,
  Tag,
  UserRole
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
import { useStudentRoster } from "@/hooks/useClassProfiles";
import { GroupCreateData, useGroupManagement } from "./GroupManagementContext";
import { createClient } from "@/utils/supabase/client";
import { Select } from "chakra-react-select";
import useTags from "@/hooks/useTags";
import { useList } from "@refinedev/core";

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
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  /**
   * When group field is changed to a new number, update groupsize
   */
  useEffect(() => {
    if (typeof parseInt(groupTextField) === "number") {
      setGroupSize(parseInt(groupTextField));
    }
  }, [setGroupTextField, groupTextField]);

  const { data: user_roles } = useList<UserRole>({
    resource: "user_roles",
    filters: [{ field: "class_id", operator: "eq", value: assignment.class_id }]
  });

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

  const generateGroupWithTags = async () => {
    const newGroups = [];
    // shuffle ungrouped profiles
    for (let i = ungroupedProfiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ungroupedProfiles[i], ungroupedProfiles[j]] = [ungroupedProfiles[j], ungroupedProfiles[i]];
    }

    const tagMap = new Map<string, string[]>();
    const noTagKey = crypto.randomUUID();
    for (const profile of ungroupedProfiles) {
      const userRole = user_roles?.data.find((role) => {
        return role.public_profile_id == profile.id || role.private_profile_id == profile.id;
      });
      const tag = tags.find((tag) => {
        return (
          (tag.profile_id == userRole?.public_profile_id || tag.profile_id == userRole?.private_profile_id) &&
          selectedTags.includes(tag.name)
        );
      });
      if (!tag) {
        const existing = tagMap.get(noTagKey) ?? [];
        existing.push(profile.id);
        tagMap.set(noTagKey, existing);
      } else {
        const existing = tagMap.get(tag.name) ?? [];
        existing.push(profile.id);
        tagMap.set(tag.name, existing);
      }
    }

    // create as many even groups as possible
    for (const tagGroupName of tagMap.keys()) {
      let index = 0;
      const tagGroup = tagMap.get(tagGroupName) ?? [];
      while (index <= tagGroup.length - groupSize) {
        const response = await supabase.rpc("generate_anon_name");
        newGroups.push({
          name: response.data ?? "",
          member_ids: tagGroup.slice(index, index + groupSize),
          tagName: tagGroupName !== noTagKey ? tagGroupName : undefined
        });
        index += groupSize;
      }
      while (index < tagGroup.length && newGroups.length > 0) {
        const createdGroup: GroupCreateData = newGroups.pop()!;
        createdGroup?.member_ids.push(tagGroup[index]);
        newGroups.push(createdGroup);
        index += 1;
      }
      tagMap.set(tagGroupName, tagGroup);
    }
    setGeneratedGroups(newGroups);
  };

  const isGroupSizeInvalid = (size: number) => {
    return size > (assignment.max_group_size ?? ungroupedProfiles.length) || size < (assignment.min_group_size ?? 1);
  };

  const { tags } = useTags();

  const uniqueTags: Tag[] = Array.from(
    tags
      .reduce((map, tag) => {
        if (!map.has(tag.name + tag.color + tag.visible)) {
          map.set(tag.name + tag.color + tag.visible, tag);
        }
        return map;
      }, new Map())
      .values()
  );

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
                <Field.Root>
                  <Field.Label>Select tags to separate students by (optional)</Field.Label>
                  <Select
                    isMulti={true}
                    onChange={(e) => {
                      setSelectedTags(
                        Array.from(e.values()).map((val) => {
                          return val.value;
                        })
                      );
                    }}
                    options={uniqueTags.map((tag) => ({ label: tag.name, value: tag.name }))}
                  />
                  <Field.HelperText>If a student has multiple of these tags, we will group them with the tag entered first.</Field.HelperText>
                </Field.Root>

                <Button
                  onClick={() => (selectedTags.length > 0 ? generateGroupWithTags() : generateGroups())}
                  colorPalette={"gray"}
                  disabled={Number.isNaN(groupSize)}
                >
                  Generate Groups
                </Button>
                {generatedGroups.length > 0 && (
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Name</Table.ColumnHeader>
                        <Table.ColumnHeader>Members</Table.ColumnHeader>
                        <Table.ColumnHeader>Tag</Table.ColumnHeader>
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
                            <Table.Cell>{group.tagName}</Table.Cell>
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
