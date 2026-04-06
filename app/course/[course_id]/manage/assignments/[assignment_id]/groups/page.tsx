"use client";
import { toaster } from "@/components/ui/toaster";

import { createClient } from "@/utils/supabase/client";
import { Assignment, AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { useGradersAndInstructors } from "@/hooks/useCourseController";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  Icon,
  Link,
  NativeSelect,
  Portal,
  Skeleton,
  Spinner,
  Switch,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useInvalidate, useList, useShow } from "@refinedev/core";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FaArrowRight, FaEdit, FaRegTimesCircle, FaDownload } from "react-icons/fa";
import BulkAssignGroup from "./bulkCreateGroupModal";
import BulkModifyGroup from "./bulkModifyGroup";
import CreateNewGroup from "./createNewGroupModal";
import { GroupCreateData, GroupManagementProvider, useGroupManagement } from "./GroupManagementContext";
import { useTagsQuery } from "@/hooks/course-data";
import TagDisplay from "@/components/ui/tag";
import * as Sentry from "@sentry/nextjs";

const UTF8_BOM = "\uFEFF";

/**
 * RFC-style CSV cell escaping; blocks formula injection in Excel/Sheets.
 */
function escapeCSVCell(value: string): string {
  const stringValue = value;
  const trimmed = stringValue.trimStart();
  if (["=", "+", "-", "@"].includes(trimmed[0] ?? "")) {
    return `"'${stringValue.replace(/"/g, '""')}"`;
  }
  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n") ||
    stringValue.includes("\r")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function formatNameEmailLabel(name: string | null | undefined, email: string | null | undefined): string {
  const displayName = (name ?? "").trim() || "Unknown";
  const e = (email ?? "").trim();
  if (!e) {
    return displayName;
  }
  return `${displayName} <${e}>`;
}

/**
 * Helper function to download CSV data (UTF-8 BOM for Excel)
 */
function downloadCSV(csvContent: string, filename: string) {
  const blob = new Blob([UTF8_BOM + csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export type RolesWithProfilesAndGroupMemberships = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, profiles!private_profile_id(*,assignment_groups_members!assignment_groups_members_profile_id_fkey(*)), users(email)"
>;

function AssignmentGroupsTable({ assignment, course_id }: { assignment: Assignment; course_id: number }) {
  const { data: groups } = useList<AssignmentGroupWithMembersInvitationsAndJoinRequests>({
    resource: "assignment_groups",
    meta: { select: "*, assignment_groups_members(*)" },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment.id }],
    pagination: { pageSize: 1000 }
    // liveMode: "auto"
  });
  const { data: profiles } = useList<RolesWithProfilesAndGroupMemberships>({
    resource: "user_roles",
    meta: {
      select:
        "*, profiles!private_profile_id(*,assignment_groups_members!assignment_groups_members_profile_id_fkey(*)), users(email)"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "role", operator: "eq", value: "student" },
      { field: "disabled", operator: "eq", value: false },
      { field: "profiles.assignment_groups_members.assignment_id", operator: "eq", value: assignment.id }
    ],
    pagination: { pageSize: 1000 }
    // liveMode: "auto"
  });
  const groupsData = groups?.data;
  const [loading, setLoading] = useState<boolean>(false);
  const [groupViewOn, setGroupViewOn] = useState<boolean>(false);
  const {
    groupsToCreate,
    movesToFulfill,
    clearGroupsToCreate,
    clearMovesToFulfill,
    retainOnlyFailedMovesAndGroups,
    removeGroupToCreate,
    removeMoveToFulfill
  } = useGroupManagement();
  const invalidate = useInvalidate();
  const { data: tags = [] } = useTagsQuery();
  const supabase = createClient();

  /**
   * Publish all staged changes in a single RPC call.
   */
  const publishChanges = async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase.rpc as CallableFunction)("publish_assignment_group_changes", {
        p_class_id: course_id,
        p_assignment_id: assignment.id,
        p_groups_to_create: groupsToCreate.map((g) => ({ name: g.name, member_ids: g.member_ids })),
        p_moves_to_fulfill: movesToFulfill.map((m) => ({
          profile_id: m.profile_id,
          old_group_id: m.old_group_id,
          new_group_id: m.new_group_id
        }))
      });

      if (error) throw error;

      const result = data as {
        groups_created: number;
        members_added: number;
        members_moved: number;
        groups_dissolved: number;
        syncs_enqueued: number;
        errors: { error: string; profile_id?: string; group_name?: string }[];
      };

      if (result.errors.length > 0) {
        result.errors.forEach((e) => {
          Sentry.captureMessage(`Group publish error: ${e.error}`, {
            level: "error",
            extra: e
          });
          console.error("Group publish error:", e);
        });

        toaster.create({
          title: "Published with errors",
          description: `${result.groups_created} groups created, ${result.members_moved + result.members_added} students moved, ${result.errors.length} error(s)`,
          type: "warning"
        });

        const failedProfileIds = new Set(
          result.errors
            .filter((e): e is { error: string; profile_id: string } => !!e.profile_id)
            .map((e) => e.profile_id)
        );
        const failedGroupNames = new Set(
          result.errors
            .filter((e): e is { error: string; group_name: string } => !!e.group_name)
            .map((e) => e.group_name)
        );
        retainOnlyFailedMovesAndGroups(failedProfileIds, failedGroupNames);
      } else {
        const parts: string[] = [];
        if (result.groups_created > 0) parts.push(`${result.groups_created} group(s) created`);
        if (result.members_added > 0) parts.push(`${result.members_added} member(s) added`);
        if (result.members_moved > 0) parts.push(`${result.members_moved} student(s) moved`);
        if (result.groups_dissolved > 0) parts.push(`${result.groups_dissolved} group(s) dissolved`);
        if (result.syncs_enqueued > 0) parts.push(`${result.syncs_enqueued} permission sync(s) queued`);

        toaster.create({
          title: "Changes published",
          description: parts.join(", ") || "No changes needed",
          type: "success"
        });

        clearGroupsToCreate();
        clearMovesToFulfill();
      }
    } catch (e) {
      console.error(e);
      Sentry.captureException(e);
      toaster.create({
        title: "Error publishing changes",
        description: e instanceof Error ? e.message : "Unknown error",
        type: "error"
      });
    } finally {
      setLoading(false);
      invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
      invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
      invalidate({ resource: "user_roles", invalidates: ["list"] });
    }
  };

  const tagDisplay = (group: GroupCreateData) => {
    const tag = tags.find((t) => {
      return t.name === group.tagName && t.color === group.tagColor;
    });
    if (tag) {
      return <TagDisplay tag={tag} />;
    } else {
      return <></>;
    }
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
                        <Table.ColumnHeader>Common Tag</Table.ColumnHeader>
                        <Table.ColumnHeader>Actions</Table.ColumnHeader>
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
                            <Table.Cell>{tagDisplay(group)}</Table.Cell>
                            <Table.Cell>
                              <Button
                                variant={"surface"}
                                size={"xs"}
                                colorPalette="red"
                                onClick={() => {
                                  removeGroupToCreate(group);
                                }}
                              >
                                <Icon as={FaRegTimesCircle} />
                                Cancel
                              </Button>
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
                        <Table.ColumnHeader>Actions</Table.ColumnHeader>
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
                            <Table.Cell>
                              <Button
                                variant={"surface"}
                                size={"xs"}
                                colorPalette="red"
                                onClick={() => {
                                  removeMoveToFulfill(move);
                                }}
                              >
                                <Icon as={FaRegTimesCircle} />
                                Cancel
                              </Button>
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
          trigger={
            <Button size="sm" variant="outline">
              Tweak a Group
            </Button>
          }
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
  const { modProfiles, movesToFulfill } = useGroupManagement();
  const graders = useGradersAndInstructors();
  const supabase = createClient();
  const invalidate = useInvalidate();
  const [updatingMentorGroupId, setUpdatingMentorGroupId] = useState<number | null>(null);

  const updateMentor = async (groupId: number, mentorProfileId: string | null) => {
    setUpdatingMentorGroupId(groupId);
    try {
      const { error } = await supabase
        .from("assignment_groups")
        .update({ mentor_profile_id: mentorProfileId })
        .eq("id", groupId);
      if (error) {
        Sentry.captureException(error);
        toaster.create({ title: "Error updating mentor", description: error.message, type: "error" });
      } else {
        toaster.create({ title: "Mentor updated", type: "success" });
        invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
      }
    } catch (e) {
      Sentry.captureException(e);
      toaster.create({
        title: "Error updating mentor",
        description: e instanceof Error ? e.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setUpdatingMentorGroupId(null);
    }
  };

  /**
   * Export groups data to CSV: GroupName, StudentNames (Name <email> per member, comma-separated), MentorName.
   */
  const exportToCSV = () => {
    const headers = ["GroupName", "StudentNames", "MentorName"];
    const rows: string[][] = [];

    const sortedGroups = [...groupsData].sort((a, b) => a.name.localeCompare(b.name));

    sortedGroups.forEach((group) => {
      const studentLabels = group.assignment_groups_members
        .map((member) => {
          const row = profiles?.find((p) => p.private_profile_id === member.profile_id);
          return formatNameEmailLabel(row?.profiles.name, row?.users?.email ?? null);
        })
        .sort((a, b) => a.localeCompare(b));

      const mentor = group.mentor_profile_id ? graders.find((g) => g.id === group.mentor_profile_id) : undefined;
      const mentorLabel = mentor ? formatNameEmailLabel(mentor.name, mentor.userEmail) : "";

      rows.push([group.name, studentLabels.join(", "), mentorLabel]);
    });

    const ungroupedProfiles = profiles
      ?.filter((profile) => profile.profiles.assignment_groups_members.length === 0)
      .slice()
      .sort((a, b) => (a.profiles.name ?? "").localeCompare(b.profiles.name ?? ""));
    ungroupedProfiles?.forEach((profile) => {
      rows.push(["(Ungrouped)", formatNameEmailLabel(profile.profiles.name, profile.users?.email ?? null), ""]);
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.map(escapeCSVCell).join(","))].join("\n");

    downloadCSV(csvContent, `assignment_groups_${new Date().toISOString().split("T")[0]}.csv`);
  };

  /**
   * Creates the list of profile names being added to an exisitng group in table preview
   */
  const newProfilesForGroup = (group_id: number) => {
    const movesForThisGroup = movesToFulfill.filter((move) => {
      return move.new_group_id == group_id;
    });
    const profileIdsForThisGroup = movesForThisGroup.map((move) => {
      return move.profile_id;
    });

    const profilesForGroup = profileIdsForThisGroup.map((profile) => {
      return profiles?.find((p) => {
        return p.private_profile_id == profile;
      });
    });

    return (
      <Flex>
        {profilesForGroup.map((profile, key) => {
          return (
            <Text
              key={key}
              fontWeight="bold"
              border="1px solid"
              borderColor="border.success"
              bg="green.subtle"
              borderRadius="md"
              p="2"
            >
              {profile?.profiles.name}{" "}
            </Text>
          );
        })}
      </Flex>
    );
  };

  return (
    <Flex gap="15px" flexDir={"column"} paddingTop={"10px"}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading size="md">Groups</Heading>
        <Button size="sm" variant="outline" onClick={exportToCSV}>
          <Icon as={FaDownload} mr={2} />
          Export as CSV
        </Button>
      </Flex>
      <Table.Root width="100%" striped>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Members</Table.ColumnHeader>
            <Table.ColumnHeader>Mentor</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
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
                    const name =
                      profiles?.find((prof) => {
                        return prof.private_profile_id == member.profile_id;
                      })?.profiles.name + " ";
                    if (modProfiles.includes(member.profile_id)) {
                      return (
                        <Text
                          textDecoration="line-through"
                          key={key}
                          border="1px solid"
                          borderColor="border.error"
                          bg="red.subtle"
                          borderRadius="md"
                          p="2"
                        >
                          {name}
                        </Text>
                      );
                    } else {
                      return <Text key={key}>{name}</Text>;
                    }
                  })}
                  {newProfilesForGroup(group.id)}
                </Table.Cell>
                <Table.Cell>
                  <NativeSelect.Root size="sm" disabled={updatingMentorGroupId === group.id}>
                    <NativeSelect.Field
                      value={group.mentor_profile_id ?? ""}
                      onChange={(e) => {
                        updateMentor(group.id, e.target.value || null);
                      }}
                    >
                      <option value="">No mentor</option>
                      {graders.map((grader) => (
                        <option key={grader.id} value={grader.id}>
                          {grader.name}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                </Table.Cell>
                <Table.Cell>
                  <BulkModifyGroup
                    groups={groupsData}
                    assignment={assignment}
                    profiles={profiles as RolesWithProfilesAndGroupMemberships[]}
                    groupToModify={group}
                    trigger={
                      <Button variant={"surface"} size={"xs"}>
                        <Icon as={FaEdit} /> Edit Group
                      </Button>
                    }
                  />
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
  const { modProfiles, groupsToCreate, movesToFulfill, addMovesToFulfill } = useGroupManagement();
  const [groupId, setGroupId] = useState<string | undefined>(undefined);

  /**
   * Export students data to CSV (Student as Name <email>, group, validation status).
   */
  const exportToCSV = () => {
    const headers = ["Student", "Group", "Status"];
    const rows: string[][] = [];

    const sortedProfiles = profiles
      ? [...profiles].sort((a, b) => (a.profiles.name ?? "").localeCompare(b.profiles.name ?? ""))
      : [];

    sortedProfiles.forEach((profile) => {
      const groupID =
        profile.profiles.assignment_groups_members.length > 0
          ? profile.profiles.assignment_groups_members[0].assignment_group_id
          : undefined;
      const group = groupsData?.find((g) => g.id === groupID);

      let status = "OK";
      if (assignment.group_config === "groups" && !group) {
        status = "Not in a group";
      } else if (
        group &&
        assignment.min_group_size !== null &&
        group.assignment_groups_members.length < assignment.min_group_size
      ) {
        status = `Group too small (min: ${assignment.min_group_size})`;
      } else if (
        group &&
        assignment.max_group_size !== null &&
        group.assignment_groups_members.length > assignment.max_group_size
      ) {
        status = `Group too large (max: ${assignment.max_group_size})`;
      }

      rows.push([
        formatNameEmailLabel(profile.profiles.name, profile.users?.email ?? null),
        group ? group.name : "no group",
        status
      ]);
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.map(escapeCSVCell).join(","))].join("\n");

    downloadCSV(csvContent, `students_export_${new Date().toISOString().split("T")[0]}.csv`);
  };

  const getNewGroup = (profile_id: string) => {
    const move = movesToFulfill?.find((move) => {
      return move.profile_id == profile_id;
    });
    const group = groupsToCreate?.find((group) => {
      return group.member_ids.find((member) => member == profile_id);
    });
    if (move) {
      return (
        groupsData.find((group) => {
          return group.id == move.new_group_id;
        })?.name ?? "not in group"
      );
    } else if (group) {
      return group.name;
    }
    return "not in group";
  };
  return (
    <Flex gap="15px" flexDir={"column"} paddingTop={"10px"}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading size="md">Students</Heading>
        <Button size="sm" variant="outline" onClick={exportToCSV}>
          <Icon as={FaDownload} mr={2} />
          Export as CSV
        </Button>
      </Flex>
      <Table.Root striped>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
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
                  <Flex alignItems={"center"} gap="3px">
                    {!modProfiles.includes(profile.private_profile_id) ? (
                      <>
                        <Text> {group ? group.name : "no group"}</Text>
                      </>
                    ) : (
                      <VStack gap={1} textAlign="left" alignItems="flex-start">
                        <Text
                          textDecoration={"line-through"}
                          border="1px solid"
                          borderColor="border.error"
                          bg="red.subtle"
                          borderRadius="md"
                          p="2"
                        >
                          {group ? group.name : "no group"}
                        </Text>
                        <Text
                          border="1px solid"
                          borderColor="border.success"
                          bg="green.subtle"
                          borderRadius="md"
                          p="2"
                          fontWeight={"bold"}
                        >
                          {getNewGroup(profile.private_profile_id) ?? ""}
                        </Text>
                      </VStack>
                    )}
                  </Flex>
                </Table.Cell>
                <Table.Cell>
                  <HStack gap={1}>
                    <BulkModifyGroup
                      groups={groupsData}
                      assignment={assignment}
                      profiles={profiles as RolesWithProfilesAndGroupMemberships[]}
                      groupToModify={group}
                      trigger={
                        <Button variant={"surface"} size={"xs"}>
                          <Icon as={FaEdit} /> Edit Group
                        </Button>
                      }
                    />
                    <Dialog.Root placement={"center"}>
                      <Dialog.Trigger asChild>
                        <Button
                          variant={"surface"}
                          size={"xs"}
                          _hover={{ textDecoration: "underline", backgroundColor: "transparent" }}
                        >
                          <Icon as={FaArrowRight} /> Move Student
                        </Button>
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
                                <Dialog.CloseTrigger as="div">
                                  <Button
                                    colorPalette={"red"}
                                    variant="surface"
                                    onClick={() => {
                                      setGroupId(undefined);
                                    }}
                                  >
                                    Cancel
                                  </Button>
                                </Dialog.CloseTrigger>
                                <Dialog.CloseTrigger as="div">
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
                                </Dialog.CloseTrigger>
                              </Dialog.Footer>
                            </Dialog.Body>
                          </Dialog.Content>
                        </Dialog.Positioner>
                      </Portal>
                    </Dialog.Root>
                  </HStack>
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
