"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useRef, useState } from "react";

export type ClassRole = { id: number; name: string; default_for: string | null };
export type Capability = { name: string; description: string };
export type GraderOnRole = { userRoleId: number; classRoleId: number; name: string };

export type ClassRolesData = {
  roles: ClassRole[];
  capabilities: Capability[];
  /** `${roleId}:${capability}` for every capability a role holds. */
  held: Set<string>;
  graders: GraderOnRole[];
};

export const heldKey = (roleId: number, capability: string) => `${roleId}:${capability}`;

/** Other people's changes arrive as staff channel notes; a burst gives one reload. */
const RELOAD_DEBOUNCE_MS = 500;

async function fetchClassRolesData(classId: number): Promise<ClassRolesData> {
  const supabase = createClient();
  const [rolesResult, capabilitiesResult, gradersResult] = await Promise.all([
    supabase.from("class_roles").select("id, name, default_for").eq("class_id", classId),
    supabase.from("capabilities").select("name, description").order("name"),
    supabase
      .from("user_roles")
      .select("id, class_role_id, privateProfile:profiles!private_profile_id(name)")
      .eq("class_id", classId)
      .eq("role", "grader")
      .eq("disabled", false)
  ]);
  if (rolesResult.error) throw rolesResult.error;
  if (capabilitiesResult.error) throw capabilitiesResult.error;
  if (gradersResult.error) throw gradersResult.error;

  const roles = rolesResult.data ?? [];
  const roleIds = roles.map((role) => role.id);
  const held = new Set<string>();
  if (roleIds.length > 0) {
    const { data, error } = await supabase
      .from("role_capabilities")
      .select("role_id, capability")
      .in("role_id", roleIds);
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

  return { roles, capabilities: capabilitiesResult.data ?? [], held, graders };
}

/**
 * The class's roles, their capabilities and the graders on them. Reloads when the staff channel
 * says a role's capabilities or someone's role changed, so two instructors editing see each other.
 * `setData` is for optimistic updates; `reload` asks the database again.
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
    const realtime = controller.classRealTimeController;
    const unsubscribers = [
      realtime.subscribeToTable("role_capabilities", scheduleReload),
      realtime.subscribeToTable("user_roles", scheduleReload)
    ];
    return () => {
      clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [controller, reload]);

  return { data, setData, loadError, reload };
}
