"use client";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Link, NativeSelect, Spinner, Table } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";

import { toaster } from "@/components/ui/toaster";
import { assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Heading, Skeleton, Text } from "@chakra-ui/react";
import { useInvalidate, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import CreateNewGroup from "./createNewGroupModal";
import BulkAssignGroup from "./bulkCreateGroupModal";
import BulkModifyGroup from "./bulkModifyGroup";

type RolesWithProfilesAndGroupMemberships = GetResult<
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
    pagination: { pageSize: 1000 }
  });
  const groupsData = groups?.data;
  const invalidate = useInvalidate();
  const supabase = createClient();

  const [loading, setLoading] = useState<boolean>(false);
  const updateGroupForStudent = useCallback(
    async (
      group: AssignmentGroupWithMembersInvitationsAndJoinRequests | undefined,
      student: RolesWithProfilesAndGroupMemberships
    ) => {
      try {
        setLoading(true);
        await assignmentGroupInstructorMoveStudent(
          {
            new_assignment_group_id: group?.id || null,
            old_assignment_group_id:
              student.profiles.assignment_groups_members.length > 0
                ? student.profiles.assignment_groups_members[0].assignment_group_id
                : null,
            profile_id: student.private_profile_id,
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
    },
    [supabase, invalidate, course_id]
  );

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
      <Flex gap="10px" flexDir={"row"}>
        <CreateNewGroup groups={groupsData} assignment={assignment} />
        <BulkAssignGroup groups={groupsData} assignment={assignment} />
        <BulkModifyGroup groups={groupsData} assignment={assignment} />
      </Flex>

      <Table.Root maxW="4xl" striped>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Error</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {profiles?.data?.map((profile) => {
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
                  <NativeSelect.Root disabled={loading}>
                    <NativeSelect.Field
                      value={group?.id}
                      onChange={(e) => {
                        const groupID = e.target.value;
                        console.log(groupID);
                        const group = groupsData?.find((group) => group.id === Number(groupID));
                        updateGroupForStudent(group, profile);
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
                <Table.Cell>
                  {error ? <Text color="red">{errorMessage}</Text> : <Text color="green">OK</Text>}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
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
