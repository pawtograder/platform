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

/**
 * Checks if email + password sign-in is enabled.
 *
 * Unlike signups, password login defaults to ENABLED: it is only disabled when
 * a deployment explicitly opts out (the chart sets ENABLE_PASSWORD_LOGIN=false
 * when auth.enablePasswordLogin is false). This keeps the default/preview/staging
 * setups on email+password while letting prod go SSO-only (with GoTrue enforcing
 * the same via the password-verification deny hook).
 *
 * First checks ENABLE_PASSWORD_LOGIN, then falls back to
 * NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN. Both checks are case-insensitive.
 *
 * @returns {boolean} false only if explicitly disabled, true otherwise
 */
export function isPasswordLoginEnabled(): boolean {
  // Check ENABLE_PASSWORD_LOGIN first (case-insensitive)
  const enablePasswordLogin = process.env.ENABLE_PASSWORD_LOGIN?.toLowerCase();
  if (enablePasswordLogin === "false") {
    return false;
  }
  if (enablePasswordLogin === "true") {
    return true;
  }

  // Fallback to NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN (case-insensitive)
  const publicEnablePasswordLogin = process.env.NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN?.toLowerCase();
  return publicEnablePasswordLogin !== "false";
}
