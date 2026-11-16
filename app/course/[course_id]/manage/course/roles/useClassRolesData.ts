"use client";

import { useCourseController } from "@/hooks/useCourseController";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useRef, useState } from "react";

export type ClassRole = { id: number; name: string; default_for: string | null };
export type Capability = { name: string; description: string };
export type GraderOnRole = { userRoleId: number; classRoleId: number; name: string };
/** Every enrollment on a role: active graders for the People table, plus disabled rows the FK still holds. */
export type RoleEnrollment = { classRoleId: number; disabled: boolean };

export type ClassRolesData = {
  roles: ClassRole[];
  capabilities: Capability[];
  /** `${roleId}:${capability}` for every capability a role holds. */
  held: Set<string>;
  graders: GraderOnRole[];
  /** All class enrollments on a grader or custom role (active and disabled), for delete-dialog counts. */
  roleEnrollments: RoleEnrollment[];
};

export const heldKey = (roleId: number, capability: string) => `${roleId}:${capability}`;

/** Other people's changes arrive as staff channel notes; a burst gives one reload. */
const RELOAD_DEBOUNCE_MS = 500;

async function fetchClassRolesData(classId: number): Promise<ClassRolesData> {
  const supabase = createClient();
  const [rolesResult, capabilitiesResult, gradersResult, enrollmentsResult] = await Promise.all([
    supabase.from("class_roles").select("id, name, default_for").eq("class_id", classId),
    supabase.from("capabilities").select("name, description").order("name"),
    supabase
      .from("user_roles")
      .select("id, class_role_id, privateProfile:profiles!private_profile_id(name)")
      .eq("class_id", classId)
      .eq("role", "grader")
      .eq("disabled", false),
    // Active and disabled: the delete FK counts every enrollment on the role, not only active graders.
    supabase
      .from("user_roles")
      .select("class_role_id, disabled")
      .eq("class_id", classId)
      .not("class_role_id", "is", null)
  ]);
  if (rolesResult.error) throw rolesResult.error;
  if (capabilitiesResult.error) throw capabilitiesResult.error;
  if (gradersResult.error) throw gradersResult.error;
  if (enrollmentsResult.error) throw enrollmentsResult.error;

  const roles = rolesResult.data ?? [];
  const roleIds = new Set(roles.map((role) => role.id));
  const held = new Set<string>();
  if (roleIds.size > 0) {
    const { data, error } = await supabase
      .from("role_capabilities")
      .select("role_id, capability")
      .in("role_id", [...roleIds]);
    if (error) throw error;
    for (const row of data ?? []) {
      held.add(heldKey(row.role_id, row.capability));
    }
  }

  const graders = (gradersResult.data ?? [])
    .map((row) => ({
      userRoleId: row.id,
      classRoleId: row.class_role_id,
      name: row.privateProfile?.name ?? "Unnamed grader"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Only enrollments that sit on a role of this class (grader default or custom).
  const roleEnrollments = (enrollmentsResult.data ?? [])
    .filter((row) => roleIds.has(row.class_role_id))
    .map((row) => ({ classRoleId: row.class_role_id, disabled: row.disabled }));

  return { roles, capabilities: capabilitiesResult.data ?? [], held, graders, roleEnrollments };
}

/**
 * The class's roles, their capabilities and the graders on them. Capability changes and people
 * moving between roles arrive live on the staff channel; a role another instructor creates,
 * renames or deletes is not broadcast, so it appears on the next reload (including when the staff
 * channel rejoins after a gap). `setData` is for optimistic updates; `reload` asks the database again.
 */
export function useClassRolesData(classId: number) {
  const controller = useCourseController();
  const [data, setData] = useState<ClassRolesData | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await fetchClassRolesData(classId);
      // A slower, older answer must not replace a newer one.
      if (request !== requestRef.current) return;
      setData(next);
      setLoadError(undefined);
    } catch (error) {
      if (request !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : "The roles for this class couldn't be loaded.");
    }
  }, [classId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
    };
    const staffTopic = `class:${classId}:staff`;
    let lastStaffState: string | undefined;
    const onStatus = (status: ConnectionStatus) => {
      const staff = status.channels.find((channel) => channel.name === staffTopic);
      if (!staff) return;
      // Notes sent while the channel was down aren't replayed; rejoin is the catch-up.
      if (staff.state === "joined" && lastStaffState !== "joined") scheduleReload();
      lastStaffState = staff.state;
    };
    const realtime = controller.classRealTimeController;
    const unsubscribers = [
      realtime.subscribeToTable("role_capabilities", scheduleReload),
      realtime.subscribeToTable("user_roles", scheduleReload),
      realtime.subscribeToStatus(onStatus)
    ];
    return () => {
      clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [controller, classId, reload]);

  return { data, setData, loadError, reload };
}
