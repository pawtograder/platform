/**
 * The session and identity leak check G1 runs over Sentry envelopes, shared by the Jest half
 * (tests/unit/bugReport-sentryScrub.test.ts) and the E2E half (identity.spec.ts).
 */

export function base64Variants(text: string): string[] {
  // The email inside a base64 cookie shows up at one of three alignments; drop the edge
  // characters that depend on what surrounds it.
  const out = new Set<string>();
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.from("x".repeat(pad) + text)
      .toString("base64")
      .replace(/=+$/, "");
    const skip = pad === 0 ? 0 : Math.ceil((pad * 4) / 3);
    const core = encoded.slice(skip, encoded.length - 2);
    out.add(core).add(core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...out];
}

/**
 * What a Sentry envelope must never contain (G1, ADR 3): a cookie key, a Supabase auth-token cookie
 * name, a JWT, the user's email, or the email base64-encoded (the Supabase session cookie is
 * base64 JSON). Returns a description of each leak found; empty means clean.
 */
export function sessionLeaks(serialized: string, email: string): string[] {
  const problems: string[] = [];
  const lower = serialized.toLowerCase();
  if (/"cookies?"\s*:/i.test(serialized)) problems.push("a cookie key");
  if (/sb-[a-z0-9-]*auth-token/i.test(serialized)) problems.push("an sb- auth-token cookie name");
  if (/eyJ[A-Za-z0-9_-]{8,}/.test(serialized)) problems.push("a JWT-shaped string");
  if (lower.includes(email.toLowerCase())) problems.push("the email");
  for (const v of base64Variants(email)) if (serialized.includes(v)) problems.push(`the base64 of the email (${v})`);
  return problems;
}
