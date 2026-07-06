/**
 * Resolve the tool's public base URL for building OIDC redirect_uri and JWKS
 * references. Prefers the configured issuer, falls back to the request origin
 * (honoring the proxy's X-Forwarded-* headers in production).
 */
export function toolBaseUrl(request: Request): string {
  const configured = process.env.LTI_TOOL_ISSUER;
  if (configured) return configured.replace(/\/$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  return new URL(request.url).origin;
}
