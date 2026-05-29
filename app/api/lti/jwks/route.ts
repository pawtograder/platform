/**
 * Public JWKS for the Pawtograder LTI tool. Platforms fetch this to verify the
 * client assertions we sign for NRPS/AGS. Register this URL as the tool's
 * "Public JWK URL" in the LMS developer key configuration.
 */
import { NextResponse } from "next/server";
import { getPublicJwks } from "@/lib/lti/keys";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jwks = await getPublicJwks();
    return NextResponse.json(jwks, {
      headers: { "Cache-Control": "public, max-age=300, must-revalidate" }
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
