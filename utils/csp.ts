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

// PostHog ingest + UI hosts (set in env). PostHog's JS posts events over fetch
// to api_host, so connect-src must list it. ui_host is link-out only but cheap
// to allow.
function extraPosthogOrigins(): string[] {
  const out: string[] = [];
  for (const raw of [process.env.NEXT_PUBLIC_POSTHOG_HOST, process.env.NEXT_PUBLIC_POSTHOG_UI_HOST]) {
    if (!raw) continue;
    try {
      out.push(new URL(raw).origin);
    } catch {
      /* ignore */
    }
  }
  return out;
}

// AWS Chime SDK browser traffic. The SDK does regional discovery against
// `*.l.chime.aws`, fetches the SDK manifest from `*.chime.aws`, and opens
// signaling WebSockets at `wss://*.chime.aws`. Media servers live under
// `*.amazonaws.com` (e.g. media-router-{region}.chime.aws → backed-by
// `*.amazonaws.com`). Without these, the help-queue video-call feature
// breaks the moment CSP enforcement flips on.
const CHIME_HTTPS = ["https://*.chime.aws", "https://*.amazonaws.com"] as const;
const CHIME_WSS = ["wss://*.chime.aws", "wss://*.amazonaws.com"] as const;

// Pyret REPL frames. `@ironm00n/pyret-embed` defaults to loading the editor
// from pyret-horizon.herokuapp.com inside a nested iframe and communicates
// via postMessage, so frame-src must allowlist the host (no connect-src
// entry needed — the parent never fetches it directly).
const PYRET_FRAME = ["https://pyret-horizon.herokuapp.com"] as const;

// Giphy picker (`@giphy/react-components`) calls api.giphy.com for search /
// trending, pingback.giphy.com for telemetry, and serves bitmaps from
// media*.giphy.com. Cover all subdomains; the image hosts ride on the
// existing `https:` img-src allowance, the rest need explicit connect-src.
const GIPHY_CONNECT = ["https://*.giphy.com"] as const;

// Google Fonts — `amazon-chime-sdk-component-library-react` injects an
// Open Sans @import. The stylesheet lives at fonts.googleapis.com and the
// woff2 files at fonts.gstatic.com.
const GOOGLE_FONTS_STYLE = ["https://fonts.googleapis.com"] as const;
const GOOGLE_FONTS_FILES = ["https://fonts.gstatic.com"] as const;

// `@wooorm/starry-night` (markdown syntax highlighting) loads the
// vscode-oniguruma WASM blob from esm.sh at runtime via fetch().
const STARRY_NIGHT_CONNECT = ["https://esm.sh"] as const;

// Monaco editor loads its bundle + CSS files + source maps + web workers
// from cdn.jsdelivr.net. The actual <script> loading rides on
// `'strict-dynamic'` (the nonced AMD loader injects further scripts), but
// CSS goes through style-src and source maps / worker scripts go through
// connect-src.
const MONACO_CDN = ["https://cdn.jsdelivr.net"] as const;

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
  const posthog = extraPosthogOrigins();
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-eval'"] : [])]
    ],
    ["style-src", ["'self'", "'unsafe-inline'", ...GOOGLE_FONTS_STYLE, ...MONACO_CDN]],
    // img-src keeps `https:` because user-set avatar URLs (and student-supplied
    // markdown image references rendered through the sanitizer) can point at
    // arbitrary public hosts. Loading an image cannot execute script, so this
    // is the cheapest directive to leave wide.
    ["img-src", ["'self'", "data:", "blob:", "https:", ...supa]],
    ["font-src", ["'self'", "data:", ...GOOGLE_FONTS_FILES, ...MONACO_CDN]],
    ["media-src", ["'self'", "data:", "blob:", ...supa]],
    // connect-src is the directive that actually gates exfiltration after a
    // successful script injection, so enumerate origins instead of allowing
    // any `https:`/`wss:`. Keep this list in sync with the browser-side
    // fetch/WebSocket destinations: Supabase, AWS Chime SDK, PostHog.
    [
      "connect-src",
      [
        "'self'",
        ...supa,
        ...CHIME_HTTPS,
        ...CHIME_WSS,
        ...GIPHY_CONNECT,
        ...STARRY_NIGHT_CONNECT,
        ...MONACO_CDN,
        ...posthog,
        ...(dev ? ["ws:", "http://localhost:*", "http://127.0.0.1:*"] : [])
      ]
    ],
    ["frame-src", ["'self'", "blob:", ...supa, ...PYRET_FRAME]],
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
