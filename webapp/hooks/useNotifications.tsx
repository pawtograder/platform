'use client';
import { useContext, createContext, useState, useCallback, useEffect } from "react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useList, useUpdate, useDelete } from "@refinedev/core";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
export function useNotification(notification_id: number) {
    const controller = useCourseController();
    const [notification, setNotification] = useState<Notification | undefined>(undefined);
    useEffect(() => {
        const { unsubscribe, data } = controller.getValueWithSubscription<Notification>("notifications", notification_id, (data) => {
            setNotification(data);
        });
        setNotification(data);
        return unsubscribe;
    }, [notification_id, controller]);
    return notification;
}
export function useNotifications() {
    const controller = useCourseController();
    const { mutateAsync: update_notification } = useUpdate<Notification>({
        resource: "notifications",
    });
    const { mutateAsync: delete_notification } = useDelete<Notification>();
    const set_read = useCallback(async (notification: Notification, read: boolean) => {
        notification.viewed_at = read ? new Date().toISOString() : null;
        try {
            await update_notification({
                id: notification.id, values: {
                    viewed_at: notification.viewed_at
                }
            });
        } catch (error) {
            console.error("error setting notification read", error);
        }
    }, [update_notification]);
    const dismiss = useCallback(async (notification: Notification) => {
        controller.handleGenericDataEvent("notifications", {
            type: "deleted",
            payload: {
                id: notification.id
            },
            channel: 'resources/notifications',
            date: new Date()
        });
        await delete_notification({ id: notification.id, resource: "notifications" });
    }, [delete_notification, controller]);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    useEffect(() => {
        const { unsubscribe, data } = controller.listGenericData<Notification>("notifications", (data) => {
            setNotifications(data);
        });
        setNotifications(data);
        return () => unsubscribe();
    }, [controller]);
    return { notifications, set_read, dismiss };
}