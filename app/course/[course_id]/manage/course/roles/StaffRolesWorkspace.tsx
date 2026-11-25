"use client";

import { Button } from "@/components/ui/button";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import NextLink from "next/link";
import { groupCapabilities } from "./capabilityCatalog";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { toaster } from "@/components/ui/toaster";
import { useCapabilityOnceLoaded } from "@/hooks/useClassProfiles";
import {
  capabilityLabel,
  deleteRoleDialogCopy,
  editableRoles,
  ROLE_CHANGE_REFUSED_MESSAGE,
  roleChangeErrorMessage,
  roleDisplayName,
  type RoleMembershipCounts
} from "@/lib/classRoles";
import { useCourseController } from "@/hooks/useCourseController";
import { useIsTableControllerReady, useTableControllerTableValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Box,
  Container,
  Heading,
  HStack,
  IconButton,
  NativeSelect,
  Skeleton,
  Switch,
  VisuallyHidden,
  Tabs,
  Flex,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiEdit2, FiPlus, FiTrash2, FiInfo } from "react-icons/fi";
import { DeleteRoleDialog, RoleNameDialog } from "./roleDialogs";
import { heldKey, type ClassRole } from "./roleTypes";

type OpenDialog = { kind: "create" } | { kind: "rename"; role: ClassRole } | { kind: "delete"; role: ClassRole };

function showRefused(description: string) {
  // A refusal is an answer, not a bug: no "Report this" action.
  toaster.error({ title: "Not saved", description, meta: { reportable: false } });
}

function membershipCountsForRole(
  enrollments: { classRoleId: number; disabled: boolean }[],
  roleId: number
): RoleMembershipCounts {
  let active = 0;
  let disabled = 0;
  for (const row of enrollments) {
    if (row.classRoleId !== roleId) continue;
    if (row.disabled) disabled += 1;
    else active += 1;
  }
  return { active, disabled };
}

