/**
 * Deployment branding ("skinning").
 *
 * Self-hosted deployments can re-brand the entire app — service name, logo,
 * tagline, and accent color — WITHOUT rebuilding the web image. All values are
 * read from plain (non-`NEXT_PUBLIC_*`) server-side environment variables at
 * request time, so the same published image renders whatever branding the
 * deployment chart injects into the web pod's env.
 *
 * `NEXT_PUBLIC_*` vars are inlined into the client bundle at BUILD time and
 * therefore cannot be overridden per-deployment — that's exactly why branding
 * does NOT use them. Instead the root layout reads `getBranding()` on the
 * server and hands the resolved values to the client via `BrandingProvider`
 * (see components/branding/branding-provider.tsx).
 */

/** Chakra color palettes that are valid accent choices for `colorPalette`. */
export const BRAND_COLOR_PALETTES = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "cyan",
  "purple",
  "pink"
] as const;

export type BrandColorPalette = (typeof BRAND_COLOR_PALETTES)[number];

/**
 * OAuth providers Supabase GoTrue supports as `signInWithOAuth({ provider })`.
 * The sign-in page only renders SSO buttons for providers in this allowlist,
 * and the server action validates against it, so a tampered form can't trigger
 * an arbitrary provider string.
 */
export const SSO_ALLOWED_PROVIDERS = [
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "figma",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin_oidc",
  "notion",
  "slack_oidc",
  "spotify",
  "twitch",
  "workos",
  "zoom"
] as const;

export type SsoProviderId = (typeof SSO_ALLOWED_PROVIDERS)[number];

/** A single configurable SSO button on the sign-in page. */
export type SsoProvider = {
  /** Supabase/GoTrue OAuth provider id (must be enabled in GoTrue too). */
  provider: SsoProviderId;
  /** Button text, e.g. "Continue with Microsoft (Northeastern Login)". */
  label: string;
  /** Icon key from the SSO icon registry (components/branding/sso-icon.tsx). */
  icon?: string;
  /** Optional space-separated OAuth scopes passed to signInWithOAuth. */
  scopes?: string;
};

export type Branding = {
  /** Product name shown in titles, headings, and wordmarks. */
  name: string;
  /** `<meta name="description">` / default site description. */
  description: string;
  /** Short marketing line shown under the wordmark on auth screens. */
  tagline: string;
  /** Logo shown in light mode. Local path (bundled) or absolute URL. */
  logoLight: string;
  /** Logo shown in dark mode. Local path (bundled) or absolute URL. */
  logoDark: string;
  /** Browser tab favicon. Local path (bundled) or absolute URL. */
  favicon: string;
  /** Chakra color palette used as the brand accent. */
  colorPalette: BrandColorPalette;
  /**
   * SSO buttons shown on the sign-in page, in order. An empty array hides all
   * SSO options (email-only sign-in). Each provider must also be configured in
   * GoTrue (see the chart README "Single sign-on (SSO)" section).
   */
  ssoProviders: SsoProvider[];
};

/** Built-in Pawtograder defaults, used whenever an env var is unset/blank. */
export const DEFAULT_BRANDING: Branding = {
  name: "Pawtograder",
  description: "Pawtograder is an application for managing student assignments",
  tagline: "Your pawsome course companion",
  logoLight: "/Logo-Light.png",
  logoDark: "/Logo-Dark.png",
  favicon: "/favicon.ico",
  colorPalette: "gray",
  // Preserves the historical single Microsoft (Northeastern) SSO button when no
  // BRAND_SSO_PROVIDERS override is provided.
  ssoProviders: [
    {
      provider: "azure",
      label: "Continue with Microsoft (Northeastern Login)",
      icon: "microsoft",
      scopes: "email User.Read"
    }
  ]
};

/** Trim a possibly-undefined env value, returning undefined for blank/whitespace. */
function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve a color-palette env value to a known palette, else the default. */
function resolvePalette(value: string | undefined): BrandColorPalette {
  const normalized = cleanString(value)?.toLowerCase();
  if (normalized && (BRAND_COLOR_PALETTES as readonly string[]).includes(normalized)) {
    return normalized as BrandColorPalette;
  }
  return DEFAULT_BRANDING.colorPalette;
}

/** Type guard: whether a value is one of the allowlisted SSO provider ids. */
function isAllowedProvider(value: unknown): value is SsoProviderId {
  return typeof value === "string" && (SSO_ALLOWED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Parse the `BRAND_SSO_PROVIDERS` env (a JSON array of {provider,label,icon?,
 * scopes?}). Returns:
 *   - the default (single Microsoft button) when the var is unset/blank,
 *   - a validated list when set to a JSON array (invalid entries are dropped;
 *     an explicit `[]` yields no SSO buttons / email-only sign-in),
 *   - the default when the value is present but not parseable, with a warning.
 */
function resolveSsoProviders(raw: string | undefined): SsoProvider[] {
  const value = cleanString(raw);
  if (!value) {
    return DEFAULT_BRANDING.ssoProviders;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // eslint-disable-next-line no-console -- surface misconfiguration without crashing the page
    console.warn("BRAND_SSO_PROVIDERS is not valid JSON; falling back to default SSO providers");
    return DEFAULT_BRANDING.ssoProviders;
  }
  if (!Array.isArray(parsed)) {
    // eslint-disable-next-line no-console -- surface misconfiguration without crashing the page
    console.warn("BRAND_SSO_PROVIDERS must be a JSON array; falling back to default SSO providers");
    return DEFAULT_BRANDING.ssoProviders;
  }
  return parsed.flatMap((entry): SsoProvider[] => {
    if (!entry || typeof entry !== "object") return [];
    const { provider, label, icon, scopes } = entry as Record<string, unknown>;
    if (!isAllowedProvider(provider)) return [];
    const cleanLabel = typeof label === "string" ? label.trim() : "";
    if (!cleanLabel) return [];
    return [
      {
        provider,
        label: cleanLabel,
        ...(typeof icon === "string" && icon.trim() ? { icon: icon.trim() } : {}),
        ...(typeof scopes === "string" && scopes.trim() ? { scopes: scopes.trim() } : {})
      }
    ];
  });
}

/**
 * Resolve the active branding from environment variables, falling back to the
 * Pawtograder defaults for any value that is unset or blank.
 *
 * Server-only: relies on non-public env vars that are absent from the client
 * bundle. Call this in Server Components / Route Handlers and pass the result
 * to the client through `BrandingProvider`.
 */
export function getBranding(): Branding {
  return {
    name: cleanString(process.env.BRAND_NAME) ?? DEFAULT_BRANDING.name,
    description: cleanString(process.env.BRAND_DESCRIPTION) ?? DEFAULT_BRANDING.description,
    tagline: cleanString(process.env.BRAND_TAGLINE) ?? DEFAULT_BRANDING.tagline,
    logoLight: cleanString(process.env.BRAND_LOGO_LIGHT) ?? DEFAULT_BRANDING.logoLight,
    logoDark: cleanString(process.env.BRAND_LOGO_DARK) ?? DEFAULT_BRANDING.logoDark,
    favicon: cleanString(process.env.BRAND_FAVICON) ?? DEFAULT_BRANDING.favicon,
    colorPalette: resolvePalette(process.env.BRAND_COLOR_PALETTE),
    ssoProviders: resolveSsoProviders(process.env.BRAND_SSO_PROVIDERS)
  };
}
