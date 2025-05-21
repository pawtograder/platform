"use client";
import { toaster } from "@/components/ui/toaster";
import { assignmentGroupInstructorCreateGroup, assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  Link,
  NativeSelect,
  Portal,
  Skeleton,
  Spinner,
  Switch,
  Table,
  Text
} from "@chakra-ui/react";
import { useInvalidate, useList, useShow } from "@refinedev/core";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { useParams } from "next/navigation";
import { useState } from "react";
import BulkAssignGroup from "./bulkCreateGroupModal";
import BulkModifyGroup from "./bulkModifyGroup";
import CreateNewGroup from "./createNewGroupModal";
import {
  GroupCreateData,
  GroupManagementProvider,
  StudentMoveData,
  useGroupManagement
} from "./GroupManagementContext";

export type RolesWithProfilesAndGroupMemberships = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, profiles!private_profile_id(*,assignment_groups_members!assignment_groups_members_profile_id_fkey(*))"
>;

function AssignmentGroupsTable({ assignment, course_id }: { assignment: Assignment; course_id: number }) {
  const { data: groups } = useList<AssignmentGroupWithMembersInvitationsAndJoinRequests>({
    resource: "assignment_groups",
    meta: { select: "*, assignment_groups_members(*)" },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment.id }],
    pagination: { pageSize: 1000 },
    liveMode: "auto"
  });
  const { data: profiles } = useList<RolesWithProfilesAndGroupMemberships>({
    resource: "user_roles",
    meta: {
      select: "*, profiles!private_profile_id(*,assignment_groups_members!assignment_groups_members_profile_id_fkey(*))"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "role", operator: "eq", value: "student" },
      { field: "profiles.assignment_groups_members.assignment_id", operator: "eq", value: assignment.id }
    ],
    pagination: { pageSize: 1000 },
    liveMode: "auto"
  });
  const groupsData = groups?.data;
  const [loading, setLoading] = useState<boolean>(false);
  const [groupViewOn, setGroupViewOn] = useState<boolean>(false);
  const { groupsToCreate, movesToFulfill, clearGroupsToCreate, clearMovesToFulfill } = useGroupManagement();
  const invalidate = useInvalidate();

  const supabase = createClient();

  /**
   * Submits changes to all students
   */
  const publishChanges = async () => {
    // move students where staged
    movesToFulfill.forEach(async (move) => {
      await updateGroupForStudent(move);
    });
    // create groups where staged
    groupsToCreate.forEach(async (group) => {
      await createGroupWithStudents(group);
    });
    // clear context
    clearGroupsToCreate();
    clearMovesToFulfill();
    invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
    invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
    invalidate({ resource: "user_roles", invalidates: ["list"] });
  };

  /**
   * Create a new group for this assignment and add all students specified
   */
  const createGroupWithStudents = async (group: GroupCreateData) => {
    try {
      const { id } = await assignmentGroupInstructorCreateGroup(
        {
          name: group.name,
          course_id: course_id,
          assignment_id: assignment.id
        },
        supabase
      );
      group.member_ids.map(async (member_id) => {
        try {
          await assignmentGroupInstructorMoveStudent(
            {
              new_assignment_group_id: id || null,
              old_assignment_group_id: null,
              profile_id: member_id,
              class_id: course_id
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

  /**
   * Move student to the desired group
   */
  const updateGroupForStudent = async (move: StudentMoveData) => {
    try {
      setLoading(true);
      await assignmentGroupInstructorMoveStudent(
        {
          new_assignment_group_id: move.new_group_id,
          old_assignment_group_id: move.new_group_id,
          profile_id: move.profile_id,
          class_id: course_id
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
    } finally {
      setLoading(false);
    }
    invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
  };

  if (!groupsData || !assignment) {
    return (
      <Box>
        <Skeleton height="100px" />
      </Box>
    );
  }

  return (
    <Box>
      <Text fontSize="sm" color="text.muted">
        Minimum group size: {assignment.min_group_size}, Maximum group size: {assignment.max_group_size} (
        <Link href={`/course/${course_id}/manage/assignments/${assignment.id}/edit`}>Edit</Link>)
      </Text>
      {loading && (
        <Box
          position="fixed"
          top="0"
          left="0"
          width="100vw"
          height="100vh"
          backgroundColor="rgba(0, 0, 0, 0.5)"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Box textAlign="center">
            <Text fontSize="sm" color="text.muted">
              Moving students and updating GitHub permissions...
            </Text>
            <Spinner />
          </Box>
        </Box>
      )}

      <Flex flexDir={"column"} gap="10px">
        {groupsToCreate.length === 0 && movesToFulfill.length === 0 && (
          <Text fontSize="sm">There are no staged changes at this time</Text>
        )}
        {(groupsToCreate.length > 0 || movesToFulfill.length > 0) && (
          <Box m="4" borderRadius="md" border="1px solid" borderColor="border.info">
            <Heading size="md" w="100%" bg="bg.info" px="2" borderRadius="md">
              Pending Changes
            </Heading>
            <Box px="2" py="1">
              <Text fontSize="sm" color="text.muted">
                The following changes are staged and must be published to take effect. Unless published, they will not
                be saved if you navigate away from this page.
              </Text>
              {groupsToCreate.length > 0 && (
                <Flex flexDirection="column">
                  <Heading size="sm">Groups To Create:</Heading>
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Group</Table.ColumnHeader>
                        <Table.ColumnHeader>Members</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {groupsToCreate.map((group) => {
                        return (
                          <Table.Row key={group.name}>
                            <Table.Cell>{group.name}</Table.Cell>
                            <Table.Cell>
                              {group.member_ids.map((member_id, key) => {
                                return (
                                  profiles?.data?.find((prof: { private_profile_id: string }) => {
                                    return prof.private_profile_id == member_id;
                                  })?.profiles.name + (key < group.member_ids.length - 1 ? ", " : "")
                                );
                              })}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Flex>
              )}

              {movesToFulfill.length > 0 && (
                <Flex flexDirection="column">
                  <Heading size="sm">Students To Move:</Heading>
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Student</Table.ColumnHeader>
                        <Table.ColumnHeader>Current Group</Table.ColumnHeader>
                        <Table.ColumnHeader>New Group</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {movesToFulfill.map((move) => {
                        return (
                          <Table.Row key={move.profile_id}>
                            <Table.Cell>
                              {
                                profiles?.data?.find((prof: { private_profile_id: string }) => {
                                  return prof.private_profile_id == move.profile_id;
                                })?.profiles.name
                              }
                            </Table.Cell>
                            <Table.Cell>
                              {move.old_group_id === null
                                ? "not in group"
                                : groupsData.find((group) => {
                                    return group.id === move.old_group_id;
                                  })?.name}
                            </Table.Cell>
                            <Table.Cell>
                              {groupsData.find((group) => {
                                return group.id === move.new_group_id;
                              })?.name ?? "not in group"}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Flex>
              )}

              {(groupsToCreate.length !== 0 || movesToFulfill.length !== 0) && (
                <Flex gap="10px" pt="4" justifyContent="flex-end">
                  {movesToFulfill.length !== 0 && (
                    <Button
                      colorPalette={"red"}
                      variant="ghost"
                      onClick={() => {
                        clearMovesToFulfill();
                      }}
                    >
                      Clear Student Moves
                    </Button>
                  )}
                  {groupsToCreate.length !== 0 && (
                    <Button
                      colorPalette={"red"}
                      variant="ghost"
                      onClick={() => {
                        clearGroupsToCreate();
                      }}
                    >
                      Clear Groups To Create
                    </Button>
                  )}
                  <Button
                    colorPalette={"green"}
                    onClick={() => {
                      publishChanges();
                    }}
                  >
                    Publish Changes
                  </Button>
                </Flex>
              )}
            </Box>
          </Box>
        )}
      </Flex>
      <Box width="100%" height="10px">
        <Switch.Root
          height="1"
          float="right"
          size="md"
          checked={groupViewOn}
          onCheckedChange={(e) => setGroupViewOn(e.checked)}
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label>View by group</Switch.Label>
        </Switch.Root>
      </Box>

      <Text fontSize="sm" color="text.muted">
        This table allows you to tweak group configurations.{" "}
        <Text as="span" fontWeight="bold">
          Changes will be staged and must be published to take effect
        </Text>
      </Text>
      <Heading size="md" pt="10px">
        Options
      </Heading>
      <Flex gap="10px" flexDir={"row"} wrap={"wrap"}>
        <CreateNewGroup groups={groupsData} assignment={assignment} />
        <BulkAssignGroup groups={groupsData} assignment={assignment} />
        <BulkModifyGroup
          groups={groupsData}
          assignment={assignment}
          profiles={profiles?.data as RolesWithProfilesAndGroupMemberships[]}
        />
      </Flex>
      {groupViewOn ? (
        <TableByGroups assignment={assignment} profiles={profiles?.data} groupsData={groupsData} />
      ) : (
        <TableByStudents assignment={assignment} groupsData={groupsData} profiles={profiles?.data} loading={loading} />
      )}
    </Box>
  );
}

/**
 * Display assignment data sorting by groups with ungrouped profiles at the bottom.  Shown when
 * "View by group" is toggled on.
 */
function TableByGroups({
  assignment,
  profiles,
  groupsData
}: {
  assignment: Assignment;
  profiles: RolesWithProfilesAndGroupMemberships[] | undefined;
  groupsData: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
}) {
  return (
    <Flex gap="15px" flexDir={"column"} paddingTop={"10px"}>
      <Heading size="md">Groups</Heading>
      <Table.Root width="100%" striped>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Members</Table.ColumnHeader>
            <Table.ColumnHeader>Error</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {groupsData.map((group) => {
            let errorMessage;
            let error = false;
            if (assignment.group_config === "groups" && !group) {
              errorMessage = "Student is not in a group";
              error = true;
            } else if (
              group &&
              assignment.min_group_size !== null &&
              group.assignment_groups_members.length < assignment.min_group_size
            ) {
              errorMessage = `Group is too small (min: ${assignment.min_group_size}, current: ${group.assignment_groups_members.length})`;
              error = true;
            } else if (
              group &&
              assignment.max_group_size !== null &&
              group.assignment_groups_members.length > assignment.max_group_size
            ) {
              errorMessage = `Group is too large (max: ${assignment.max_group_size}, current: ${group.assignment_groups_members.length})`;
              error = true;
            }

            return (
              <Table.Row key={group.id}>
                <Table.Cell>{group.name}</Table.Cell>
                <Table.Cell>
                  {group.assignment_groups_members.map((member, key) => {
                    return (
                      profiles?.find((prof) => {
                        return prof.private_profile_id == member.profile_id;
                      })?.profiles.name + (key < group.assignment_groups_members.length - 1 ? ", " : "")
                    );
                  })}
                </Table.Cell>
                <Table.Cell>
                  {error ? <Text color="red">{errorMessage}</Text> : <Text color="green">OK</Text>}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      <Heading size="md">Ungrouped Profiles</Heading>
      <TableByStudents
        assignment={assignment}
        groupsData={groupsData}
        profiles={profiles?.filter((profile) => {
          return profile.profiles.assignment_groups_members.length === 0;
        })}
        loading={false}
      />
    </Flex>
  );
}

/**
 * Shows the table of students, their groups, and problems with their groups.  Displayed when
 * "View by group" is toggled off and used to display ungrouped profiles in group view.
 */
function TableByStudents({
  assignment,
  groupsData,
  profiles,
  loading
}: {
  assignment: Assignment;
  groupsData: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  profiles: RolesWithProfilesAndGroupMemberships[] | undefined;
  loading: boolean;
}) {
  const { addMovesToFulfill } = useGroupManagement();
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  return (
    <Flex gap="15px" flexDir={"column"} paddingTop={"10px"}>
      <Heading size="md">Students</Heading>
      <Table.Root striped>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Error</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {profiles?.map((profile) => {
            const groupID =
              profile.profiles.assignment_groups_members.length > 0
                ? profile.profiles.assignment_groups_members[0].assignment_group_id
                : undefined;
            const group = groupsData?.find((group) => group.id === groupID);
            let errorMessage;
            let error = false;
            if (assignment.group_config === "groups" && !group) {
              errorMessage = "Student is not in a group";
              error = true;
            } else if (
              group &&
              assignment.min_group_size !== null &&
              group.assignment_groups_members.length < assignment.min_group_size
            ) {
              errorMessage = `Group is too small (min: ${assignment.min_group_size}, current: ${group.assignment_groups_members.length})`;
              error = true;
            } else if (
              group &&
              assignment.max_group_size !== null &&
              group.assignment_groups_members.length > assignment.max_group_size
            ) {
              errorMessage = `Group is too large (max: ${assignment.max_group_size}, current: ${group.assignment_groups_members.length})`;
              error = true;
            }
            return (
              <Table.Row key={profile.id}>
                <Table.Cell>{profile.profiles.name}</Table.Cell>
                <Table.Cell>
                  <Dialog.Root placement={"center"}>
                    <Dialog.Trigger asChild>
                      <Flex alignItems={"center"} gap="3px">
                        <Text> {group ? group.name : "no group"}</Text>
                        <Button
                          backgroundColor={"transparent"}
                          paddingLeft="0"
                          _hover={{ textDecoration: "underline" }}
                        >
                          (edit)
                        </Button>
                      </Flex>
                    </Dialog.Trigger>
                    <Portal>
                      <Dialog.Positioner>
                        <Dialog.Backdrop />
                        <Dialog.Content>
                          <Dialog.Header>
                            <Dialog.Title>Move student {profile.profiles.name}</Dialog.Title>
                          </Dialog.Header>
                          <Dialog.Body>
                            <Text>
                              <strong>Current group:</strong> {group ? group.name : "no group"}{" "}
                            </Text>
                            <Text>
                              <strong>Move to:</strong>
                            </Text>

                            <NativeSelect.Root disabled={loading}>
                              <NativeSelect.Field
                                value={groupId ?? group?.id}
                                onChange={(e) => {
                                  setGroupId(e.target.value);
                                }}
                              >
                                <option value={undefined}>(No group)</option>
                                {groupsData?.map((group) => (
                                  <option key={group.id} value={group.id}>
                                    {group.name}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                            </NativeSelect.Root>

                            <Dialog.Footer>
                              <Dialog.ActionTrigger as="div">
                                <Button
                                  colorPalette={"red"}
                                  variant="surface"
                                  onClick={() => {
                                    setGroupId(undefined);
                                  }}
                                >
                                  Cancel
                                </Button>
                              </Dialog.ActionTrigger>
                              <Dialog.ActionTrigger as="div">
                                <Button
                                  colorPalette={"green"}
                                  onClick={() => {
                                    if (group?.id == Number(groupId)) {
                                      toaster.error({
                                        title: "Failed to stage changes",
                                        description: "Cannot move student to a group they are already in"
                                      });
                                    } else {
                                      addMovesToFulfill([
                                        {
                                          profile_id: profile.private_profile_id,
                                          old_group_id:
                                            profile.profiles.assignment_groups_members.length > 0
                                              ? profile.profiles.assignment_groups_members[0].assignment_group_id
                                              : null,
                                          new_group_id: Number(groupId)
                                        }
                                      ]);
                                    }
                                    setGroupId(undefined);
                                  }}
                                >
                                  Stage Changes
                                </Button>
                              </Dialog.ActionTrigger>
                            </Dialog.Footer>
                          </Dialog.Body>
                        </Dialog.Content>
                      </Dialog.Positioner>
                    </Portal>
                  </Dialog.Root>
                </Table.Cell>
                <Table.Cell>
                  {error ? <Text color="red">{errorMessage}</Text> : <Text color="green">OK</Text>}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

export default function AssignmentGroupsPage() {
  const { course_id, assignment_id } = useParams();
  const assignmentQuery = useShow<Assignment>({ resource: "assignments", id: Number(assignment_id) });
  if (assignmentQuery.query.isLoading) {
    return (
      <Box>
        <Skeleton height="100px" />
      </Box>
    );
  }
  const assignment = assignmentQuery.query.data;
  if (!assignment?.data) {
    return (
      <Box>
        <Text>Unable to load assignment </Text>
      </Box>
    );
  }
  return (
    <GroupManagementProvider>
      <Box>
        <Heading size="md">Configure Groups</Heading>
        {(assignment.data.group_config === "groups" || assignment.data.group_config === "both") && (
          <AssignmentGroupsTable assignment={assignment.data} course_id={Number(course_id)} />
        )}
        {assignment.data.group_config === "individual" && (
          <Text fontSize="sm" color="text.muted">
            This is an individual assignment, so group configuration is not applicable
          </Text>
        )}
      </Box>
    </GroupManagementProvider>
  );
}
