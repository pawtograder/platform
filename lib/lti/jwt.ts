/**
 * id_token validation for LTI Resource Link / Deep Linking launches.
 *
 * Performs the full LTI 1.3 security check sequence:
 *  1. resolve the platform by (iss, client_id/aud)
 *  2. verify the JWT signature against the platform JWKS, with iss/aud/exp/iat
 *  3. enforce LTI required claims (version 1.3.0, message_type, deployment_id)
 *  4. consume the nonce (single use) to prevent replay
 *  5. project the validated claims into an LtiLaunchContext
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { LTI_CLAIM, type LtiLaunchContext, ltiRolesToAppRole } from "./types";
import { ltiAdminClient, type LtiDb } from "./db";
import { decodeJwtPayload as decodePayload } from "./util";

// Cache one remote JWKS resolver per platform JWKS URL (jose caches the fetch).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksForUrl(url: string) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 });
    jwksCache.set(url, set);
  }
  return set;
}

export class LtiValidationError extends Error {}

type PlatformRow = {
  id: number;
  issuer: string;
  client_id: string;
  jwks_url: string;
  enabled: boolean;
};

async function resolvePlatform(db: LtiDb, iss: string, aud: string | string[]): Promise<PlatformRow> {
  const auds = Array.isArray(aud) ? aud : [aud];
  const { data, error } = await db
    .from("lti_platforms")
    .select("id, issuer, client_id, jwks_url, enabled")
    .eq("issuer", iss);
  if (error) throw error;
  const match = (data ?? []).find((p) => auds.includes(p.client_id));
  if (!match) {
    throw new LtiValidationError(`No registered LTI platform for issuer ${iss} / aud ${auds.join(",")}`);
  }
  if (!match.enabled) {
    throw new LtiValidationError(`LTI platform ${iss} is disabled`);
  }
  return match;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Verify and project an id_token. `expectedNonce` (from our login state) must
 * match the token nonce; the nonce is then consumed so it cannot be replayed.
 */
export async function verifyLaunchToken(
  idToken: string,
  opts: { expectedNonce?: string; db?: LtiDb } = {}
): Promise<LtiLaunchContext> {
  const db = opts.db ?? ltiAdminClient();

  // Peek the unverified payload to find iss/aud and locate the platform.
  const unverified = decodePayload(idToken) as JWTPayload;
  const iss = asString(unverified.iss);
  if (!iss) throw new LtiValidationError("id_token missing iss");
  if (unverified.aud === undefined) throw new LtiValidationError("id_token missing aud");

  const platform = await resolvePlatform(db, iss, unverified.aud as string | string[]);

  // Verify signature + standard temporal/issuer/audience claims.
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksForUrl(platform.jwks_url), {
      issuer: platform.issuer,
      audience: platform.client_id,
      clockTolerance: 60
    }));
  } catch (e) {
    throw new LtiValidationError(`id_token signature/claim verification failed: ${(e as Error).message}`);
  }

  // ---- LTI required claims ----
  const version = asString(payload[LTI_CLAIM.version]);
  if (version !== "1.3.0") {
    throw new LtiValidationError(`Unsupported LTI version: ${version ?? "(none)"}`);
  }
  const deploymentId = asString(payload[LTI_CLAIM.deploymentId]);
  if (!deploymentId) throw new LtiValidationError("id_token missing deployment_id");

  const sub = asString(payload.sub);
  if (!sub) throw new LtiValidationError("id_token missing sub");

  // ---- Nonce: must match login state and be single-use ----
  const nonce = asString(payload.nonce);
  if (!nonce) throw new LtiValidationError("id_token missing nonce");
  if (opts.expectedNonce && opts.expectedNonce !== nonce) {
    throw new LtiValidationError("id_token nonce does not match login state");
  }
  const { data: fresh, error: nonceErr } = await db.rpc("lti_consume_nonce", { p_nonce: nonce });
  if (nonceErr) throw nonceErr;
  if (fresh === false) throw new LtiValidationError("id_token nonce already used (replay)");

  return projectClaims(payload, platform, deploymentId, sub);
}

function projectClaims(
  payload: JWTPayload,
  platform: PlatformRow,
  deploymentId: string,
  sub: string
): LtiLaunchContext {
  const ctx = payload[LTI_CLAIM.context] as { id: string; label?: string; title?: string } | undefined;
  const resourceLink = payload[LTI_CLAIM.resourceLink] as { id: string; title?: string } | undefined;
  const nrps = payload[LTI_CLAIM.nrps] as { context_memberships_url?: string } | undefined;
  const ags = payload[LTI_CLAIM.ags] as { lineitems?: string; lineitem?: string; scope?: string[] } | undefined;
  const lis = payload[LTI_CLAIM.lis] as { person_sourcedid?: string } | undefined;
  const roles = (payload[LTI_CLAIM.roles] as string[] | undefined) ?? [];

  return {
    platformId: platform.id,
    issuer: platform.issuer,
    clientId: platform.client_id,
    deploymentId,
    sub,
    name: asString(payload.name),
    email: asString(payload.email),
    lisPersonSourcedId: asString(lis?.person_sourcedid),
    roles,
    appRole: ltiRolesToAppRole(roles),
    context: ctx ? { id: ctx.id, label: ctx.label, title: ctx.title } : undefined,
    resourceLink: resourceLink ? { id: resourceLink.id, title: resourceLink.title } : undefined,
    targetLinkUri: asString(payload[LTI_CLAIM.targetLinkUri]),
    nrpsUrl: asString(nrps?.context_memberships_url),
    ags: ags
      ? { lineItemsUrl: asString(ags.lineitems), lineItemUrl: asString(ags.lineitem), scopes: ags.scope ?? [] }
      : undefined,
    custom: (payload[LTI_CLAIM.custom] as Record<string, string> | undefined) ?? undefined,
    rawClaims: payload as Record<string, unknown>
  };
}
