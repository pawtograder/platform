"use client";
import { HelpRequestWatcher } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import useAuthState from "./useAuthState";
import { useIsReadOnly } from "./useClassProfiles";
import { useCourseController } from "./useCourseController";

/**
 * Hook for managing help request watch status for the current user.
 * Allows users to watch/unwatch help requests to control notification delivery.
 *
 * @param helpRequestId - The ID of the help request to watch/unwatch
 * @returns Object containing watch status and setter function
 */
export function useHelpRequestWatchStatus(helpRequestId: number) {
  const controller = useCourseController();
  const isReadOnly = useIsReadOnly();
  const [curWatch, setCurWatch] = useState<HelpRequestWatcher | undefined>(undefined);

  useEffect(() => {
    const { unsubscribe, data } = controller.getValueWithSubscription<HelpRequestWatcher>(
      "help_request_watchers",
      helpRequestId,
      (data) => {
        setCurWatch(data);
      }
    );
    setCurWatch(data);
    return unsubscribe;
  }, [controller, helpRequestId]);

  const { mutateAsync: createHelpRequestWatcher } = useCreate({
    resource: "help_request_watchers"
  });

  const { mutateAsync: updateWatch } = useUpdate({
    resource: "help_request_watchers"
  });

  const { user } = useAuthState();
  const { course_id } = useParams();

  /**
   * Sets the watch status for the current help request.
   * Creates a new watcher record if none exists, or updates the existing one.
   *
   * @param status - Whether to enable or disable watching
   */
  const setHelpRequestWatchStatus = useCallback(
    async (status: boolean) => {
      // View-as student is read-only; writing here would subscribe the masquerading
      // instructor to help-request notifications under their own user_id.
      if (isReadOnly) return;
      if (curWatch) {
        await updateWatch({
          id: curWatch.id,
          values: {
            enabled: status
          }
        });
      } else {
        await createHelpRequestWatcher({
          values: {
            user_id: user?.id,
            class_id: course_id,
            help_request_id: helpRequestId,
            enabled: status
          }
        });
      }
    },
    [helpRequestId, curWatch, course_id, user?.id, updateWatch, createHelpRequestWatcher, isReadOnly]
  );

  return {
    status: isReadOnly ? false : (curWatch?.enabled ?? false),
    setHelpRequestWatchStatus
  };
}
