/**
 * Absolute URL for an Edge Function, for display in setup instructions users
 * copy elsewhere (Claude Desktop's mcpServers config, a curl example, the CLI's
 * --api-url).
 *
 * Must be derived from NEXT_PUBLIC_SUPABASE_URL, not window.location.origin.
 * With global.apiOnSeparateHost (the default for self-hosted, and how
 * pawtograder.com is deployed) Edge Functions are served from the API host —
 * api.<zone> — while the app itself runs on <zone>. Building these URLs from the
 * browser's origin therefore hands the user https://<zone>/functions/v1/... ,
 * which no route serves.
 *
 * NEXT_PUBLIC_SUPABASE_URL is already the API gateway origin the app's own
 * Supabase client talks to, and Next inlines it at build time, so it is correct
 * in client components. The window fallback only matters if it is somehow unset
 * (utils/supabase/client.ts asserts on it) and for SSR, where there is no window.
 */
export function edgeFunctionUrl(name: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base.replace(/\/+$/, "")}/functions/v1/${name}`;
}
