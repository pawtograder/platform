import { GitProviderName } from "./gitProviderOptions";

/**
 * Returns the base URL for the configured Git provider.
 * Defaults to github.com if no provider is specified.
 */
export function getGitProviderBaseUrl(provider?: string | null): string {
  if (provider === "forgejo") {
    return "forgejo.internal"; // Placeholder
  }
  return "github.com";
}

/**
 * Constructs a full URL for a specific provider.
 */
export function getGitUrl(provider: GitProviderName, path: string): string {
  const base = getGitProviderBaseUrl(provider);
  return `https://${base}/${path.replace(/^\//, "")}`;
}
