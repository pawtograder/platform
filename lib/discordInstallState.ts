/**
 * The signed, short-lived `state` for the Discord bot install round-trip.
 *
 * The install flow is two requests with a trip through discord.com in between: `/api/discord/install`
 * sends the instructor to Discord's consent screen, and Discord redirects the browser back to
 * `/api/discord/install/callback` with the guild it was added to. Nothing about that return trip is
 * trustworthy on its own -- an attacker can hand an instructor a callback URL naming any
 * `class_id`/`guild_id` pair they like -- so the state carries the class and user the flow was
 * started for, signed, and the callback refuses anything it did not mint.
 *
 * Same construction as `lib/lti/state.ts`, which solves the identical problem for the LTI OIDC
 * round-trip: an HS256 JWT over a server-side secret, ten-minute expiry, `jose` for both halves. No
 * new crypto and no hand-rolled HMAC framing.
 *
 * Two things the signature alone does not give, and how they are covered:
 *
 *   - Replay. A signed state is a bearer token for ten minutes, so `nonce` is also written to an
 *     HttpOnly cookie that the callback requires to match and then clears. That binds the state to
 *     the browser that started the flow and makes it single-use, without a nonce table.
 *   - Authorization. The state proves intent, not standing. The callback re-checks that the user is
 *     still an instructor of the class; a state minted before somebody's enrollment was disabled must
 *     not still work.
 */
import "server-only";
import { SignJWT, jwtVerify } from "jose";

/**
 * Ten minutes, matching lib/lti/state.ts. Long enough to read Discord's consent screen and pick a
 * server from a long list; short enough that a state lifted from a browser history or a referrer log
 * is almost always already dead.
 */
const INSTALL_STATE_TTL = "10m";

/**
 * Holds the nonce for the browser that started the flow.
 *
 * `Lax` rather than `None`: the return leg is a top-level GET navigation from discord.com, which Lax
 * sends. Scoped to the install routes so it is not attached to anything else. Not `secure` in
 * development, where the flow runs over http://localhost and a Secure cookie would simply be dropped
 * -- which reads as "the flow is broken" rather than "your dev server is not HTTPS".
 */
export const DISCORD_INSTALL_NONCE_COOKIE = "discord_install_nonce";
export const DISCORD_INSTALL_NONCE_COOKIE_PATH = "/api/discord/install";
/** Seconds. Deliberately the same window as the JWT's expiry. */
export const DISCORD_INSTALL_NONCE_COOKIE_MAX_AGE = 600;

/**
 * The signing key.
 *
 * `DISCORD_INSTALL_STATE_SECRET` when set, so this can be rotated on its own. It falls back to the
 * service-role key rather than throwing: that key is already required by the callback (the claim RPC
 * is granted to service_role only), so the fallback cannot be the difference between a working and a
 * broken deployment, and a deployment that has not added a new secret gets a working install flow
 * instead of a 500 on a button. Never mixed with anything user-supplied, and only ever used to sign
 * a state this process also verifies.
 */
function stateSecret(): Uint8Array {
  const secret = process.env.DISCORD_INSTALL_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("DISCORD_INSTALL_STATE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is not configured");
  }
  return new TextEncoder().encode(secret);
}

export type DiscordInstallState = {
  /** The class the install was started for. */
  classId: number;
  /** The Supabase user who started it. */
  userId: string;
  /** Single-use marker, mirrored in DISCORD_INSTALL_NONCE_COOKIE. */
  nonce: string;
};

export function randomInstallNonce(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

export async function createInstallState(state: DiscordInstallState): Promise<string> {
  return new SignJWT({ classId: state.classId, userId: state.userId, nonce: state.nonce })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(INSTALL_STATE_TTL)
    .sign(stateSecret());
}

/**
 * Verify a state's signature and expiry and return its claims.
 *
 * Throws on a bad signature, an expired token, or claims of the wrong shape. A claim set that
 * verifies but carries, say, a string `classId` is rejected rather than coerced: everything
 * downstream indexes a class by it, and `Number("")` is 0.
 */
export async function verifyInstallState(token: string): Promise<DiscordInstallState> {
  // Same 30s clock tolerance as the LTI verifier, for skew between the signing and verifying hosts.
  const { payload } = await jwtVerify(token, stateSecret(), { clockTolerance: 30 });
  const classId = payload.classId;
  const userId = payload.userId;
  const nonce = payload.nonce;
  if (typeof classId !== "number" || !Number.isInteger(classId) || classId <= 0) {
    throw new Error("Discord install state has no valid class id");
  }
  if (typeof userId !== "string" || userId === "") {
    throw new Error("Discord install state has no user id");
  }
  if (typeof nonce !== "string" || nonce === "") {
    throw new Error("Discord install state has no nonce");
  }
  return { classId, userId, nonce };
}
