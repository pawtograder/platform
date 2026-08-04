/**
 * API client for the Pawtograder CLI edge function
 *
 * All CLI commands POST { command, params } to the edge function
 * with an API token for authentication.
 */

import * as fs from "fs";
import * as path from "path";
import { getCredentialsPath } from "./credentials";
import { CLIError } from "./logger";

export const DEFAULT_API_URL = "https://api.pawtograder.com/functions/v1/cli";

export interface Credentials {
  token: string;
  api_url: string;
}

/**
 * Accept either a full endpoint URL or a bare API host and return the
 * `cli` Edge Function endpoint. Self-hosted deployments serve it from the
 * API gateway origin (`https://api.<hostname>` by default), not the web host.
 */
export function normalizeApiUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CLIError(`Invalid API URL: ${url}`);
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith("/functions/v1/cli")) return parsed.toString().replace(/\/+$/, "");

  parsed.pathname = path.endsWith("/functions/v1") ? `${path}/cli` : `${path}/functions/v1/cli`;
  return parsed.toString();
}

interface CLIApiResponse {
  success: boolean;
  data?: any;
  error?: string;
  available_commands?: string[];
}

/**
 * Read stored credentials from ~/.pawtograder/credentials.json
 */
export function readCredentials(): Credentials | null {
  const credPath = getCredentialsPath();
  try {
    if (!fs.existsSync(credPath)) return null;
    const content = fs.readFileSync(credPath, "utf-8");
    const creds = JSON.parse(content) as Credentials;
    if (!creds.token) return null;
    return creds;
  } catch {
    return null;
  }
}

/**
 * Write credentials to ~/.pawtograder/credentials.json
 */
export function writeCredentials(creds: Credentials): void {
  const credPath = getCredentialsPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), {
    encoding: "utf-8",
    mode: 0o600
  });
}

/**
 * Get credentials or throw a helpful error
 */
export function requireCredentials(): Credentials {
  const creds = readCredentials();
  if (!creds) {
    throw new CLIError(
      "Not logged in. Run 'pawtograder login' to authenticate.\n" +
        "   You need an API token from Settings > API Tokens in the Pawtograder web app."
    );
  }
  return creds;
}

/**
 * The configured request timeout in milliseconds, or 0 for none.
 *
 * Rejected rather than coerced: `Number("30s")` is `NaN`, `NaN > 0` is false, so a
 * mistyped value silently disabled the timeout altogether while the operator believed
 * one was in force — and the abort-specific guidance below then became unreachable.
 */
export function resolveHttpTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CLIError(
      `Invalid PAWTOGRADER_HTTP_TIMEOUT_MS: ${raw}. Give a whole number of milliseconds, e.g. 600000, or unset it for no timeout.`
    );
  }
  return value;
}

/**
 * Send a command to the CLI edge function
 */
export async function apiCall(command: string, params: Record<string, unknown> = {}): Promise<any> {
  const creds = requireCredentials();

  const verbose = !!process.env.DEBUG || process.env.PAWTOGRADER_VERBOSE === "1";
  if (verbose) {
    console.error(`[cli] POST ${creds.api_url} command=${command}`);
  }

  const start = Date.now();
  const timeoutMs = resolveHttpTimeoutMs(process.env.PAWTOGRADER_HTTP_TIMEOUT_MS);
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const timeoutId = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetch(creds.api_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command, params }),
      signal: controller?.signal
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && (err.name === "AbortError" || /aborted|AbortError/i.test(err.message));
    if (aborted) {
      throw new CLIError(
        `Request aborted after ${timeoutMs}ms (PAWTOGRADER_HTTP_TIMEOUT_MS). ` +
          "Increase the timeout or use a smaller --batch-size for artifact imports."
      );
    }
    throw new CLIError(`Failed to connect to API at ${creds.api_url}: ${msg}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (verbose) {
    console.error(`[cli] Response HTTP ${response.status} in ${elapsed}s`);
  }

  const rawBody = await response.text();
  let body: CLIApiResponse;
  try {
    body = rawBody ? (JSON.parse(rawBody) as CLIApiResponse) : { success: false };
  } catch {
    if (response.status === 504) {
      throw new CLIError(
        `Request timed out (504 Gateway Timeout) after ${elapsed}s.\n` +
          "   Assignment copy can take several minutes (copying repos, rubrics, etc.).\n" +
          "   Try again or run with DEBUG=1 for more details."
      );
    }
    if (response.status >= 500) {
      throw new CLIError(
        `Server error (HTTP ${response.status}) after ${elapsed}s.\n` +
          `   Response body: ${rawBody.slice(0, 200)}${rawBody.length > 200 ? "..." : ""}\n` +
          "   The server may be overloaded. Try again later."
      );
    }
    if (/^\s*<(!doctype|html)/i.test(rawBody)) {
      throw new CLIError(
        `API returned an HTML page (HTTP ${response.status}) from ${creds.api_url}.\n` +
          "   That URL is serving the web app, not the 'cli' Edge Function.\n" +
          "   Point --url at your deployment's API gateway origin (usually https://api.<hostname>)."
      );
    }
    throw new CLIError(`API returned invalid JSON (HTTP ${response.status}): ${rawBody.slice(0, 150)}`);
  }

  if (!response.ok || !body.success) {
    const errorMsg = body.error || `HTTP ${response.status}`;

    if (response.status === 504) {
      throw new CLIError(
        `Request timed out (504 Gateway Timeout) after ${elapsed}s.\n` +
          "   Assignment copy can take several minutes (copying repos, rubrics, etc.).\n" +
          "   The operation may have partially completed. Run the command again to retry (it will validate/fix existing assignments).\n" +
          "   Set DEBUG=1 for more details."
      );
    }
    if (response.status === 401) {
      throw new CLIError(
        `Authentication failed: ${errorMsg}\n` +
          "   Your token may be expired or revoked. Run 'pawtograder login' to re-authenticate."
      );
    }
    if (response.status === 403) {
      throw new CLIError(
        `Permission denied: ${errorMsg}\n` + "   Your token may lack the required scopes (cli:read or cli:write)."
      );
    }
    if (response.status >= 500) {
      throw new CLIError(
        `Server error: ${errorMsg}\n` +
          `   Request took ${elapsed}s. The operation may have partially completed. Run again to retry.`
      );
    }
    throw new CLIError(`API error: ${errorMsg}`);
  }

  if (verbose) {
    console.error(`[cli] Success in ${elapsed}s`);
  }
  return body.data;
}
