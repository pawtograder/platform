"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { toaster } from "@/components/ui/toaster";
import { useCapabilityOnceLoaded } from "@/hooks/useClassProfiles";
import {
  capabilityLabel,
  deleteRoleDialogCopy,
  editableRoles,
  INSTRUCTOR_ONLY_CAPABILITY,
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
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiEdit2, FiPlus, FiTrash2 } from "react-icons/fi";
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

export default function StaffRolesPage() {
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
  const capabilities = useMemo(
    () => (data?.capabilities ?? []).filter((capability) => capability.name !== INSTRUCTOR_ONLY_CAPABILITY),
    [data]
  );
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
    <Container maxW="container.xl" py={4}>
      <VStack align="stretch" gap={8}>
        <HStack justifyContent="space-between" alignItems="flex-start" gap={4} flexWrap="wrap">
          <Box maxW="3xl">
            <Heading size="lg">Staff roles</Heading>
            <Text color="fg.muted" fontSize="sm" mt={1}>
              Choose what each kind of TA can do. Every grader is on the Grader role unless you move them to a role you
              made. Changes save as you make them and apply the next time that person loads a page. Instructors can
              always do everything.
            </Text>
          </Box>
          <Button colorPalette="green" onClick={() => setDialog({ kind: "create" })}>
            <FiPlus aria-hidden="true" /> New role
          </Button>
        </HStack>

        <Box as="section" aria-labelledby="staff-roles-capabilities">
          <Heading as="h2" size="md" id="staff-roles-capabilities" mb={3}>
            What each role can do
          </Heading>
          {capabilities.length === 0 ? (
            <Text color="fg.muted">There is nothing to turn on or off yet.</Text>
          ) : (
            <Table.ScrollArea borderWidth="1px" borderRadius="md">
              <Table.Root size="sm" aria-labelledby="staff-roles-capabilities">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader scope="col" minW="16rem">
                      Action
                    </Table.ColumnHeader>
                    {roles.map((role) => {
                      const count = memberCounts.get(role.id) ?? 0;
                      const isCustom = role.default_for === null;
                      return (
                        <Table.ColumnHeader key={role.id} scope="col" minW="9rem" verticalAlign="top">
                          <HStack gap={1} alignItems="center">
                            <Text fontWeight="semibold">{roleDisplayName(role)}</Text>
                            {isCustom && (
                              <>
                                <IconButton
                                  size="2xs"
                                  variant="ghost"
                                  aria-label={`Rename ${role.name}`}
                                  onClick={() => setDialog({ kind: "rename", role })}
                                >
                                  <FiEdit2 />
                                </IconButton>
                                <IconButton
                                  size="2xs"
                                  variant="ghost"
                                  colorPalette="red"
                                  aria-label={`Delete ${role.name}`}
                                  onClick={() => setDialog({ kind: "delete", role })}
                                >
                                  <FiTrash2 />
                                </IconButton>
                              </>
                            )}
                          </HStack>
                          <Text fontSize="xs" fontWeight="normal" color="fg.muted">
                            {isCustom ? "" : "Default · "}
                            {count === 1 ? "1 person" : `${count} people`}
                          </Text>
                        </Table.ColumnHeader>
                      );
                    })}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {capabilities.map((capability) => (
                    <Table.Row key={capability.name}>
                      <Table.Cell as="th" scope="row" textAlign="start" fontWeight="normal">
                        <Text fontWeight="medium">{capabilityLabel(capability.name)}</Text>
                        <Text fontSize="xs" color="fg.muted">
                          {capability.description}
                        </Text>
                      </Table.Cell>
                      {roles.map((role) => {
                        const key = heldKey(role.id, capability.name);
                        const checked = pendingHeld.has(key) ? pendingHeld.get(key)! : data.held.has(key);
                        return (
                          <Table.Cell key={role.id}>
                            <Checkbox
                              checked={checked}
                              disabled={saving.has(key)}
                              onCheckedChange={(details) =>
                                toggleCapability(role, capability.name, details.checked === true)
                              }
                              inputProps={{
                                "aria-label": `${roleDisplayName(role)}: ${capabilityLabel(capability.name)}`
                              }}
                            />
                          </Table.Cell>
                        );
                      })}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Table.ScrollArea>
          )}
        </Box>

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
                          <NativeSelect.Root size="sm" maxW="16rem" disabled={movingUserRoleIds.has(grader.userRoleId)}>
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
      </VStack>

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
    </Container>
  );
}
