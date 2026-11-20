"use client";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import type { BroadcastMessage } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";
import { ClassCapabilitiesContext, ClassCapabilitiesState, useClassProfiles } from "./useClassProfiles";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";

const VIEWING_AS_STUDENT: ClassCapabilitiesState = { capabilities: new Set(), isLoading: false };

/** A burst of relevant notes within this window gives one re-ask. */
export const CAPABILITY_REFRESH_DEBOUNCE_MS = 1000;

/**
 * Whether a staff channel note can change what the viewer holds: a change to a role's
 * capabilities in this class, or to the viewer's own user_roles row. Other people's user_roles
 * changes (a roster sync adding 200 students) are ignored.
 */
// Loosely typed: role_capabilities has no id column, so it isn't in BroadcastMessage's table union.
export function isCapabilityNoteRelevant(message: { table?: unknown; data?: unknown }, userId: string) {
  if (message.table === "role_capabilities") {
    return true;
  }
  if (message.table === "user_roles") {
    return (message.data as { user_id?: string } | undefined)?.user_id === userId;
  }
  return false;
}

/**
 * Fetches the viewer's capabilities for this class once and shares them with every `useCapability`
 * caller. Re-asks when a relevant staff channel note arrives, and whenever the staff channel
 * (re)joins, since notes sent while it was down or not yet joined aren't replayed (the same catch-up
 * TableController does). Students aren't on the staff channel, and they hold no capabilities, so
 * their result never changes.
 */
export function ClassCapabilitiesProvider({ children }: { children: React.ReactNode }) {
  const controller = useCourseController();
  const classId = controller.courseId;
  const { user } = useAuthState();
  const userId = user?.id;
  const { isReadOnly } = useClassProfiles();
  const [state, setState] = useState<ClassCapabilitiesState>({ capabilities: new Set(), isLoading: true });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!userId) {
      return;
    }
    let cancelled = false;
    (async () => {
      // Retry transient errors, as ClassProfileProvider does for roles.
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { data, error } = await createClient().rpc("user_class_capabilities").eq("class_id", classId);
        if (cancelled) return;
        if (!error) {
          setState({ capabilities: new Set((data ?? []).map((row) => row.capability)), isLoading: false });
          return;
        }
        if (attempt === maxAttempts) {
          // eslint-disable-next-line no-console
          console.error("Error fetching capabilities:", error);
          // Keep what a re-ask already had, so a transient error doesn't hide controls; the first
          // load fails closed.
          setState((prev) => ({ ...prev, isLoading: false }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, classId, userId, refreshNonce]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefreshNonce((n) => n + 1), CAPABILITY_REFRESH_DEBOUNCE_MS);
    };
    const onNote = (message: BroadcastMessage) => {
      if (isCapabilityNoteRelevant(message, userId)) scheduleRefresh();
    };
    const staffTopic = `class:${classId}:staff`;
    let lastStaffState: string | undefined;
    const onStatus = (status: ConnectionStatus) => {
      const staff = status.channels.find((channel) => channel.name === staffTopic);
      if (!staff) return;
      if (staff.state === "joined" && lastStaffState !== "joined") scheduleRefresh();
      lastStaffState = staff.state;
    };
    const realtime = controller.classRealTimeController;
    const unsubscribers = [
      realtime.subscribeToTable("user_roles", onNote),
      realtime.subscribeToTable("role_capabilities", onNote),
      realtime.subscribeToStatus(onStatus)
    ];
    return () => {
      clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [controller, classId, userId]);

  // An instructor viewing as a student sees the student's controls, as with useIsInstructor.
  const value = isReadOnly ? VIEWING_AS_STUDENT : state;
  return <ClassCapabilitiesContext.Provider value={value}>{children}</ClassCapabilitiesContext.Provider>;
}
