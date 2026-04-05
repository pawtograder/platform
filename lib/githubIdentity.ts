/** Find linked GitHub identity in Supabase auth identities payload (from getUserIdentities). */
export function findGithubIdentity(identities: unknown[] | undefined | null): { provider: string } | undefined {
  return (identities ?? []).find(
    (identity): identity is { provider: string } =>
      typeof identity === "object" &&
      identity !== null &&
      "provider" in identity &&
      (identity as { provider?: string }).provider === "github"
  );
}
