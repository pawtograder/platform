"use client";
import { useState, useCallback, useEffect } from "react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUpdate, useDelete } from "@refinedev/core";
import { useCourseController } from "./useCourseController";
import {
  DiscussionThreadNotification,
  HelpRequestNotification,
  HelpRequestMessageNotification
} from "@/components/notifications/notification-teaser";

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
  const { mutateAsync: update_notification } = useUpdate<Notification>({
    resource: "notifications"
  });
  const { mutateAsync: delete_notification } = useDelete<Notification>();

  // Always declare state hooks at the top level
  const [resourceNotifications, setResourceNotifications] = useState<Notification[]>([]);
  const [allNotifications, setAllNotifications] = useState<Notification[]>([]);

  const set_read = useCallback(
    async (notification: Notification, read: boolean) => {
      notification.viewed_at = read ? new Date().toISOString() : null;
      try {
        await update_notification({
          id: notification.id,
          values: {
            viewed_at: notification.viewed_at
          }
        });
      } catch (error) {
        toaster.error({
          title: "Error setting notification read",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      }
    },
    [update_notification]
  );

  const dismiss = useCallback(
    async (notification: Notification) => {
      controller.handleGenericDataEvent("notifications", {
        type: "deleted",
        payload: {
          id: notification.id
        },
        channel: "resources/notifications",
        date: new Date()
      });
      await delete_notification({ id: notification.id, resource: "notifications" });
    },
    [delete_notification, controller]
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

  // Return the appropriate notifications based on whether resource/id are provided
  const notifications = resource && id ? resourceNotifications : allNotifications;

  return { notifications, set_read, dismiss };
}
