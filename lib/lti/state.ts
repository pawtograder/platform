/**
 * Signed, short-lived OIDC state for the LTI login → launch round-trip.
 *
 * The state value is an HS256 JWT carrying the nonce and the intended platform,
 * so the launch endpoint can (a) confirm the launch corresponds to a login we
 * initiated (CSRF) and (b) recover the nonce to match against the id_token.
 */
import { SignJWT, jwtVerify } from "jose";

function stateSecret(): Uint8Array {
  const secret = process.env.LTI_STATE_SECRET || process.env.LTI_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error("LTI_STATE_SECRET (or LTI_KEY_ENCRYPTION_SECRET) is not configured");
  return new TextEncoder().encode(secret);
}

export type LtiState = {
  nonce: string;
  iss: string;
  clientId?: string;
  targetLinkUri?: string;
};

export async function createState(state: LtiState): Promise<string> {
  return new SignJWT({ ...state })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(stateSecret());
}

export async function verifyState(token: string): Promise<LtiState> {
  const { payload } = await jwtVerify(token, stateSecret(), { clockTolerance: 30 });
  return {
    nonce: payload.nonce as string,
    iss: payload.iss as string,
    clientId: payload.clientId as string | undefined,
    targetLinkUri: payload.targetLinkUri as string | undefined
  };
}

export function randomNonce(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}
