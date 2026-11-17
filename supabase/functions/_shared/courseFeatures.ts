// `classes.features` flags for edge functions, which can't import lib/courseFeatures.ts. Same
// semantics as its courseFeatureEffectiveEnabled; keep the two in step.

/** Turns on Forgejo assignments and Coder workspaces (#1128's assignments_validate_git_provider). */
export const CLOUD_WORKSPACES_FEATURE = "cloud-workspaces";

/**
 * Whether `features` turns `name` on. The first entry with that name decides, and only a JSON
 * boolean `enabled` counts: no entry, a non-array column, or `"true"` gives `defaultWhenMissing`.
 */
export function courseFeatureEffectiveEnabled(features: unknown, name: string, defaultWhenMissing: boolean): boolean {
  const row = Array.isArray(features) ? features.find((f) => f?.name === name) : undefined;
  return typeof row?.enabled === "boolean" ? row.enabled : defaultWhenMissing;
}
