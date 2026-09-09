/**
 * Build the URL for calling one edge function from another.
 *
 * `EDGE_FUNCTIONS_URL` has THREE shapes in this fleet, and the difference is invisible until every
 * request 404s:
 *
 *   1. Khoury prod            https://api.<host>/functions/v1              prefix already present
 *   2. Preview, external      https://api.pr-<n>.<domain>                  bare Kong origin
 *   3. Preview, in-cluster    http://pawtograder-functions.<ns>...:9000    edge-runtime DIRECTLY
 *
 * (2) and (3) are both bare origins but need opposite treatment. Kong routes edge functions only
 * below `/functions/v1/` and strips the prefix before forwarding (`kong-config.yaml`, route
 * `functions-v1`), so a Kong origin needs it added. Shape (3) bypasses Kong entirely and serves
 * `/<function>` at the edge-runtime service port, so adding the prefix there gives
 * `:9000/functions/v1/<function>` and 404s. Both shapes are emitted by
 * `scripts/export-preview-agent-env.sh` (in-cluster at :111, external at :131).
 *
 * The edge-runtime service port is the signal that separates them, because it is the one thing that
 * differs structurally: Kong listens on 8000 in-cluster and 443 externally, edge-runtime on 9000
 * (`edgeFunctions.service.port`). Anything with an explicit path is taken at its word.
 */
const EDGE_RUNTIME_DIRECT_PORT = "9000";
const FUNCTIONS_PREFIX = "/functions/v1";

export function edgeFunctionEndpoint(base: string, functionName: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith(FUNCTIONS_PREFIX)) {
    return `${trimmed}/${functionName}`;
  }
  let port = "";
  let hasPath = false;
  try {
    const parsed = new URL(trimmed);
    port = parsed.port;
    hasPath = parsed.pathname !== "" && parsed.pathname !== "/";
  } catch {
    // Not parseable as an absolute URL — fall through and treat it as a Kong-style origin, which is
    // the shape every deployment that is not talking to edge-runtime directly uses.
  }
  // An explicit path means somebody configured a complete base; do not second-guess it.
  if (hasPath || port === EDGE_RUNTIME_DIRECT_PORT) {
    return `${trimmed}/${functionName}`;
  }
  return `${trimmed}${FUNCTIONS_PREFIX}/${functionName}`;
}
