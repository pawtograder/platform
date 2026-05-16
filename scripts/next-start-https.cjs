"use strict";

/**
 * Production Next.js over HTTPS (TLS terminates in Node; same runtime as `next start`).
 *
 * Requires `npm run build` first. Paths default to `.certs/` (files are gitignored via *.pem).
 *
 * Env:
 *   PORT          — HTTPS listen port (default 3443)
 *   HOSTNAME      — bind host (default localhost)
 *   SSL_KEY_PATH  — PEM private key (default .certs/localhost-key.pem under repo root)
 *   SSL_CERT_PATH — PEM certificate (default .certs/localhost.pem); set both if you override
 *   SSL_CERT_DIR  — optional extra directory (first in search list) for localhost-key.pem / discovery
 *
 * Defaults search (first match wins), all under repo root — not shell cwd:
 *   .certs/              — expected location
 *   certificates/       — alternate folder (already gitignored in this repo)
 *   .certs/.certs/      — if you ran `mkdir .certs` while already inside `.certs/`, certs end up here (last resort)
 * If only mkcert-style names exist (e.g. localhost+2-key.pem + localhost+2.pem), those are picked per-directory when unambiguous.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { parse } = require("url");
const next = require("next");

/** Repo root (directory that contains `package.json`), not `process.cwd()` — that may differ if you invoke Node from elsewhere. */
const projectRoot = path.resolve(__dirname, "..");
const defaultCertDir = path.join(projectRoot, ".certs");

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

/**
 * @param {string} p
 * @returns {string}
 */
function resolveUserPath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/** Directories to look for localhost*.pem or a single mkcert *-key.pem pair (in order). */
function getTlsSearchDirs() {
  const extra = process.env.SSL_CERT_DIR ? [resolveUserPath(process.env.SSL_CERT_DIR)] : [];
  return [...extra, defaultCertDir, path.join(projectRoot, "certificates"), path.join(defaultCertDir, ".certs")];
}

/**
 * mkcert writes e.g. `localhost+2-key.pem` + `localhost+2.pem`. If defaults are missing, use the only *-key.pem / *.pem pair in `.certs/`.
 * @returns {{ keyPath: string, certPath: string } | null}
 */
function discoverMkcertPair(certDir) {
  if (!fs.existsSync(certDir)) {
    return null;
  }
  const names = fs.readdirSync(certDir);
  const pairs = [];
  for (const name of names) {
    if (!name.endsWith("-key.pem")) {
      continue;
    }
    const certName = name.replace(/-key\.pem$/, ".pem");
    const keyPath = path.join(certDir, name);
    const certPath = path.join(certDir, certName);
    if (names.includes(certName) && fs.statSync(keyPath).isFile() && fs.statSync(certPath).isFile()) {
      pairs.push({ keyPath, certPath });
    }
  }
  if (pairs.length === 1) {
    return pairs[0];
  }
  return null;
}

/**
 * @returns {{ keyPath: string, certPath: string, dir: string } | null}
 */
function findFirstTlsPair() {
  for (const dir of getTlsSearchDirs()) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const k = path.join(dir, "localhost-key.pem");
    const c = path.join(dir, "localhost.pem");
    if (fs.existsSync(k) && fs.existsSync(c)) {
      return { keyPath: k, certPath: c, dir };
    }
    const discovered = discoverMkcertPair(dir);
    if (discovered) {
      return { keyPath: discovered.keyPath, certPath: discovered.certPath, dir };
    }
  }
  return null;
}

const hostname = process.env.HOSTNAME || "localhost";
const port = Number.parseInt(process.env.PORT || "3443", 10);

let keyPath;
let certPath;
if (process.env.SSL_KEY_PATH || process.env.SSL_CERT_PATH) {
  if (!process.env.SSL_KEY_PATH || !process.env.SSL_CERT_PATH) {
    console.error("Set both SSL_KEY_PATH and SSL_CERT_PATH (or neither to use defaults / auto-discovery).");
    process.exit(1);
  }
  keyPath = resolveUserPath(process.env.SSL_KEY_PATH);
  certPath = resolveUserPath(process.env.SSL_CERT_PATH);
} else {
  const found = findFirstTlsPair();
  if (found) {
    keyPath = found.keyPath;
    certPath = found.certPath;
    if (found.dir !== defaultCertDir) {
      console.info(`Using TLS directory: ${path.relative(projectRoot, found.dir) || "."}`);
    }
  } else {
    keyPath = path.join(defaultCertDir, "localhost-key.pem");
    certPath = path.join(defaultCertDir, "localhost.pem");
  }
}

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  const scanned = getTlsSearchDirs()
    .map((dir) => {
      if (!fs.existsSync(dir)) {
        return `  (missing) ${dir}`;
      }
      try {
        const names = fs.readdirSync(dir);
        const pem = names.filter((f) => f.endsWith(".pem"));
        const label = pem.length > 0 ? pem.join(", ") : names.join(", ") || "(empty)";
        return `  ${dir}\n    → ${label}`;
      } catch {
        return `  (unreadable) ${dir}`;
      }
    })
    .join("\n");
  console.error(
    [
      "Missing TLS certificate files.",
      `  Looked for: localhost-key.pem + localhost.pem (or one mkcert *-key.pem pair) in:`,
      scanned,
      "",
      "Tip: if your shell is already in project/.certs, use `keyout localhost-key.pem` (no extra .certs/),",
      "  or put files in project/certificates/ — this script searches .certs/, certificates/, then .certs/.certs/.",
      "",
      "From repo root, self-signed (browser will warn):",
      "  mkdir -p .certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout .certs/localhost-key.pem \\",
      '    -out .certs/localhost.pem -days 365 -subj "/CN=localhost"',
      ""
    ].join("\n")
  );
  process.exit(1);
}

const app = next({ dev: false, hostname, port, dir: projectRoot });

app
  .prepare()
  .then(() => {
    const handle = app.getRequestHandler();
    https
      .createServer(
        {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath)
        },
        async (req, res) => {
          try {
            await handle(req, res, parse(req.url, true));
          } catch (err) {
            console.error("Request handler error", req.url, err);
            res.statusCode = 500;
            res.end("internal server error");
          }
        }
      )
      .listen(port, hostname, () => {
        console.log(`Ready — production build over HTTPS: https://${hostname}:${port}`);
      });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
