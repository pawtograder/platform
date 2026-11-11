"use client";
import { useEffect } from "react";
import { useList } from "@refinedev/core";
import type { CourseController } from "./useCourseController";
import type { Notification } from "@/utils/supabase/DatabaseTypes";

type NotificationStore = Pick<CourseController, "registerGenericDataType" | "setGeneric" | "handleGenericDataEvent">;

/**
 * Loads the user's notifications and copies them into the controller's generic-data store, where
 * `useNotifications` reads them.
 *
 * Skip the user_id-keyed fetch entirely in view-as: the rows would be the masquerading
 * instructor's, not the student's. useNotifications already returns [] when read-only,
 * but not fetching here also avoids pushing the instructor's inbox into the controller's
 * generic-data store where other surfaces might pick it up.
 */
export function useCourseNotificationsQuery(
  controller: NotificationStore,
  userId: string | undefined,
  isReadOnly: boolean
) {
  const { data: notifications, dataUpdatedAt } = useList<Notification>({
    resource: "notifications",
    filters: [{ field: "user_id", operator: "eq", value: userId }],
    // liveMode: "manual",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity,
      enabled: !!userId && !isReadOnly
    },
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      if (isReadOnly) return;
      controller.handleGenericDataEvent("notifications", event);
    },
    sorters: [
      { field: "viewed_at", order: "desc" },
      { field: "created_at", order: "desc" }
    ]
  });
  // Also re-run on every successful fetch (dataUpdatedAt), not only when `data` changes: React
  // Query keeps the same `data` reference when a refetch returns identical rows, and a
  // notification that `dismiss` removed locally without confirming the delete must come back
  // from that refetch if it still exists (#1249).
  useEffect(() => {
    controller.registerGenericDataType("notifications", (item: Notification) => item.id);
    if (isReadOnly) return;
    if (notifications?.data) {
      controller.setGeneric("notifications", notifications.data);
    }
  }, [controller, notifications?.data, dataUpdatedAt, isReadOnly]);
}
