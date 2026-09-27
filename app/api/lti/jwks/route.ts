/**
 * Public JWKS for the Pawtograder LTI tool. Platforms fetch this to verify the
 * client assertions we sign for NRPS/AGS. Register this URL as the tool's
 * "Public JWK URL" in the LMS developer key configuration.
 */
import { NextResponse } from "next/server";
import { getPublicJwks } from "@/lib/lti/keys";
import { withRouteMetrics } from "@/lib/routeMetrics";

export const dynamic = "force-dynamic";

async function getHandler() {
  try {
    const jwks = await getPublicJwks();
    return NextResponse.json(jwks, {
      headers: { "Cache-Control": "public, max-age=300, must-revalidate" }
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// web_http_* instrumentation. The `route` label is the hardcoded parameterized
// pattern, never the request path — see lib/routeMetrics.ts.
export const GET = withRouteMetrics("/api/lti/jwks", getHandler, "GET");
