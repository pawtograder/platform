"use client";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Link, NativeSelect, SegmentGroup, Spinner, Switch, Table } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Heading, Skeleton, Text } from "@chakra-ui/react";
import { useInvalidate, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import CreateNewGroup from "./createNewGroupModal";
import BulkAssignGroup from "./bulkCreateGroupModal";
import BulkModifyGroup from "./bulkModifyGroup";
import { updateGroupForStudent } from "./updateGroupForStudent";

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
  console.log(profiles);
  const groupsData = groups?.data;
  const [loading, setLoading] = useState<boolean>(false);

  const [groupViewOn, setGroupViewOn] = useState<boolean>(false);
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
      <Text fontSize="sm" color="text.muted">
        This table allows you to tweak group configurations.{" "}
        <Text as="span" fontWeight="bold">
          Changes are applied in real time: use with caution.
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

      <Switch.Root float="right" size="md" checked={groupViewOn} onCheckedChange={(e) => setGroupViewOn(e.checked)}>
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>View by group</Switch.Label>
      </Switch.Root>

      {groupViewOn ? (
        <TableByGroups
          assignment={assignment}
          course_id={course_id}
          profiles={profiles?.data}
          groupsData={groupsData}
        />
      ) : (
        <TableByStudents
          assignment={assignment}
          course_id={course_id}
          groupsData={groupsData}
          profiles={profiles?.data}
          loading={loading}
        />
      )}
    </Box>
  );
}

function TableByGroups({
  assignment,
  course_id,
  profiles,
  groupsData
}: {
  assignment: Assignment;
  course_id: number;
  profiles: RolesWithProfilesAndGroupMemberships[] | undefined;
  groupsData: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
}) {
  console.log(profiles);
  console.log(groupsData);
  return (
    <Table.Root maxW="4xl" striped>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Group</Table.ColumnHeader>
          <Table.ColumnHeader>Members</Table.ColumnHeader>
          <Table.ColumnHeader>Error</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {groupsData.map((group) => {
          const groupID = group.id;
          console.log(groupID);
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
              <Table.Cell>{error ? <Text color="red">{errorMessage}</Text> : <Text color="green">OK</Text>}</Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}

function TableByStudents({
  assignment,
  course_id,
  groupsData,
  profiles,
  loading
}: {
  assignment: Assignment;
  course_id: number;
  groupsData: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  profiles: RolesWithProfilesAndGroupMemberships[] | undefined;
  loading: boolean;
}) {
  const invalidate = useInvalidate();
  const supabase = createClient();
  const updateGroup = useCallback(updateGroupForStudent, [supabase, invalidate, course_id]);

  return (
    <Table.Root maxW="4xl" striped>
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
          console.log(groupID);
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
                <NativeSelect.Root disabled={loading}>
                  <NativeSelect.Field
                    value={group?.id}
                    onChange={(e) => {
                      const groupID = e.target.value;
                      console.log(groupID);
                      const group = groupsData?.find((group) => group.id === Number(groupID));
                      updateGroup(group, profile);
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
              </Table.Cell>
              <Table.Cell>{error ? <Text color="red">{errorMessage}</Text> : <Text color="green">OK</Text>}</Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
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
  );
}
