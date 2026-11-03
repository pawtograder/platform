/**
 * Returns `value` when it is a path on this site, otherwise undefined.
 *
 * `startsWith("/")` alone is not enough: `//evil.test` is protocol-relative, and browsers drop
 * tabs/newlines and read `\` as `/`, so `/\t/evil.test` or `/\evil.test` would leave the origin too.
 */
export function safeRedirectPath(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith("/")) return undefined;
  if ([...value].some((c) => c === "\\" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return undefined;
  const base = "http://pawtograder.invalid";
  try {
    return new URL(value, base).origin === base ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts a URL on `appBaseUrl`'s origin, such as GoTrue's `{{ .RedirectTo }}` in an email link,
 * into a path that passes `safeRedirectPath`. Any other origin, or an unparsable value, gives undefined.
 */
export function sameOriginRedirectPath(
  value: string | null | undefined,
  appBaseUrl: string | null | undefined
): string | undefined {
  if (!value || !appBaseUrl) return undefined;
  try {
    const origin = new URL(appBaseUrl).origin;
    const url = new URL(value, origin);
    if (url.origin !== origin) return undefined;
    return safeRedirectPath(url.pathname + url.search + url.hash);
  } catch {
    return undefined;
  }
}
