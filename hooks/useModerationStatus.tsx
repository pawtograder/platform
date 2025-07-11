import { useList } from "@refinedev/core";
import type { HttpError } from "@refinedev/core";
import { useClassProfiles } from "./useClassProfiles";
import { useMemo } from "react";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ModerationAction = Database["public"]["Tables"]["help_request_moderation"]["Row"];

type ModerationStatus = {
  isBanned: boolean;
  isPermanentBan: boolean;
  banExpiresAt: Date | null;
  timeRemainingMs: number | null;
  activeBan: ModerationAction | null;
  recentWarnings: ModerationAction[];
  isLoading: boolean;
  error: HttpError | null;
};

/**
 * Hook to check if the current user is banned or has recent moderation actions.
 * @param classId - The ID of the class to check moderation status for.
 * @returns Comprehensive moderation status including ban expiration and warnings.
 */
export function useModerationStatus(classId: number): ModerationStatus {
  const { private_profile_id } = useClassProfiles();

  // Fetch all moderation actions for the current user in this class
  const {
    data: moderationResponse,
    isLoading,
    error
  } = useList<ModerationAction>({
    resource: "help_request_moderation",
    filters: [
      { field: "class_id", operator: "eq", value: classId },
      { field: "student_profile_id", operator: "eq", value: private_profile_id }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!private_profile_id && !!classId,
      retry: false // Don't retry on permission errors
    },
    meta: {
      // Add meta information for debugging
      select: "*"
    }
  });

  const moderationStatus = useMemo((): ModerationStatus => {
    // Handle loading state
    if (isLoading) {
      return {
        isBanned: false,
        isPermanentBan: false,
        banExpiresAt: null,
        timeRemainingMs: null,
        activeBan: null,
        recentWarnings: [],
        isLoading: true,
        error: null
      };
    }

    // Handle error state
    if (error) {
      console.error("Moderation status query error:", error);
      return {
        isBanned: false,
        isPermanentBan: false,
        banExpiresAt: null,
        timeRemainingMs: null,
        activeBan: null,
        recentWarnings: [],
        isLoading: false,
        error
      };
    }

    // Handle case where query is disabled (missing required params)
    if (!private_profile_id || !classId) {
      console.warn("Moderation status query disabled - missing required parameters:", {
        private_profile_id,
        classId
      });
      return {
        isBanned: false,
        isPermanentBan: false,
        banExpiresAt: null,
        timeRemainingMs: null,
        activeBan: null,
        recentWarnings: [],
        isLoading: false,
        error: null
      };
    }

    // Handle case where there's no data (could be RLS issue or no records)
    if (!moderationResponse?.data || moderationResponse.data.length === 0) {
      return {
        isBanned: false,
        isPermanentBan: false,
        banExpiresAt: null,
        timeRemainingMs: null,
        activeBan: null,
        recentWarnings: [],
        isLoading: false,
        error: null
      };
    }

    const actions = moderationResponse.data;
    const now = new Date();

    // Find active bans
    const activeBans = actions.filter((action) => {
      // Only consider ban-type actions
      if (action.action_type !== "temporary_ban" && action.action_type !== "permanent_ban") {
        return false;
      }

      // Permanent bans (either flagged via `is_permanent` or explicit action_type) never expire automatically
      if (action.is_permanent || action.action_type === "permanent_ban") {
        return true;
      }

      // For temporary bans we determine the expiration time using, in order of precedence:
      //   1. `expires_at` column – if it is set the backend has already calculated it
      //   2. `duration_minutes` – fall back to `created_at` + duration
      // If neither field is present we treat the ban as expired (safety-first approach)

      let expires: Date | null = null;

      if (action.expires_at) {
        expires = new Date(action.expires_at);
      } else if (action.duration_minutes !== null && action.duration_minutes !== undefined) {
        expires = new Date(new Date(action.created_at).getTime() + action.duration_minutes * 60 * 1000);
      }

      if (!expires) return false; // insufficient data – assume not active

      return expires > now;
    });

    // Get the most recent active ban
    const activeBan = activeBans[0] || null;
    const isBanned = !!activeBan;
    const isPermanentBan = activeBan?.is_permanent || activeBan?.action_type === "permanent_ban" || false;

    // Calculate ban expiration info
    let banExpiresAt: Date | null = null;
    let timeRemainingMs: number | null = null;

    if (activeBan && !isPermanentBan) {
      // Determine expiration as above (reuse logic)
      if (activeBan.expires_at) {
        banExpiresAt = new Date(activeBan.expires_at);
      } else if (activeBan.duration_minutes !== null && activeBan.duration_minutes !== undefined) {
        banExpiresAt = new Date(new Date(activeBan.created_at).getTime() + activeBan.duration_minutes * 60 * 1000);
      }

      if (banExpiresAt) {
        timeRemainingMs = banExpiresAt.getTime() - now.getTime();
      }
    }

    // Get recent warnings (last 7 days)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentWarnings = actions.filter(
      (action) => action.action_type === "warning" && new Date(action.created_at) > sevenDaysAgo
    );

    const result = {
      isBanned,
      isPermanentBan,
      banExpiresAt,
      timeRemainingMs,
      activeBan,
      recentWarnings,
      isLoading: false,
      error: null
    };

    return result;
  }, [moderationResponse, isLoading, error, private_profile_id, classId]);

  return moderationStatus;
}

/**
 * Utility function to format time remaining in a ban.
 * @param timeRemainingMs - The time remaining in milliseconds.
 * @returns A human-readable string representing the time remaining.
 */
export function formatTimeRemaining(timeRemainingMs: number): string {
  if (timeRemainingMs <= 0) return "Expired";

  const hours = Math.floor(timeRemainingMs / (1000 * 60 * 60));
  const minutes = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} day${days !== 1 ? "s" : ""} ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`;
  } else if (hours > 0) {
    return `${hours} hour${hours !== 1 ? "s" : ""} ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  } else {
    return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
}
