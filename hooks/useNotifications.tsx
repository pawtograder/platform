"use client";
import { useState, useCallback, useMemo } from "react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUpdate, useDelete } from "@refinedev/core";
import { useCourseController } from "./useCourseController";
import { useNotificationsQuery } from "./course-data";
import {
  DiscussionThreadNotification,
  HelpRequestNotification,
  HelpRequestMessageNotification
} from "@/components/notifications/notification-teaser";
import { useQueryClient } from "@tanstack/react-query";
import { useCourseDataContext } from "./course-data";

export function useNotification(notification_id: number) {
  const { data: allNotifications = [] } = useNotificationsQuery();
  return useMemo(() => allNotifications.find((n) => n.id === notification_id), [allNotifications, notification_id]);
}

export function useNotifications(resource?: string, id?: number) {
  const controller = useCourseController();
  const queryClient = useQueryClient();
  const { courseId, userId } = useCourseDataContext();
  const { data: allNotifications = [] } = useNotificationsQuery();
  const { mutateAsync: update_notification } = useUpdate<Notification>({
    resource: "notifications"
  });
  const { mutateAsync: delete_notification } = useDelete<Notification>();

  const notificationsQueryKey = useMemo(() => ["course", courseId, "notifications", userId], [courseId, userId]);

  const invalidateNotifications = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
  }, [queryClient, notificationsQueryKey]);

  const set_read = useCallback(
    async (notification: Notification, read: boolean) => {
      try {
        await update_notification({
          id: notification.id,
          values: {
            viewed_at: read ? new Date().toISOString() : null
          }
        });
        invalidateNotifications();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("error setting notification read", error);
      }
    },
    [update_notification, invalidateNotifications]
  );

  const dismiss = useCallback(
    async (notification: Notification) => {
      await delete_notification({ id: notification.id, resource: "notifications" });
      invalidateNotifications();
    },
    [delete_notification, invalidateNotifications]
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

  const notifications = useMemo(() => {
    const thisClassNotifications = allNotifications.filter((n) => n.class_id === controller.courseId);

    if (resource && id) {
      return thisClassNotifications.filter((notification) => {
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
      });
    }

    return thisClassNotifications;
  }, [allNotifications, controller.courseId, resource, id]);

  return { notifications, set_read, dismiss, mark_all_read, delete_all };
}
