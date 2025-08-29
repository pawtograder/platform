"use client";

import { useState } from "react";
import {
  DialogRoot,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import NotificationForm, { type NotificationFormData } from "@/components/notifications/NotificationForm";

interface CreateNotificationModalProps {
  children: React.ReactNode;
}

export default function CreateNotificationModal({ children }: CreateNotificationModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (formData: NotificationFormData) => {
    setIsSubmitting(true);

    try {
      const supabase = createClient();

      // Prepare parameters for the RPC call
      const rpcParams = {
        p_title: formData.title,
        p_message: formData.message,
        p_display: formData.display,
        p_severity: formData.severity,
        p_icon: formData.icon || null,
        p_persistent: formData.persistent,
        p_expires_at: formData.expires_at ? new Date(formData.expires_at).toISOString() : null,
        p_campaign_id: formData.campaign_id || null,
        p_track_engagement: formData.track_engagement,
        p_max_width: formData.max_width || null,
        p_position: formData.position,
        p_backdrop_dismiss: formData.backdrop_dismiss,
        p_target_roles: formData.roles.length > 0 ? formData.roles : null,
        p_target_course_ids: formData.course_ids.length > 0 ? formData.course_ids : null,
        p_target_user_ids: formData.user_ids
          ? (() => {
              const trimmedIds = formData.user_ids
                .split(",")
                .map((id) => id.trim())
                .filter((id) => id !== "");
              return trimmedIds.length > 0 ? trimmedIds : null;
            })()
          : null
      };

      // @ts-expect-error - RPC function not yet in generated types
      const { data, error } = await supabase.rpc("create_system_notification", rpcParams);

      if (error) {
        throw error;
      }

      const notificationCount = data as number;

      toaster.success({
        title: "Notification created",
        description: `System notification has been sent to ${notificationCount} users.`
      });

      setIsOpen(false);
      // Refresh the page to show the new notification in the table
      window.location.reload();
    } catch (error) {
      toaster.error({
        title: "Failed to create notification",
        description: (error as Error).message
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={(details) => setIsOpen(details.open)} size="xl">
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create System Notification</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <NotificationForm onSubmit={handleSubmit} showAudienceTargeting={true} isSubmitting={isSubmitting} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" form="notification-form" loading={isSubmitting}>
            Create Notification
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