export default function StaffRolesWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [editRoleId, setEditRoleId] = useState<string>("");
  const { course_id } = useParams();
  const classId = Number.parseInt(course_id as string, 10);
  const canManageRoles = useCapabilityOnceLoaded("manage_roles");
  const controller = useCourseController();
  const roleRows = useTableControllerTableValues(controller.classRoles);
  const capabilityRows = useTableControllerTableValues(controller.capabilities);
  const heldRows = useTableControllerTableValues(controller.roleCapabilities);
  const enrollments = useTableControllerTableValues(controller.userRolesWithProfiles);
  const rolesReady = useIsTableControllerReady(controller.classRoles);
  const capabilitiesReady = useIsTableControllerReady(controller.capabilities);
  const heldReady = useIsTableControllerReady(controller.roleCapabilities);
  const peopleReady = useIsTableControllerReady(controller.userRolesWithProfiles);
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let active = true;
    Promise.all([
      controller.classRoles.readyPromise,
      controller.capabilities.readyPromise,
      controller.roleCapabilities.readyPromise,
      controller.userRolesWithProfiles.readyPromise
    ]).catch((error) => {
      if (active) setLoadError(error?.message ?? String(error));
    });
    return () => {
      active = false;
    };
  }, [controller]);
  const data = useMemo(
    () =>
      rolesReady && capabilitiesReady && heldReady && peopleReady
        ? {
            roles: roleRows,
            capabilities: [...capabilityRows].sort((a, b) => a.name.localeCompare(b.name)),
            held: new Set(heldRows.map((row) => heldKey(row.role_id, row.capability))),
            graders: enrollments
              .filter((row) => row.role === "grader" && !row.disabled)
              .map((row) => ({
                userRoleId: row.id,
                classRoleId: row.class_role_id!,
                name: row.profiles?.name ?? "Unnamed grader"
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            roleEnrollments: enrollments
              .filter((row) => row.class_role_id != null)
              .map((row) => ({
                classRoleId: row.class_role_id!,
                disabled: row.disabled
              }))
          }
        : undefined,
    [rolesReady, capabilitiesReady, heldReady, peopleReady, roleRows, capabilityRows, heldRows, enrollments]
  );
  const announce = useAnnouncer();
  const mountedRef = useRef(true);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // Keep a saved value on screen until a fetch of that key succeeds or the controller shows it.
  const [pendingHeld, setPendingHeld] = useState<Map<string, boolean>>(new Map());
  const [movingUserRoleIds, setMovingUserRoleIds] = useState<Set<number>>(new Set());
  const [pendingMoves, setPendingMoves] = useState<Map<number, number>>(new Map());
  const [dialog, setDialog] = useState<OpenDialog | undefined>();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPendingHeld((prev) => {
      const next = new Map(prev);
      for (const [key, value] of prev) {
        if (!saving.has(key) && data?.held.has(key) === value) next.delete(key);
      }
      return next.size === prev.size ? prev : next;
    });
    setPendingMoves((prev) => {
      const next = new Map(prev);
      for (const [id, roleId] of prev) {
        if (!movingUserRoleIds.has(id) && data?.graders.some((g) => g.userRoleId === id && g.classRoleId === roleId)) {
          next.delete(id);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [data, saving, movingUserRoleIds]);

  // Returns whether the fetch succeeded. When it did, the controller holds the database's current
  // value, which may differ from this page's write if another instructor changed it since.
  const refresh = useCallback(
    async (table: "classRoles" | "roleCapabilities" | "userRolesWithProfiles", key: number | string) => {
      // Broadcasts usually apply the change first. Fetch only this key if a note was missed.
      try {
        if (table === "roleCapabilities") await controller.roleCapabilities.invalidate(String(key));
        else await controller[table].invalidate(Number(key));
        return true;
      } catch {
        toaster.error({ title: "Staff roles could not be refreshed", description: "Reload the page to try again." });
        return false;
      }
    },
    [controller]
  );

  const roles = useMemo(() => editableRoles(data?.roles ?? []), [data]);
  const groups = useMemo(() => groupCapabilities(data?.capabilities ?? []), [data]);
  const selectedRole = roles.find((role) => String(role.id) === search.get("role")) ?? roles[0];
  const editRole = roles.find((role) => String(role.id) === editRoleId);
  const base = `/course/${classId}/manage/course/roles`;
  const view = pathname.endsWith("/capabilities") ? "capabilities" : pathname.endsWith("/staff") ? "staff" : "edit";
  const memberCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const grader of data?.graders ?? []) {
      counts.set(grader.classRoleId, (counts.get(grader.classRoleId) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  const toggleCapability = useCallback(
    async (role: ClassRole, capability: string, turnOn: boolean) => {
      const key = heldKey(role.id, capability);
      const roleName = roleDisplayName(role);
      setSaving((prev) => new Set(prev).add(key));
      setPendingHeld((prev) => new Map(prev).set(key, turnOn));

      const supabase = createClient();
      // Ask for changed rows so a policy refusal with no error is still detected.
      const { data: written, error } = turnOn
        ? await supabase.from("role_capabilities").insert({ role_id: role.id, capability }).select("role_id")
        : await supabase
            .from("role_capabilities")
            .delete()
            .eq("role_id", role.id)
            .eq("capability", capability)
            .select("role_id");

      if (!mountedRef.current) {
        return;
      }

      const fetched = await refresh("roleCapabilities", JSON.stringify([role.id, capability]));

      // This request controls when the cell becomes usable again.
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      if (fetched || error || !written || written.length === 0) {
        setPendingHeld((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
      if (error || !written || written.length === 0) {
        const message = error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE;
        showRefused(message);
        announce(`${roleName}, ${capabilityLabel(capability)}: not saved. ${message}`, { priority: "assertive" });
        // The page may be out of date (another instructor changed the same role).
        return;
      }
      announce(`${roleName}: ${capabilityLabel(capability)} turned ${turnOn ? "on" : "off"}. Saved.`);
    },
    [announce, refresh]
  );

  const createRole = useCallback(
    async (name: string) => {
      const { data: written, error } = await createClient()
        .from("class_roles")
        .insert({ class_id: classId, name })
        .select("id")
        .single();
      if (error) return roleChangeErrorMessage(error);
      await refresh("classRoles", written!.id);
      // The insert trigger copies the default grader's capabilities onto this role. One fetch for
      // all of them, so a network failure shows one toast.
      try {
        await controller.roleCapabilities.refetchByIds(
          capabilityRows.map((cap) => JSON.stringify([written!.id, cap.name]))
        );
      } catch {
        toaster.error({ title: "Staff roles could not be refreshed", description: "Reload the page to try again." });
      }
      if (!mountedRef.current) return undefined;
      toaster.success({ title: `${name} created`, description: "It starts with everything a Grader can do." });
      return undefined;
    },
    [classId, refresh, capabilityRows, controller]
  );

  const renameRole = useCallback(
    async (role: ClassRole, name: string) => {
      const { data: written, error } = await createClient()
        .from("class_roles")
        .update({ name })
        .eq("id", role.id)
        .select("id");
      if (error) return roleChangeErrorMessage(error);
      if (!written || written.length === 0) return ROLE_CHANGE_REFUSED_MESSAGE;
      await refresh("classRoles", role.id);
      if (!mountedRef.current) return undefined;
      toaster.success({ title: `Renamed to ${name}` });
      return undefined;
    },
    [refresh]
  );

  const deleteRole = useCallback(
    async (role: ClassRole) => {
      const { data: written, error } = await createClient().from("class_roles").delete().eq("id", role.id).select("id");
      if (mountedRef.current) {
        if (error || !written || written.length === 0) {
          showRefused(error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE);
        } else {
          toaster.success({ title: `${role.name} deleted` });
        }
      }
      await refresh("classRoles", role.id);
    },
    [refresh]
  );

  const moveGrader = useCallback(
    async (userRoleId: number, graderName: string, classRoleId: number) => {
      const target = roles.find((role) => role.id === classRoleId);
      if (!target) return;
      setMovingUserRoleIds((prev) => new Set(prev).add(userRoleId));
      setPendingMoves((prev) => new Map(prev).set(userRoleId, classRoleId));
      // Changing class_role_id still requires an instructor in the database.
      // Only instructors currently hold manage_roles, which gates this page.
      const { data: written, error } = await createClient()
        .from("user_roles")
        .update({ class_role_id: classRoleId })
        .eq("id", userRoleId)
        .select("id");
      if (!mountedRef.current) {
        return;
      }
      const fetched = await refresh("userRolesWithProfiles", userRoleId);
      const writeOk = !error && written && written.length > 0;
      if (!writeOk) {
        const message = error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE;
        showRefused(message);
        announce(`${graderName}'s role was not changed. ${message}`, { priority: "assertive" });
      } else {
        announce(`${graderName} is now on ${roleDisplayName(target)}. Saved.`);
      }
      // Keep the saved selection until the controller confirms it.
      setMovingUserRoleIds((prev) => {
        const next = new Set(prev);
        next.delete(userRoleId);
        return next;
      });
      if (fetched || !writeOk) {
        setPendingMoves((prev) => {
          const next = new Map(prev);
          next.delete(userRoleId);
          return next;
        });
      }
    },
    [announce, refresh, roles]
  );

  if (canManageRoles === undefined || (!data && !loadError)) {
    return (
      <Container maxW="container.xl" py={4} aria-busy="true">
        <Heading size="lg" mb={4}>
          Staff roles
        </Heading>
        <Skeleton height="200px" />
      </Container>
    );
  }

  if (!canManageRoles) {
    return (
      <Container maxW="container.xl" py={4}>
        <Heading size="lg" mb={2}>
          Staff roles
        </Heading>
        <Text>Only instructors can manage staff roles. Ask an instructor if your access needs to change.</Text>
      </Container>
    );
  }

  if (!data) {
    return (
      <Container maxW="container.xl" py={4}>
        <Heading size="lg" mb={2}>
          Staff roles
        </Heading>
        <Text role="alert" mb={3}>
          The roles for this class couldn&apos;t be loaded: {loadError}
        </Text>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </Container>
    );
  }

  return (
    <Flex direction={{ base: "column", lg: "row" }} gap={4} pt={4}>
      <Box as="nav" aria-label="Staff roles" minW={{ lg: "14rem" }}>
        <VStack align="stretch">
          {[
            ["edit", "", "Create / Edit Role"],
            ["staff", "/staff", "Staff & Roles"],
            ["capabilities", "/capabilities", "Roles & Capabilities"]
          ].map(([key, suffix, label]) => (
            <Button key={key} asChild variant={view === key ? "solid" : "ghost"} justifyContent="flex-start">
              <NextLink href={`${base}${suffix}`} aria-current={view === key ? "page" : undefined}>
                {label}
              </NextLink>
            </Button>
          ))}
        </VStack>
      </Box>
      <Box borderWidth="2px" borderColor="border.muted" borderRadius="md" p={4} flex="1" minW="0">
        <Heading size="lg" mb={2}>
          Staff roles
        </Heading>
        <Text color="fg.muted" mb={6}>
          Choose what each kind of TA can do. Changes save as you make them and apply the next time that person loads a
          page. Instructors can always do everything.
        </Text>
        {view === "edit" && (
          <VStack align="stretch" gap={5}>
            <Heading as="h2" size="md">
              Create / Edit Role
            </Heading>
            <HStack gap={4} flexWrap="wrap">
              <Button size="lg" colorPalette="green" onClick={() => setDialog({ kind: "create" })}>
                <FiPlus aria-hidden="true" />
                Create a role
              </Button>
              <Button size="lg" variant="outline" onClick={() => setEditing(true)}>
                <FiEdit2 aria-hidden="true" />
                Edit a role
              </Button>
            </HStack>
            {editing && (
              <VStack align="stretch" gap={3}>
                <NativeSelect.Root>
                  <NativeSelect.Field
                    aria-label="Role to edit"
                    value={editRoleId}
                    onChange={(e) => setEditRoleId(e.target.value)}
                  >
                    <option value="">Choose a role</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {roleDisplayName(role)}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
                {editRole && (
                  <HStack flexWrap="wrap">
                    {editRole.default_for === null && (
                      <>
                        <Button
                          variant="outline"
                          aria-label={`Rename ${editRole.name}`}
                          onClick={() => setDialog({ kind: "rename", role: editRole })}
                        >
                          <FiEdit2 />
                          Rename
                        </Button>
                        <Button
                          variant="outline"
                          colorPalette="red"
                          aria-label={`Delete ${editRole.name}`}
                          onClick={() => setDialog({ kind: "delete", role: editRole })}
                        >
                          <FiTrash2 />
                          Delete
                        </Button>
                      </>
                    )}
                    <Button asChild variant="outline">
                      <NextLink href={`${base}/capabilities?role=${editRole.id}`}>
                        Edit capabilities for {roleDisplayName(editRole)}
                      </NextLink>
                    </Button>
                  </HStack>
                )}
              </VStack>
            )}
          </VStack>
        )}
        {view === "capabilities" && (
          <VStack align="stretch" gap={5}>
            <Heading as="h2" size="md">
              Roles &amp; Capabilities
            </Heading>
            <NativeSelect.Root maxW="sm">
              <NativeSelect.Field
                aria-label="Role capabilities"
                value={selectedRole?.id ?? ""}
                onChange={(e) => router.replace(`${base}/capabilities?role=${e.target.value}`)}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {roleDisplayName(role)}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
            {groups.length === 0 && <Text>There is nothing to turn on or off yet.</Text>}
            {selectedRole &&
              groups.map((group) => (
                <Box as="section" aria-label={group.area} key={group.area} borderWidth="1px" borderRadius="md" p={4}>
                  <Heading as="h3" size="md" mb={4}>
                    {group.area}
                  </Heading>
                  {group.sections.map((section) => (
                    <Box as="section" aria-label={section.name} key={section.name} mb={4}>
                      <Heading as="h4" size="sm" mb={2}>
                        {section.name}
                      </Heading>
                      {section.capabilities.map((capability) => {
                        const key = heldKey(selectedRole.id, capability.name);
                        const checked = pendingHeld.has(key) ? pendingHeld.get(key)! : data.held.has(key);
                        return (
                          <HStack
                            key={key}
                            justify="space-between"
                            py={2}
                            borderBottomWidth="1px"
                            borderColor="border.muted"
                          >
                            <HStack>
                              <Text>{capability.label}</Text>
                              {/* A click-to-open toggletip, not a hover tooltip: it has to work on touch,
                                  on click and from a screen reader. */}
                              <PopoverRoot positioning={{ placement: "top" }}>
                                <PopoverTrigger asChild>
                                  <IconButton size="2xs" variant="ghost" aria-label={`About ${capability.label}`}>
                                    <FiInfo />
                                  </IconButton>
                                </PopoverTrigger>
                                <PopoverContent maxW="sm">
                                  <PopoverArrow />
                                  <PopoverBody>
                                    <Text fontSize="sm">{capability.info}</Text>
                                  </PopoverBody>
                                </PopoverContent>
                              </PopoverRoot>
                              <VisuallyHidden id={`capability-info-${capability.name}`}>
                                {capability.info}
                              </VisuallyHidden>
                            </HStack>
                            <Switch.Root
                              checked={checked}
                              disabled={saving.has(key)}
                              onCheckedChange={(details) =>
                                toggleCapability(selectedRole, capability.name, details.checked)
                              }
                            >
                              <Switch.HiddenInput
                                role="switch"
                                aria-label={`${roleDisplayName(selectedRole)}: ${capability.label}`}
                                aria-describedby={`capability-info-${capability.name}`}
                              />
                              <Switch.Control>
                                <Switch.Thumb />
                              </Switch.Control>
                            </Switch.Root>
                          </HStack>
                        );
                      })}
                    </Box>
                  ))}
                </Box>
              ))}
          </VStack>
        )}
        {view === "staff" && (
          <Tabs.Root defaultValue="staff">
            <Heading as="h2" size="md" mb={3}>
              Staff &amp; Roles
            </Heading>
            <Tabs.List>
              <Tabs.Trigger value="staff">Staff</Tabs.Trigger>
              <Tabs.Trigger value="roles">Roles</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="staff">
              <Box as="section" aria-labelledby="staff-roles-people">
                <Heading as="h2" size="md" id="staff-roles-people" mb={1}>
                  People
                </Heading>
                <Text color="fg.muted" fontSize="sm" mb={3}>
                  Put a grader on a role. To make someone a grader or an instructor, use Enrollments.
                </Text>
                {data.graders.length === 0 ? (
                  <Text color="fg.muted">This class has no graders yet.</Text>
                ) : (
                  <Table.ScrollArea borderWidth="1px" borderRadius="md" maxW="2xl">
                    <Table.Root size="sm" aria-labelledby="staff-roles-people">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader scope="col">Grader</Table.ColumnHeader>
                          <Table.ColumnHeader scope="col">Role</Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {data.graders.map((grader) => {
                          const pendingRoleId = pendingMoves.get(grader.userRoleId);
                          const selectedRoleId = pendingRoleId ?? grader.classRoleId;
                          return (
                            <Table.Row key={grader.userRoleId}>
                              <Table.Cell as="th" scope="row" textAlign="start" fontWeight="normal">
                                {grader.name}
                              </Table.Cell>
                              <Table.Cell>
                                <NativeSelect.Root
                                  size="sm"
                                  maxW="16rem"
                                  disabled={movingUserRoleIds.has(grader.userRoleId)}
                                >
                                  <NativeSelect.Field
                                    aria-label={`Role for ${grader.name}`}
                                    value={String(selectedRoleId)}
                                    onChange={(event) =>
                                      moveGrader(grader.userRoleId, grader.name, Number(event.target.value))
                                    }
                                  >
                                    {roles.map((role) => (
                                      <option key={role.id} value={String(role.id)}>
                                        {roleDisplayName(role)}
                                      </option>
                                    ))}
                                  </NativeSelect.Field>
                                  <NativeSelect.Indicator />
                                </NativeSelect.Root>
                              </Table.Cell>
                            </Table.Row>
                          );
                        })}
                      </Table.Body>
                    </Table.Root>
                  </Table.ScrollArea>
                )}
              </Box>
            </Tabs.Content>
            <Tabs.Content value="roles">
              <Table.Root aria-label="Role membership counts">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Role</Table.ColumnHeader>
                    <Table.ColumnHeader>People</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {roles.map((role) => {
                    const count = memberCounts.get(role.id) ?? 0;
                    const removed = membershipCountsForRole(data.roleEnrollments, role.id).disabled;
                    return (
                      <Table.Row key={role.id}>
                        <Table.Cell>
                          <NextLink href={`${base}/capabilities?role=${role.id}`}>{roleDisplayName(role)}</NextLink>
                        </Table.Cell>
                        <Table.Cell>
                          {count === 1 ? "1 person" : `${count} people`}
                          {removed > 0 && ` (${removed} removed)`}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Tabs.Content>
          </Tabs.Root>
        )}
      </Box>
      {dialog?.kind === "create" && (
        <RoleNameDialog
          mode="create"
          existingRoles={data.roles}
          onSave={createRole}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "rename" && (
        <RoleNameDialog
          mode="rename"
          role={dialog.role}
          existingRoles={data.roles}
          onSave={(name) => renameRole(dialog.role, name)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteRoleDialog
          role={dialog.role}
          copy={deleteRoleDialogCopy(membershipCountsForRole(data.roleEnrollments, dialog.role.id))}
          onDelete={() => deleteRole(dialog.role)}
          onClose={() => setDialog(undefined)}
        />
      )}
    </Flex>
  );
}
