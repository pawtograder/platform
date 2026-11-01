/**
 * Scrubs credentials out of git's stderr and argv before either is logged or embedded in an
 * error (docs/handout-sync-git-worker.md §8.2). This is the class of leak #1144 fixed.
 *
 * Git does not normally print the auth header, because `runGit()` never passes `GIT_TRACE*` or
 * `GIT_CURL_VERBOSE`. Redaction is the second line: a remote can echo a URL back, a helper can
 * print a header in a diagnostic, and a future git may log more than today's. So the patterns
 * cover the shapes a GitHub credential takes in text, and `redactSecrets` also removes the exact
 * strings the caller knows are secret (the job's token and its encoded header value).
 */

const REDACTED = "[REDACTED]";

/** Pattern, replacement pairs. Order matters only in that each is applied to the previous output. */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // An Authorization header, wherever it appears, through the end of the line.
  [/(authorization\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`],
  // "basic <base64>" or "bearer <token>" without the header name in front.
  [/\b(basic|bearer)(\s+)[A-Za-z0-9+/=._-]{8,}/gi, `$1$2${REDACTED}`],
  // The installation-token userinfo form, x-access-token:<token>.
  [/(x-access-token:)[^@\s]*/gi, `$1${REDACTED}`],
  // base64("x-access-token:") followed by the rest of the encoded credential.
  [/eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]*/g, REDACTED],
  // GitHub token formats: installation (ghs_), personal (ghp_), OAuth (gho_), user-to-server
  // (ghu_), refresh (ghr_) and fine-grained personal tokens.
  [/\bgh[spour]_[A-Za-z0-9]{16,}/g, `gh*_${REDACTED}`],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, `github_pat_${REDACTED}`],
  // Userinfo in any URL: scheme://user[:password]@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`]
];

/**
 * Returns `text` with every credential-shaped substring replaced. `knownSecrets` are removed
 * verbatim first, so a token that matches no pattern (a test token, a future format) is still
 * caught when the caller supplied it.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    // Short strings would redact ordinary words. Real tokens and headers are far longer.
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
