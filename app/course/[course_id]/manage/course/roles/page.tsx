"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { toaster } from "@/components/ui/toaster";
import { useCapabilityOnceLoaded } from "@/hooks/useClassProfiles";
import {
  capabilityLabel,
  editableRoles,
  INSTRUCTOR_ONLY_CAPABILITY,
  ROLE_CHANGE_REFUSED_MESSAGE,
  roleChangeErrorMessage,
  roleDisplayName
} from "@/lib/classRoles";
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
import { useCallback, useMemo, useState } from "react";
import { FiEdit2, FiPlus, FiTrash2 } from "react-icons/fi";
import { DeleteRoleDialog, RoleNameDialog } from "./roleDialogs";
import { heldKey, useClassRolesData, type ClassRole, type ClassRolesData } from "./useClassRolesData";

type OpenDialog = { kind: "create" } | { kind: "rename"; role: ClassRole } | { kind: "delete"; role: ClassRole };

function showRefused(description: string) {
  // A refusal is an answer, not a bug: no "Report this" action.
  toaster.error({ title: "Not saved", description, meta: { reportable: false } });
}

export default function StaffRolesPage() {
  const { course_id } = useParams();
  const classId = Number.parseInt(course_id as string, 10);
  const canManageRoles = useCapabilityOnceLoaded("manage_roles");
  const { data, setData, loadError, reload } = useClassRolesData(classId);
  const announce = useAnnouncer();
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [movingUserRoleId, setMovingUserRoleId] = useState<number | undefined>();
  const [dialog, setDialog] = useState<OpenDialog | undefined>();

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

  const setHeld = useCallback(
    (roleId: number, capability: string, isHeld: boolean) => {
      setData((prev: ClassRolesData | undefined) => {
        if (!prev) return prev;
        const held = new Set(prev.held);
        if (isHeld) held.add(heldKey(roleId, capability));
        else held.delete(heldKey(roleId, capability));
        return { ...prev, held };
      });
    },
    [setData]
  );

  const toggleCapability = useCallback(
    async (role: ClassRole, capability: string, turnOn: boolean) => {
      const key = heldKey(role.id, capability);
      const roleName = roleDisplayName(role);
      setSaving((prev) => new Set(prev).add(key));
      setHeld(role.id, capability, turnOn);

      const supabase = createClient();
      // .select() returns the rows written, so a write a policy refuses without an error (no rows)
      // isn't reported as saved.
      const { data: written, error } = turnOn
        ? await supabase.from("role_capabilities").insert({ role_id: role.id, capability }).select("role_id")
        : await supabase
            .from("role_capabilities")
            .delete()
            .eq("role_id", role.id)
            .eq("capability", capability)
            .select("role_id");

      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      if (error || !written || written.length === 0) {
        setHeld(role.id, capability, !turnOn);
        const message = error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE;
        showRefused(message);
        announce(`${roleName}, ${capabilityLabel(capability)}: not saved. ${message}`, { priority: "assertive" });
        // The page may be out of date (another instructor changed the same role).
        reload();
        return;
      }
      announce(`${roleName}: ${capabilityLabel(capability)} turned ${turnOn ? "on" : "off"}. Saved.`);
    },
    [announce, reload, setHeld]
  );

  const createRole = useCallback(
    async (name: string) => {
      const { error } = await createClient().from("class_roles").insert({ class_id: classId, name });
      if (error) return roleChangeErrorMessage(error);
      await reload();
      toaster.success({ title: `${name} created`, description: "It starts with everything a Grader can do." });
      return undefined;
    },
    [classId, reload]
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
      await reload();
      toaster.success({ title: `Renamed to ${name}` });
      return undefined;
    },
    [reload]
  );

  const deleteRole = useCallback(
    async (role: ClassRole) => {
      const { data: written, error } = await createClient().from("class_roles").delete().eq("id", role.id).select("id");
      if (error || !written || written.length === 0) {
        showRefused(error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE);
      } else {
        toaster.success({ title: `${role.name} deleted` });
      }
      await reload();
    },
    [reload]
  );

  const moveGrader = useCallback(
    async (userRoleId: number, graderName: string, classRoleId: number) => {
      const target = roles.find((role) => role.id === classRoleId);
      if (!target) return;
      setMovingUserRoleId(userRoleId);
      const { data: written, error } = await createClient()
        .from("user_roles")
        .update({ class_role_id: classRoleId })
        .eq("id", userRoleId)
        .select("id");
      setMovingUserRoleId(undefined);
      if (error || !written || written.length === 0) {
        const message = error ? roleChangeErrorMessage(error) : ROLE_CHANGE_REFUSED_MESSAGE;
        showRefused(message);
        announce(`${graderName}'s role was not changed. ${message}`, { priority: "assertive" });
      } else {
        announce(`${graderName} is now on ${roleDisplayName(target)}. Saved.`);
      }
      await reload();
    },
    [announce, reload, roles]
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
        <Button onClick={() => reload()}>Try again</Button>
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
                        return (
                          <Table.Cell key={role.id}>
                            <Checkbox
                              checked={data.held.has(key)}
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
                  {data.graders.map((grader) => (
                    <Table.Row key={grader.userRoleId}>
                      <Table.Cell as="th" scope="row" textAlign="start" fontWeight="normal">
                        {grader.name}
                      </Table.Cell>
                      <Table.Cell>
                        <NativeSelect.Root size="sm" maxW="16rem" disabled={movingUserRoleId === grader.userRoleId}>
                          <NativeSelect.Field
                            aria-label={`Role for ${grader.name}`}
                            value={String(grader.classRoleId)}
                            onChange={(event) => moveGrader(grader.userRoleId, grader.name, Number(event.target.value))}
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
                  ))}
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
          memberCount={memberCounts.get(dialog.role.id) ?? 0}
          onDelete={() => deleteRole(dialog.role)}
          onClose={() => setDialog(undefined)}
        />
      )}
    </Container>
  );
}
