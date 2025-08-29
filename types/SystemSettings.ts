/**
 * Type definitions for system settings
 * Maps setting keys to their expected value types
 */

import { NotificationFormData } from "@/components/notifications/NotificationForm";

// Define the structure for different system settings
export interface SystemSettingsTypes {
  // Welcome message sent to new users on signup
  signup_welcome_message: {
    title: string;
    message: string;
    display: "default" | "modal" | "banner";
    severity: "info" | "success" | "warning" | "error";
    icon?: string;
    persistent?: boolean;
    expires_at?: string;
    campaign_id?: string;
    track_engagement?: boolean;
    max_width?: string;
    position?: "top" | "bottom" | "center";
    backdrop_dismiss?: boolean;
  };

  // Future settings can be added here
  maintenance_mode: {
    enabled: boolean;
    message: string;
    start_time?: string;
    end_time?: string;
    allow_admin_access?: boolean;
  };

  default_theme: {
    name: "light" | "dark" | "auto";
    primary_color?: string;
    custom_css?: string;
  };

  email_notifications: {
    enabled: boolean;
    from_address: string;
    reply_to?: string;
    digest_frequency: "immediate" | "daily" | "weekly";
  };

  feature_flags: {
    enable_discussions: boolean;
    enable_office_hours: boolean;
    enable_peer_reviews: boolean;
    enable_analytics: boolean;
  };
}

// System setting keys - ensures only valid keys can be used
export type SystemSettingKey = keyof SystemSettingsTypes;

// Generic system setting interface
export interface SystemSetting<K extends SystemSettingKey = SystemSettingKey> {
  key: K;
  value: SystemSettingsTypes[K];
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

// Helper type to get the value type for a specific key
export type SystemSettingValue<K extends SystemSettingKey> = SystemSettingsTypes[K];

// Type-safe helper to create system setting data
export function createSystemSettingData<K extends SystemSettingKey>(
  key: K,
  value: SystemSettingsTypes[K]
): { key: K; value: SystemSettingsTypes[K] } {
  return { key, value };
}

// Helper to convert NotificationFormData to signup_welcome_message value
export function notificationFormToWelcomeMessage(
  formData: NotificationFormData
): SystemSettingsTypes["signup_welcome_message"] {
  const welcomeMessage: SystemSettingsTypes["signup_welcome_message"] = {
    title: formData.title,
    message: formData.message,
    display: formData.display,
    severity: formData.severity
  };

  // Add optional properties only if they have values
  if (formData.icon && formData.icon.trim()) {
    welcomeMessage.icon = formData.icon.trim();
  }
  if (formData.persistent) {
    welcomeMessage.persistent = formData.persistent;
  }
  if (formData.expires_at && formData.expires_at.trim()) {
    welcomeMessage.expires_at = formData.expires_at.trim();
  }
  if (formData.campaign_id && formData.campaign_id.trim()) {
    welcomeMessage.campaign_id = formData.campaign_id.trim();
  }
  if (formData.track_engagement) {
    welcomeMessage.track_engagement = formData.track_engagement;
  }
  if (formData.max_width && formData.max_width.trim()) {
    welcomeMessage.max_width = formData.max_width.trim();
  }
  if (formData.display === "banner" && formData.position) {
    welcomeMessage.position = formData.position;
  }
  if (formData.display === "modal") {
    welcomeMessage.backdrop_dismiss = formData.backdrop_dismiss;
  }

  return welcomeMessage;
}

// Helper to convert signup_welcome_message value to NotificationFormData
export function welcomeMessageToNotificationForm(
  welcomeMessage: SystemSettingsTypes["signup_welcome_message"]
): Partial<NotificationFormData> {
  return {
    title: welcomeMessage.title,
    message: welcomeMessage.message,
    display: welcomeMessage.display,
    severity: welcomeMessage.severity,
    icon: welcomeMessage.icon || "",
    persistent: welcomeMessage.persistent || false,
    expires_at: welcomeMessage.expires_at || "",
    campaign_id: welcomeMessage.campaign_id || "",
    track_engagement: welcomeMessage.track_engagement || false,
    max_width: welcomeMessage.max_width || "",
    position: welcomeMessage.position || "bottom",
    backdrop_dismiss: welcomeMessage.backdrop_dismiss !== undefined ? welcomeMessage.backdrop_dismiss : true,
    // These are not used for welcome messages but needed for the form
    roles: [],
    course_ids: [],
    user_ids: ""
  };
}
