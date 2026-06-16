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
  /** Chakra color palette used as the brand accent. */
  colorPalette: BrandColorPalette;
};

/** Built-in Pawtograder defaults, used whenever an env var is unset/blank. */
export const DEFAULT_BRANDING: Branding = {
  name: "Pawtograder",
  description: "Pawtograder is an application for managing student assignments",
  tagline: "Your pawsome course companion",
  logoLight: "/Logo-Light.png",
  logoDark: "/Logo-Dark.png",
  colorPalette: "gray"
};

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePalette(value: string | undefined): BrandColorPalette {
  const normalized = cleanString(value)?.toLowerCase();
  if (normalized && (BRAND_COLOR_PALETTES as readonly string[]).includes(normalized)) {
    return normalized as BrandColorPalette;
  }
  return DEFAULT_BRANDING.colorPalette;
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
    colorPalette: resolvePalette(process.env.BRAND_COLOR_PALETTE)
  };
}
