'use client';
import { useContext, createContext, useState, useCallback } from "react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useList, useUpdate, useDelete } from "@refinedev/core";
import useAuthState from "./useAuthState";
type NotificationContextType = {
    notifications: Notification[];
    set_read: (notification_id: number, read: boolean) => Promise<void>;
    dismiss: (notification_id: number) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
    notifications: [],
    set_read: async () => { },
    dismiss: async () => { },
});

export function useNotifications() {
    return useContext(NotificationContext);
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuthState();
    const { data: notifications } = useList<Notification>({
        resource: "notifications",
        filters: [
            { field: "user_id", operator: "eq", value: user?.id }
        ]
    });
    const { mutateAsync: update_notification } = useUpdate<Notification>({
        resource: "notifications",
    });
    const { mutateAsync: delete_notification } = useDelete<Notification>();
    const set_read = useCallback(async (notification_id: number, read: boolean) => {
        await update_notification({
            id: notification_id, values: {
                viewed_at: read ? new Date().toISOString() : null
            }
        });
    }, [update_notification]);
    const dismiss = useCallback(async (notification_id: number) => {
        await delete_notification({ id: notification_id, resource: "notifications" });
    }, [delete_notification]);

    return <NotificationContext.Provider value={{ notifications: notifications?.data || [], set_read, dismiss }}>{children}</NotificationContext.Provider>;
}