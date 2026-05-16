// Per-request nonce for inline scripts. 128 bits is plenty for CSP.
// Uses Web Crypto so it runs in the Next.js edge runtime (middleware).
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type CspOptions = { dev?: boolean };

// Origins explicitly allowed for connect/frame/img beyond the schemes below.
// We pull `NEXT_PUBLIC_SUPABASE_URL` so that a non-https Supabase (local dev
// against 127.0.0.1:54321) keeps working even when the prod policy otherwise
// restricts http:.
function extraSupabaseOrigin(): string[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return [];
  try {
    const u = new URL(raw);
    const httpOrigin = u.origin;
    // Realtime uses ws(s):// at the same host:port as the REST origin.
    const wsOrigin = httpOrigin.replace(/^http/, "ws");
    return [httpOrigin, wsOrigin];
  } catch {
    return [];
  }
}

// Strict, nonce-based CSP. `'strict-dynamic'` makes the browser ignore the
// host allowlist for script-src and trust only nonced/hashed scripts plus
// anything those scripts go on to load — which is what Next.js does for its
// own chunks once its loader has the nonce.
//
// `style-src 'unsafe-inline'` is the unavoidable carve-out for Chakra/emotion
// CSS-in-JS. Script execution stays locked down regardless, so this does not
// re-enable the `javascript:`-href XSS class that the chat-message fix
// addresses; CSP3 blocks `javascript:` URI execution under script-src unless
// `'unsafe-inline'` is allowed in *script-src* (which we do not).
export function buildCsp(nonce: string, opts: CspOptions = {}): string {
  const dev = !!opts.dev;
  const supa = extraSupabaseOrigin();
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-eval'"] : [])]
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:", ...supa]],
    ["font-src", ["'self'", "data:", "https:"]],
    ["media-src", ["'self'", "data:", "blob:", "https:", ...supa]],
    ["connect-src", ["'self'", "https:", "wss:", ...supa, ...(dev ? ["ws:", "http:"] : [])]],
    ["frame-src", ["'self'", "https:", "blob:", ...supa]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]]
  ];
  if (!dev) directives.push(["upgrade-insecure-requests", []]);

  return directives.map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k)).join("; ");
}

export function cspHeaderName(): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return process.env.CSP_REPORT_ONLY === "1" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}
