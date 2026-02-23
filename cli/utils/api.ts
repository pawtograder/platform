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

export const DEFAULT_API_URL = "https://pawtograder.com/functions/v1/cli";

export interface Credentials {
  token: string;
  api_url: string;
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
 * Send a command to the CLI edge function
 */
export async function apiCall(command: string, params: Record<string, unknown> = {}): Promise<any> {
  const creds = requireCredentials();

  let response: Response;
  try {
    response = await fetch(creds.api_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command, params })
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(`Failed to connect to API at ${creds.api_url}: ${msg}`);
  }

  let body: CLIApiResponse;
  try {
    body = await response.json();
  } catch {
    throw new CLIError(`API returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || !body.success) {
    const errorMsg = body.error || `HTTP ${response.status}`;

    if (response.status === 401) {
      throw new CLIError(
        `Authentication failed: ${errorMsg}\n` +
          "   Your token may be expired or revoked. Run 'pawtograder login' to re-authenticate."
      );
    }
    if (response.status === 403) {
      throw new CLIError(
        `Permission denied: ${errorMsg}\n` +
          "   Your token may lack the required scopes (cli:read or cli:write)."
      );
    }
    throw new CLIError(`API error: ${errorMsg}`);
  }

  return body.data;
}
