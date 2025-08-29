/**
 * Feature flag utilities
 */

/**
 * Checks if user signups are enabled by checking environment variables.
 * First checks ENABLE_SIGNUPS, then falls back to NEXT_PUBLIC_ENABLE_SIGNUPS.
 * Both checks are case-insensitive.
 *
 * @returns {boolean} true if signups are enabled, false otherwise
 */
export function isSignupsEnabled(): boolean {
  // Check ENABLE_SIGNUPS first (case-insensitive)
  const enableSignups = process.env.ENABLE_SIGNUPS?.toLowerCase();
  if (enableSignups === "true") {
    return true;
  }
  if (enableSignups === "false") {
    return false;
  }

  // Fallback to NEXT_PUBLIC_ENABLE_SIGNUPS (case-insensitive)
  const publicEnableSignups = process.env.NEXT_PUBLIC_ENABLE_SIGNUPS?.toLowerCase();
  return publicEnableSignups === "true";
}
