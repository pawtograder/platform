/**
 * Build the URL for calling one edge function from another.
 *
 * `EDGE_FUNCTIONS_URL` is NOT consistently shaped across deployments, and the difference is
 * invisible until every request 404s:
 *
 *   Khoury prod                        https://api.<host>/functions/v1   (prefix included)
 *   scripts/export-preview-agent-env.sh  the bare Kong origin            (no prefix)
 *
 * Kong only routes edge functions below `/functions/v1/` (`kong-config.yaml`, route `functions-v1`,
 * which then strips the prefix). So hardcoding the prefix breaks prod with a doubled path, and
 * omitting it breaks preview environments. Normalize rather than assume either shape.
 */
export function edgeFunctionEndpoint(base: string, functionName: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/functions/v1") ? `${trimmed}/${functionName}` : `${trimmed}/functions/v1/${functionName}`;
}
