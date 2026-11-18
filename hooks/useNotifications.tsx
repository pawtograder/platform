"use client";
import { useState, useCallback, useEffect } from "react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUpdate, useDelete, useDataProvider, useInvalidate } from "@refinedev/core";
import { useCourseController } from "./useCourseController";
import { useIsReadOnly } from "@/hooks/useClassProfiles";
import { toaster } from "@/components/ui/toaster";
import { getErrorMessage } from "@/lib/errorMessage";
import { isMissingRowError, isRefusedWriteError } from "@/lib/refineDataProvider";
import {
  DiscussionThreadNotification,
  HelpRequestNotification,
  HelpRequestMessageNotification
} from "@/components/notifications/notification-teaser";

const EMPTY_NOTIFICATIONS: Notification[] = [];

export function useNotification(notification_id: number) {
  const controller = useCourseController();
  const [notification, setNotification] = useState<Notification | undefined>(undefined);
  useEffect(() => {
    const { unsubscribe, data } = controller.getValueWithSubscription<Notification>(
      "notifications",
      notification_id,
      (data) => {
        setNotification(data);
      }
    );
    setNotification(data);
    return unsubscribe;
  }, [notification_id, controller]);
  return notification;
}

export function useNotifications(resource?: string, id?: number) {
  const controller = useCourseController();
  const isReadOnly = useIsReadOnly();
  const { mutateAsync: update_notification } = useUpdate<Notification>({
    resource: "notifications"
  });
  const { mutateAsync: delete_notification } = useDelete<Notification>();
  const dataProvider = useDataProvider();
  const invalidate = useInvalidate();

  // Always declare state hooks at the top level
  const [resourceNotifications, setResourceNotifications] = useState<Notification[]>([]);
  const [allNotifications, setAllNotifications] = useState<Notification[]>([]);

  // In view-as mode the underlying rows are the *real instructor's* notifications (the
  // controller's query filters by their auth user_id). Writes here would silently dismiss
  // the masquerader's own inbox — and IntersectionObserver auto-effects in the discussion
  // thread reader call set_read as you scroll. Make every mutation a no-op while masking.
  const set_read = useCallback(
    async (notification: Notification, read: boolean) => {
      if (isReadOnly) return;
      const previousViewedAt = notification.viewed_at;
      notification.viewed_at = read ? new Date().toISOString() : null;
      try {
        await update_notification({
          id: notification.id,
          values: {
            viewed_at: notification.viewed_at
          }
        });
      } catch (error) {
        // Put the old value back so the inbox doesn't show a read state the server refused.
        notification.viewed_at = previousViewedAt;
        // eslint-disable-next-line no-console
        console.error("error setting notification read", error);
        // Fixed id: mark_all_read and scroll-to-read can fail many at once; show one toast.
        toaster.error({
          id: "notification-set-read-error",
          title: "Failed to update notification",
          description: getErrorMessage(error)
        });
      }
    },
    [update_notification, isReadOnly]
  );

  // Removes the notification from the local store right away, then deletes it. Never rejects:
  // a notification that is already gone (another tab, a double click) resolves in the data
  // provider, and failures are handled here, so callers (including fire-and-forget onClick
  // handlers) don't need their own catch.
  //
  // Only put the notification back when the server says it still exists. A failed request can
  // still have deleted the row (the response was lost), and a refetch never removes a row that
  // was put back locally, so restoring on every failure could show a deleted notification (#1249).
  const dismiss = useCallback(
    async (notification: Notification) => {
      if (isReadOnly) return;
      controller.handleGenericDataEvent("notifications", {
        type: "deleted",
        payload: {
          id: notification.id
        },
        channel: "resources/notifications",
        date: new Date()
      });
      const restore = (error: unknown) => {
        controller.handleGenericDataEvent("notifications", {
          type: "created",
          payload: notification,
          channel: "resources/notifications",
          date: new Date()
        });
        toaster.error({
          title: "Failed to dismiss notification",
          description: getErrorMessage(error)
        });
      };
      try {
        await delete_notification({ id: notification.id, resource: "notifications" });
      } catch (error) {
        // The provider saw the row after the delete matched nothing: the delete was refused.
        if (isRefusedWriteError(error)) {
          restore(error);
          return;
        }
        let stillExists: boolean | undefined;
        try {
          await dataProvider().getOne({ resource: "notifications", id: notification.id, meta: { select: "id" } });
          stillExists = true;
        } catch (checkError) {
          // Not visible: deleted, or hidden by RLS. Notifications are only readable by their
          // owner, so a row this session can't see would not be in its inbox either.
          stillExists = isMissingRowError(checkError) ? false : undefined;
        }
        if (stillExists === true) {
          restore(error);
        } else if (stillExists === undefined) {
          // Couldn't tell. Leave it removed and refetch the list: a row that still exists comes
          // back with the next successful fetch (React Query retries an invalidated query on
          // reconnect), and a deleted one stays gone.
          void invalidate({ resource: "notifications", invalidates: ["list"] });
          toaster.error({
            title: "Couldn't confirm the notification was dismissed",
            description: `If it wasn't, it will come back when your notifications reload. ${getErrorMessage(error)}`
          });
        }
      }
    },
    [delete_notification, dataProvider, invalidate, controller, isReadOnly]
  );

  const mark_all_read = useCallback(
    async (notificationList: Notification[]) => {
      const unreadNotifications = notificationList.filter((n) => !n.viewed_at);
      const promises = unreadNotifications.map((notification) => set_read(notification, true));
      await Promise.all(promises);
    },
    [set_read]
  );

  const delete_all = useCallback(
    async (notificationList: Notification[]) => {
      const promises = notificationList.map((notification) => dismiss(notification));
      await Promise.all(promises);
    },
    [dismiss]
  );

  // Handle resource-specific notifications
  useEffect(() => {
    if (resource && id) {
      const { unsubscribe, data } = controller.getValueWithSubscription<Notification>(
        "notifications",
        (notification) => {
          const type =
            notification.body && typeof notification.body === "object"
              ? (notification.body as Record<string, unknown>).type
              : undefined;

          if (type === "discussion_thread") {
            const envelope = notification.body as DiscussionThreadNotification;
            return envelope.root_thread_id === id;
          }

          if (type === "help_request" && resource === "help_requests") {
            const envelope = notification.body as HelpRequestNotification;
            return envelope.help_request_id === id;
          }

          if (type === "help_request_message" && resource === "help_requests") {
            const envelope = notification.body as HelpRequestMessageNotification;
            return envelope.help_request_id === id;
          }

          if (type === "help_request" && resource === "help_queues") {
            const envelope = notification.body as HelpRequestNotification;
            return envelope.help_queue_id === id;
          }

          if (type === "help_request_message" && resource === "help_queues") {
            const envelope = notification.body as HelpRequestMessageNotification;
            return envelope.help_queue_id === id;
          }

          return false;
        },
        (data) => {
          setResourceNotifications([data]);
        }
      );
      if (data) setResourceNotifications([data]);
      return () => unsubscribe();
    }
  }, [controller, resource, id]);

  // Handle all notifications for the class
  useEffect(() => {
    if (!resource || !id) {
      const { unsubscribe, data } = controller.listGenericData<Notification>("notifications", (data) => {
        const thisClassNotifications = data.filter((notification) => {
          return notification.class_id === controller.courseId;
        });
        setAllNotifications(thisClassNotifications);
      });
      const thisClassNotifications = data.filter((notification) => {
        return notification.class_id === controller.courseId;
      });
      setAllNotifications(thisClassNotifications);
      return () => unsubscribe();
    }
  }, [controller, resource, id]);

  // Return the appropriate notifications based on whether resource/id are provided. Hide
  // the rows entirely in view-as mode so badges and lists don't render the instructor's
  // inbox as if it were the student's. The mutation no-ops above are defense in depth.
  const notifications = isReadOnly ? EMPTY_NOTIFICATIONS : resource && id ? resourceNotifications : allNotifications;

  return { notifications, set_read, dismiss, mark_all_read, delete_all };
}
