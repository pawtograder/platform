"use client";

import Link from "@/components/ui/link";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourse, useProfiles } from "@/hooks/useCourseController";
import { useUserProfile } from "@/hooks/useUserProfiles";
import {
  assignmentGroupApproveRequest,
  assignmentGroupCreate,
  assignmentGroupJoin,
  assignmentGroupLeave,
  EdgeFunctionError
} from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  AssignmentGroupInvitation,
  AssignmentGroupJoinRequest,
  AssignmentGroupWithMembersInvitationsAndJoinRequests,
  Repository
} from "@/utils/supabase/DatabaseTypes";
import {
  Avatar,
  Box,
  Button,
  Card,
  Dialog,
  Field,
  Flex,
  Heading,
  HStack,
  Icon,
  Input,
  List,
  Separator,
  Skeleton,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useInvalidate, useList } from "@refinedev/core";
import { MultiValue, Select } from "chakra-react-select";
import { formatRelative } from "date-fns";
import { CheckCircleIcon, ClockIcon, MinusCircleIcon, XCircleIcon } from "lucide-react";
import { Fragment, useCallback, useMemo, useState } from "react";

function CreateGroupButton({
  assignment,
  allGroups
}: {
  assignment: Assignment;
  allGroups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
}) {
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidate();
  const ungroupedProfiles = useUngroupedProfiles(allGroups);

  const [name, setName] = useState<string>("");
  const [selectedInvitees, setSelectedInvitees] = useState<MultiValue<{ label: string | null; value: string }>>([]);
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(false);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        setOpen(e.open);
      }}
    >
      <Dialog.Trigger asChild>
        <Button colorPalette="green" variant="surface">
          Create a new group
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <form>
            <Dialog.Header>
              <Dialog.Title>Create a new group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Field.Root invalid={name.length > 0 && !/^[a-zA-Z0-9_-]{1,36}$/.test(name)}>
                <Field.Label>Choose a name for your group</Field.Label>
                <Input name="name" value={name} onChange={(e) => setName(e.target.value)} />
                <Field.HelperText>
                  Other students will use this name to find your group, and instructors will use this name to identify
                  the group. The name must consist only of alphanumeric, hyphens, or underscores, and be less than 36
                  characters.
                </Field.HelperText>
                <Field.ErrorText>
                  The name must consist only of alphanumeric, hyphens, or underscores, and be less than 36 characters.
                </Field.ErrorText>
              </Field.Root>
              <Field.Root>
                <Field.Label>Invite other students to join your group</Field.Label>
                <Select
                  onChange={(e) => setSelectedInvitees(e)}
                  isMulti={true}
                  options={ungroupedProfiles.map((p) => ({ label: p.name, value: p.id }))}
                />
              </Field.Root>
              You can choose to invite other students to join your group, and if they accept it, they will be added to
              your group. Any student who has been enrolled in the course will also be able to request to join your
              group (requiring approval from a current group member).
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button
                loading={isLoading}
                colorPalette="green"
                onClick={() => {
                  setIsLoading(true);
                  assignmentGroupCreate(
                    {
                      course_id: assignment.class_id,
                      assignment_id: assignment.id,
                      name: name,
                      invitees: selectedInvitees.map((i) => i.value)
                    },
                    supabase
                  )
                    .then(() => {
                      toaster.create({ title: "Group created", description: "", type: "success" });
                      setOpen(false);
                      setName("");
                      setSelectedInvitees([]);
                      setIsLoading(false);
                      invalidate({ resource: "assignment_groups", invalidates: ["all"] });
                      invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
                      invalidate({ resource: "assignment_group_invitations", invalidates: ["all"] });
                    })
                    .catch((e) => {
                      setIsLoading(false);
                      if (e instanceof EdgeFunctionError) {
                        toaster.create({ title: "Error: " + e.message, description: e.details, type: "error" });
                      }
                    });
                }}
              >
                Save
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

