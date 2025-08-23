/**
 * Utility functions for working with typed system settings
 *
 * Example usage:
 * ```typescript
 * // Get a setting with full type safety
 * const welcomeMessage = await getSystemSetting("signup_welcome_message");
 * if (welcomeMessage) {
 *   console.log(welcomeMessage.value.title); // TypeScript knows this is a string
 * }
 *
 * // Set a setting with validation
 * await setSystemSetting("maintenance_mode", {
 *   enabled: true,
 *   message: "System is under maintenance"
 * });
 *
 * // TypeScript will error if you try to use wrong types:
 * // await setSystemSetting("signup_welcome_message", { invalid: true }); // ❌ Error
 * ```
 */

import { createClient } from "@/utils/supabase/client";
import { SystemSetting, SystemSettingKey, SystemSettingsTypes, SystemSettingValue } from "@/types/SystemSettings";

/**
 * Get a system setting by key with proper typing
 */
export async function getSystemSetting<K extends SystemSettingKey>(key: K): Promise<SystemSetting<K> | null> {
  const supabase = createClient();

  const { data, error } = await supabase.from("system_settings").select("*").eq("key", key).maybeSingle();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found
    throw error;
  }

  return data as SystemSetting<K> | null;
}

/**
 * Set/update a system setting with proper typing
 */
export async function setSystemSetting<K extends SystemSettingKey>(
  key: K,
  value: SystemSettingValue<K>
): Promise<SystemSetting<K>> {
  const supabase = createClient();

  // Check if setting already exists
  const existing = await getSystemSetting(key);

  if (existing) {
    // Update existing setting
    const { data, error } = await supabase
      .from("system_settings")
      .update({
        value: value,
        updated_at: new Date().toISOString()
      })
      .eq("key", key)
      .select()
      .single();

    if (error) throw error;
    return data as SystemSetting<K>;
  } else {
    // Create new setting
    const { data, error } = await supabase
      .from("system_settings")
      .insert({
        key: key,
        value: value,
        created_by: (await supabase.auth.getUser()).data.user?.id
      })
      .select()
      .single();

    if (error) throw error;
    return data as SystemSetting<K>;
  }
}

/**
 * Delete a system setting
 */
export async function deleteSystemSetting<K extends SystemSettingKey>(key: K): Promise<void> {
  const supabase = createClient();

  const { error } = await supabase.from("system_settings").delete().eq("key", key);

  if (error) throw error;
}

/**
 * Check if a system setting exists and has a value
 */
export async function hasSystemSetting<K extends SystemSettingKey>(key: K): Promise<boolean> {
  try {
    const setting = await getSystemSetting(key);
    return setting !== null;
  } catch {
    return false;
  }
}

/**
 * Get all system settings (admin only)
 */
export async function getAllSystemSettings(): Promise<SystemSetting[]> {
  const supabase = createClient();

  const { data, error } = await supabase.from("system_settings").select("*").order("key");

  if (error) throw error;
  return data as SystemSetting[];
}

/**
 * Get multiple system settings at once
 */
export async function getMultipleSystemSettings<K extends SystemSettingKey>(
  keys: K[]
): Promise<Partial<Record<K, SystemSetting<K>>>> {
  const supabase = createClient();

  const { data, error } = await supabase.from("system_settings").select("*").in("key", keys);

  if (error) throw error;

  // Convert array to record keyed by setting key
  const result: Partial<Record<K, SystemSetting<K>>> = {};
  data?.forEach((setting) => {
    result[setting.key as K] = setting as SystemSetting<K>;
  });

  return result;
}