export function useUngroupedProfiles(groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[]) {
  const profiles = useProfiles();
  const ungroupedProfiles = useMemo(() => {
    if (!groups) {
      return [];
    }
    return profiles.filter(
      (p) => p.is_private_profile && !groups.some((g) => g.assignment_groups_members.some((m) => m.profile_id === p.id))
    );
  }, [profiles, groups]);
  return ungroupedProfiles;
}

function InviteButton({
  group,
  allGroups
}: {
  group: AssignmentGroupWithMembersInvitationsAndJoinRequests;
  allGroups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
}) {
  const { private_profile_id } = useClassProfiles();
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidate();
  const supabase = createClient();
  const [selectedInvitees, setSelectedInvitees] = useState<MultiValue<{ label: string | null; value: string }>>([]);
  const ungroupedProfiles = useUngroupedProfiles(allGroups);
  const ungroupedProfilesWithoutInvitations = useMemo(() => {
    return ungroupedProfiles.filter((p) => !group.assignment_group_invitations.some((i) => i.invitee === p.id));
  }, [ungroupedProfiles, group]);
  const invalidateInvites = useCallback(() => {
    invalidate({ resource: "assignment_group_invitations", invalidates: ["all"] });
  }, [invalidate]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        setOpen(e.open);
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="surface" colorPalette="green">
          Invite other students
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <form>
            <Dialog.Header>
              <Dialog.Title>Invite other students to join your group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Field.Root>
                <Field.Label>Outstanding invitations</Field.Label>
                {group.assignment_group_invitations.map((i) => (
                  <AssignmentGroupInvitationView invitation={i} key={i.id} invalidateInvites={invalidateInvites} />
                ))}
              </Field.Root>
              <Field.Root>
                <Field.Label>Invite other students to join your group</Field.Label>
                <Select
                  onChange={(e) => setSelectedInvitees(e)}
                  isMulti={true}
                  options={ungroupedProfilesWithoutInvitations.map((p) => ({ label: p.name, value: p.id }))}
                />
              </Field.Root>
              You can optionally choose to invite other students to join your group. Any student who has been enrolled
              in the course will also be able to request to join your group.
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button
                colorPalette="green"
                onClick={() => {
                  supabase
                    .from("assignment_group_invitations")
                    .insert(
                      selectedInvitees.map((i) => ({
                        assignment_group_id: group.id,
                        invitee: i.value,
                        inviter: private_profile_id!,
                        class_id: group.class_id
                      }))
                    )
                    .then((res) => {
                      if (res.error) {
                        toaster.create({
                          title: "Error: " + res.error.message,
                          description: res.error.details,
                          type: "error"
                        });
                      } else {
                        toaster.create({ title: "Invitations sent", description: "", type: "success" });
                        setSelectedInvitees([]);
                        invalidateInvites();
                        setOpen(false);
                      }
                    });
                }}
              >
                Send New Invitations
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function GroupMemberList({ group }: { group: AssignmentGroupWithMembersInvitationsAndJoinRequests }) {
  const profiles = useProfiles();
  return (
    <HStack>
      {group.assignment_groups_members.map((m) => (
        <Fragment key={m.profile_id}>
          <Text fontSize="sm" color="fg.muted">
            {profiles.find((p) => p.id === m.profile_id)?.name}
          </Text>
        </Fragment>
      ))}
    </HStack>
  );
}

function JoinGroupButton({
  groups,
  assignment
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  const { private_profile_id } = useClassProfiles();
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidate();
  const supabase = createClient();
  const [groupToJoin, setGroupToJoin] = useState<AssignmentGroupWithMembersInvitationsAndJoinRequests | null>(null);
  const myInvitations = useMemo(() => {
    const invitations = groups.map((g) => g.assignment_group_invitations.map((i) => ({ ...i, group: g }))).flat();
    return invitations.filter((i) => i.invitee === private_profile_id);
  }, [groups, private_profile_id]);
  const myRequests = useMemo(() => {
    const requests = groups
      .map((g) => g.assignment_group_join_request.map((i) => ({ ...i, group: g })))
      .flat()
      .filter((j) => j.profile_id === private_profile_id);
    return requests.sort((a, b) => {
      return b.created_at.localeCompare(a.created_at);
    });
  }, [groups, private_profile_id]);
  const myGroupsWithoutInvitationsOrRequests = useMemo(() => {
    return groups.filter(
      (g) =>
        !g.assignment_group_invitations.some((i) => i.invitee === private_profile_id) &&
        !g.assignment_group_join_request.some((j) => j.profile_id === private_profile_id && j.status === "pending")
    );
  }, [groups, private_profile_id]);
  const invalidateInvites = useCallback(() => {
    invalidate({ resource: "assignment_group_join_request", invalidates: ["all"] });
    invalidate({ resource: "assignment_group_invitations", invalidates: ["all"] });
    invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
  }, [invalidate]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        setOpen(e.open);
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="surface" colorPalette="green">
          Join a group
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <form>
            <Dialog.Header>
              <Dialog.Title>Find a group to join</Dialog.Title>
              <Box>
                There are three ways to join a group:
                <List.Root as="ol" ml={4}>
                  <List.Item>By accepting an invitation from another student.</List.Item>
                  <List.Item>By sending a request to join a group, and that request being approved.</List.Item>
                  <List.Item>By creating your own group.</List.Item>
                </List.Root>
              </Box>
            </Dialog.Header>
            <Dialog.Body>
              <Field.Root>
                <Field.Label>Invitations</Field.Label>
                {myInvitations.length == 0 ? (
                  <Text fontSize="sm" color="fg.muted">
                    You have no outstanding invitations.
                  </Text>
                ) : (
                  <VStack>
                    {myInvitations.map((g) => {
                      return (
                        <VStack w="100%" key={g.id}>
                          <HStack>
                            <GroupMember profile_id={g.inviter} />
                            <Heading size="sm">invites you to join {g.group.name}</Heading>
                          </HStack>
                          <HStack w="100%" justifyContent="start">
                            <Button
                              colorPalette="green"
                              onClick={async () => {
                                try {
                                  const { message } = await assignmentGroupJoin(
                                    { assignment_group_id: g.group.id },
                                    supabase
                                  );
                                  toaster.create({
                                    title: "Invitation accepted",
                                    description: message,
                                    type: "success"
                                  });
                                  invalidateInvites();
                                } catch (e) {
                                  toaster.create({
                                    title: "Error",
                                    description:
                                      e instanceof EdgeFunctionError ? e.message : "An unknown error occurred",
                                    type: "error"
                                  });
                                }
                              }}
                            >
                              Accept
                            </Button>
                            <PopConfirm
                              trigger={
                                <Button variant="ghost" colorPalette="red">
                                  Decline
                                </Button>
                              }
                              triggerLabel="Decline"
                              confirmHeader="Decline invitation"
                              confirmText="Are you sure you want to decline this invitation?"
                              onConfirm={async () => {
                                try {
                                  const myInvitation = myInvitations.find((i) => i.id === g.id);
                                  if (!myInvitation) {
                                    throw new Error("Invitation not found");
                                  }
                                  const { error } = await supabase
                                    .from("assignment_group_invitations")
                                    .delete()
                                    .eq("id", myInvitation.id);
                                  if (error) {
                                    throw error;
                                  }
                                } catch (e) {
                                  toaster.create({
                                    title: "Error",
                                    description: e instanceof Error ? e.message : "An unknown error occurred",
                                    type: "error"
                                  });
                                }
                                invalidateInvites();
                              }}
                            />
                          </HStack>
                        </VStack>
                      );
                    })}
                  </VStack>
                )}
                <Field.HelperText>
                  You can accept or decline an invitation from another student to join their group.
                </Field.HelperText>
              </Field.Root>
              <Separator w="100%" mb={2} mt={2} />
              <Field.Root>
                <Field.Label>Select a group to request to join</Field.Label>
                <Select
                  onChange={(e) => {
                    setGroupToJoin(e?.group ?? null);
                  }}
                  isMulti={false}
                  isOptionDisabled={(option) => {
                    const groupCount = option.group.assignment_groups_members.length;
                    const maxGroupSize = assignment.max_group_size;
                    return groupCount >= (maxGroupSize ?? Number.MAX_SAFE_INTEGER);
                  }}
                  formatOptionLabel={({ group }) => {
                    return (
                      <HStack>
                        <Text>{group.name}</Text>
                        <Text>{group.assignment_groups_members.length} members:</Text>
                        <GroupMemberList group={group} />
                      </HStack>
                    );
                  }}
                  options={myGroupsWithoutInvitationsOrRequests.map((p) => ({ group: p, label: p.name, value: p.id }))}
                />
                <Button
                  colorPalette="green"
                  onClick={async () => {
                    try {
                      const res = await assignmentGroupJoin({ assignment_group_id: groupToJoin!.id }, supabase);
                      setGroupToJoin(null);
                      invalidateInvites();
                      if (res.joined_group) {
                        toaster.create({ title: "Group joined", description: res.message, type: "success" });
                        setOpen(false);
                      } else {
                        toaster.create({ title: "Request sent", description: res.message, type: "info" });
                      }
                    } catch (err) {
                      if (err instanceof EdgeFunctionError) {
                        toaster.create({ title: "Error: " + err.message, description: err.details, type: "error" });
                      }
                    }
                  }}
                >
                  Request to Join Group
                </Button>
                <Field.HelperText>
                  It is possible to request to join multiple groups at once, in which case you will be added to the
                  first group that accepts your request.
                </Field.HelperText>
              </Field.Root>
              {myRequests.length > 0 && (
                <Field.Root>
                  <Field.Label>Prior Join Requests</Field.Label>
                  <VStack w="100%" maxH="50vh" overflowY="auto">
                    {myRequests.map((g) => (
                      <Card.Root key={g.id} w="100%" bg={g.status === "pending" ? "bg.muted" : "bg.subtle"}>
                        <Flex flexDirection="row" p={2}>
                          <VStack alignItems="flex-start">
                            <Card.Title mb={0}>{g.group.name}</Card.Title>
                            <Text fontSize="xs" color="fg.muted">
                              ({formatRelative(g.created_at, new Date())})
                            </Text>
                          </VStack>
                          <VStack>
                            <Text>
                              {g.group.assignment_groups_members.length}/{assignment.max_group_size} members currently:
                            </Text>
                            <GroupMemberList group={g.group} />
                          </VStack>
                        </Flex>
                        <Card.Footer p={2}>
                          <Flex justifyContent="space-between" alignItems="center" p={0} m={0} w="100%">
                            <Flex alignItems="center" p={0} m={0}>
                              {g.status === "pending" && <Icon as={ClockIcon} color="fg.muted" />}
                              {g.status === "approved" && <Icon as={CheckCircleIcon} color="fg.muted" />}
                              {g.status === "rejected" && <Icon as={XCircleIcon} color="fg.muted" />}
                              {g.status === "withdrawn" && <Icon as={MinusCircleIcon} color="fg.muted" />}
                              <Text ml={2} fontSize="sm" color="fg.muted">
                                {g.status.charAt(0).toUpperCase() + g.status.slice(1)}
                              </Text>
                            </Flex>
                            {g.status === "pending" && (
                              <Button
                                colorPalette="green"
                                onClick={async () => {
                                  const joinRequest = g;
                                  const { error } = await supabase
                                    .from("assignment_group_join_request")
                                    .update({ status: "withdrawn", decision_maker: private_profile_id })
                                    .eq("id", joinRequest.id);
                                  if (error) {
                                    toaster.create({ title: "Error", description: error.message, type: "error" });
                                  }
                                  invalidateInvites();
                                  toaster.create({
                                    title: "Request cancelled",
                                    description:
                                      "Your request to join this group has been cancelled. Note: the group may still have received a notification that you requested to join.",
                                    type: "success"
                                  });
                                }}
                              >
                                Withdraw
                              </Button>
                            )}
                          </Flex>
                        </Card.Footer>
                      </Card.Root>
                    ))}
                  </VStack>
                  <Field.HelperText>
                    A group member will need to approve your request to join their group, after which you will be added
                    to the group.
                  </Field.HelperText>
                </Field.Root>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="ghost">Close</Button>
              </Dialog.ActionTrigger>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function LeaveGroupButton({ assignment }: { assignment: Assignment }) {
  const supabase = createClient();
  const invalidate = useInvalidate();
  return (
    <PopConfirm
      trigger={
        <Button variant="ghost" colorPalette="red">
          Leave group
        </Button>
      }
      triggerLabel="Leave group"
      confirmHeader="Leave Group"
      confirmText="Are you sure you want to leave this group? You will be removed from the group and will no longer be able to submit assignments as part of this group. If you have already submitted an assignment, your prior group submission will no longer be associated with your account. Your groupmates and the instructor will be notified of your departure."
      onConfirm={async () => {
        const res = await assignmentGroupLeave({ assignment_id: assignment.id }, supabase);
        invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
        toaster.create({ title: "Group left", description: res.message, type: "success" });
      }}
    />
  );
}

function GroupMember({ profile_id }: { profile_id: string }) {
  const profile = useUserProfile(profile_id);
  return (
    <HStack>
      <Avatar.Root size="xs">
        <Avatar.Image src={profile?.avatar_url} />
        <Avatar.Fallback>{profile?.name?.slice(0, 2)}</Avatar.Fallback>
      </Avatar.Root>
      <Text fontSize="sm" color="fg.muted">
        {profile?.name}
      </Text>
    </HStack>
  );
}

function InactiveJoinRequests({ group }: { group: AssignmentGroupWithMembersInvitationsAndJoinRequests }) {
  const nonPendingRequests = group.assignment_group_join_request.filter((j) => j.status !== "pending");
  nonPendingRequests.sort((a, b) => {
    if (a.decided_at && b.decided_at) {
      return b.decided_at.localeCompare(a.decided_at);
    } else if (a.decided_at) {
      return 1;
    } else {
      return -1;
    }
  });
  if (nonPendingRequests.length == 0) {
    return <></>;
  }
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="ghost">View join request history</Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Join Request History</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body maxH="80vh" overflowY="auto">
            {nonPendingRequests.map((j) => (
              <Card.Root key={j.id} p={2}>
                <Card.Title>
                  <GroupMember profile_id={j.profile_id} />
                </Card.Title>
                <Text fontSize="xs" color="fg.muted">
                  ({formatRelative(j.created_at, new Date())})
                </Text>
                <Card.Body m={0} p={2}>
                  <AssignmentGroupJoinRequestStatus join_request={j} />
                </Card.Body>
              </Card.Root>
            ))}
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function AssignmentGroupJoinRequests({ group }: { group: AssignmentGroupWithMembersInvitationsAndJoinRequests }) {
  const pendingRequests = group.assignment_group_join_request.filter((j) => j.status === "pending");
  if (pendingRequests.length == 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        There are no outstanding join requests from other students.
      </Text>
    );
  }
  return (
    <Box>
      <Heading size="sm">Approve or decline join requests</Heading>
      {group.assignment_group_join_request
        .filter((j) => j.status === "pending")
        .map((j) => (
          <AssignmentGroupJoinRequestView join_request={j} key={j.id} />
        ))}
    </Box>
  );
}

function AssignmentGroupJoinRequestView({ join_request }: { join_request: AssignmentGroupJoinRequest }) {
  const profile = useUserProfile(join_request.profile_id);
  const { private_profile_id, role } = useClassProfiles();
  const supabase = createClient();
  const invalidate = useInvalidate();
  const invalidateInvites = useCallback(() => {
    invalidate({ resource: "assignment_group_join_request", invalidates: ["all"] });
    invalidate({ resource: "assignment_groups_members", invalidates: ["all"] });
    invalidate({ resource: "assignment_groups", invalidates: ["all"] });
    invalidate({ resource: "assignment_group_invitations", invalidates: ["all"] });
  }, [invalidate]);
  return (
    <HStack>
      <Text fontSize="sm" color="fg.muted">
        {profile?.name} wants to join your group.
      </Text>
      <PopConfirm
        onConfirm={async () => {
          try {
            const res = await assignmentGroupApproveRequest(
              { join_request_id: join_request.id, course_id: role.class_id },
              supabase
            );
            toaster.create({ title: "Join request approved", description: res.message, type: "success" });
            invalidateInvites();
          } catch (e) {
            if (e instanceof EdgeFunctionError) {
              toaster.create({ title: e.message, description: e.details, type: "error" });
            } else {
              toaster.create({
                title: "Error",
                description: e instanceof Error ? e.message : "An unknown error occurred",
                type: "error"
              });
            }
          }
        }}
        trigger={
          <Button size="xs" colorPalette="green">
            Approve
          </Button>
        }
        triggerLabel="Approve"
        confirmHeader="Approve Join Request"
        confirmText="Are you sure you want to approve this join request?"
      />
      <PopConfirm
        onConfirm={async () => {
          try {
            const { error } = await supabase
              .from("assignment_group_join_request")
              .update({ status: "rejected", decision_maker: private_profile_id })
              .eq("id", join_request.id);
            if (error) {
              throw error;
            }
            toaster.create({
              title: "Join request rejected",
              description: "The join request has been rejected.",
              type: "info"
            });
            invalidateInvites();
          } catch (e) {
            toaster.create({
              title: "Error",
              description: e instanceof Error ? e.message : "An unknown error occurred",
              type: "error"
            });
          }
        }}
        trigger={
          <Button size="xs" colorPalette="red">
            Reject
          </Button>
        }
        triggerLabel="Reject"
        confirmHeader="Reject Join Request"
        confirmText="Are you sure you want to reject this join request?"
      />
    </HStack>
  );
}

function AssignmentGroupJoinRequestStatus({ join_request }: { join_request: AssignmentGroupJoinRequest }) {
  const decider = useUserProfile(join_request.decision_maker);
  return (
    <Box>
      <Text fontSize="sm" color="fg.muted">
        {join_request.status.charAt(0).toUpperCase() + join_request.status.slice(1)} by {decider?.name}
        {join_request.decided_at ? `, ${formatRelative(join_request.decided_at, new Date())}` : ""}
      </Text>
    </Box>
  );
}

function AssignmentGroupInvitationView({
  invitation,
  invalidateInvites
}: {
  invitation: AssignmentGroupInvitation;
  invalidateInvites: () => void;
}) {
  const { private_profile_id } = useClassProfiles();
  let actions = <></>;
  if (invitation.inviter === private_profile_id) {
    actions = (
      <Button
        variant="ghost"
        colorPalette="red"
        onClick={async () => {
          const supabase = createClient();
          await supabase.from("assignment_group_invitations").delete().eq("id", invitation.id);
          invalidateInvites();
        }}
      >
        Rescind
      </Button>
    );
  }
  return (
    <HStack>
      <GroupMember profile_id={invitation.invitee} />
      {actions}
    </HStack>
  );
}

function GroupDetails({
  group,
  allGroups,
  assignment
}: {
  group: AssignmentGroupWithMembersInvitationsAndJoinRequests;
  allGroups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  return (
    <VStack alignItems="flex-start">
      <Heading size="md">You are in group &quot;{group.name}&quot;</Heading>
      <HStack>
        {group.assignment_groups_members.map((m) => (
          <GroupMember profile_id={m.profile_id} key={m.profile_id} />
        ))}
      </HStack>
      <AssignmentGroupJoinRequests group={group} />
      <HStack>
        <InviteButton group={group} allGroups={allGroups} />
        <InactiveJoinRequests group={group} />
        <LeaveGroupButton assignment={assignment} />
      </HStack>
    </VStack>
  );
}

function RepositoriesInfo({ repositories }: { repositories: Repository[] }) {
  if (repositories?.length === 0) {
    return (
      <Text fontSize="sm" color="text.muted">
        No repositories found. Please refresh the page. If this issue persists, please contact your instructor.
      </Text>
    );
  }
  if (repositories?.length === 1) {
    return (
      <HStack>
        <Text fontSize="sm" fontWeight="bold">
          Repository:{" "}
        </Text>
        <Link href={`https://github.com/${repositories[0].repository}`} data-visual-test="blackout">
          {repositories[0].repository}
        </Link>
      </HStack>
    );
  }
  const groupRepo = repositories.find((r) => r.assignment_group_id !== null);
  const personalRepo = repositories.find((r) => r.assignment_group_id === null);
  return (
    <VStack textAlign="left" alignItems="flex-start" fontSize="sm" color="text.muted">
      <HStack>
        <Text fontWeight="bold" fontSize="sm">
          Current group repository:
        </Text>{" "}
        <Link href={`https://github.com/${groupRepo?.repository}`} data-visual-test="blackout">
          {groupRepo?.repository}
        </Link>
      </HStack>
      <Text fontWeight="bold">
        Note that you have multiple repositories currently. Please be sure that you are developing in the correct one
        (the current group repository).
      </Text>
      <Text>
        Individual repository (not in use, you are now in a group):{" "}
        <Link href={`https://github.com/${personalRepo?.repository}`} data-visual-test="blackout">
          {personalRepo?.repository}
        </Link>
      </Text>
    </VStack>
  );
}

export default function ManageGroupWidget({
  assignment,
  repositories
}: {
  assignment: Assignment;
  repositories: Repository[];
}) {
  const { private_profile_id } = useClassProfiles();
  const { time_zone } = useCourse();
  const { data: groups } = useList<AssignmentGroupWithMembersInvitationsAndJoinRequests>({
    resource: "assignment_groups",
    meta: { select: "*,assignment_groups_members(*),assignment_group_join_request(*),assignment_group_invitations(*)" },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment.id }],
    pagination: { pageSize: 1000 }
  });
  const myGroup = useMemo(() => {
    return groups?.data?.find((g) => g.assignment_groups_members.some((m) => m.profile_id === private_profile_id));
  }, [groups, private_profile_id]);

  if (assignment.group_config === "individual") {
    return (
      <Box>
        <Heading size="md">This is an individual assignment.</Heading>
        <Text fontSize="sm" color="fg.muted">
          You will not be able to join a group for this assignment.
        </Text>
        <RepositoriesInfo repositories={repositories} />
      </Box>
    );
  }

  if (!groups?.data) {
    return <Skeleton height="100px" />;
  }
  let heading;
  let description;
  let sizeDesc;
  if (!assignment.min_group_size && !assignment.max_group_size) {
    sizeDesc = `any amount of`;
  } else if (!assignment.min_group_size && assignment.max_group_size) {
    sizeDesc = `at most ${assignment.max_group_size}`;
  } else if (assignment.min_group_size && !assignment.max_group_size) {
    sizeDesc = `at least ${assignment.min_group_size}`;
  } else if (assignment.min_group_size === assignment.max_group_size) {
    sizeDesc = `${assignment.min_group_size}`;
  } else {
    sizeDesc = `${assignment.min_group_size} - ${assignment.max_group_size}`;
  }
  if (assignment.group_config === "groups") {
    heading = "This is a group assignment.";
    description = `You must be part of a group with ${sizeDesc} members to submit this assignment.`;
  } else if (assignment.group_config === "both") {
    heading = "This is a group-optional assignment.";
    description = `You can submit this assignment individually or as part of a group with ${sizeDesc} members.`;
  }

  const groupJoinDeadline = new TZDate(
    assignment.group_formation_deadline || "2030-01-01 00:00:00",
    time_zone || "America/New_York"
  );
  const now = TZDate.tz(time_zone || "America/New_York");
  let actions = <></>;
  if (myGroup) {
    actions = <GroupDetails group={myGroup} allGroups={groups.data} assignment={assignment} />;
  } else if (now > groupJoinDeadline) {
    actions = (
      <Text fontSize="sm" color="fg.muted">
        The group formation deadline has passed. You will not be able to join a group for this assignment.
      </Text>
    );
  } else {
    actions = (
      <HStack>
        <CreateGroupButton assignment={assignment} allGroups={groups.data} />
        <JoinGroupButton groups={groups.data} assignment={assignment} />
      </HStack>
    );
  }
  return (
    <Box>
      <Toaster />
      <Heading size="md">{heading}</Heading>
      <Text fontSize="sm" color="fg.muted">
        {description}
      </Text>
      {actions}
    </Box>
  );
}
