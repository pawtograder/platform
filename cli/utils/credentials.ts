/**
 * Credentials management for the Pawtograder CLI
 *
 * Stores and retrieves API tokens from ~/.pawtograder/credentials.json
 * Token can also be provided via PAWTOGRADER_TOKEN environment variable.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".pawtograder");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

interface Credentials {
  token: string;
  api_url: string;
}

/**
 * Get the path to the credentials file
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * Ensure the config directory exists
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

/**
 * Save credentials to disk
 */
export function saveCredentials(token: string, apiUrl: string): void {
  ensureConfigDir();
  const creds: Credentials = { token, api_url: apiUrl };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load credentials from disk or environment
 *
 * Priority:
 *   1. PAWTOGRADER_TOKEN env var (+ PAWTOGRADER_API_URL or default)
 *   2. ~/.pawtograder/credentials.json
 */
export function loadCredentials(): Credentials | null {
  // 1. Check env var
  const envToken = process.env.PAWTOGRADER_TOKEN;
  if (envToken) {
    const envUrl =
      process.env.PAWTOGRADER_API_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      "";
    return { token: envToken, api_url: envUrl };
  }

  // 2. Check credentials file
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
      const creds = JSON.parse(raw) as Credentials;
      if (creds.token && creds.api_url) {
        return creds;
      }
    } catch {
      // Corrupted file, ignore
    }
  }

  return null;
}

/**
 * Delete stored credentials
 */
export function clearCredentials(): void {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
  }
}

/**
 * Get just the token, or throw if not authenticated
 */
export function requireToken(): { token: string; apiUrl: string } {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "Not authenticated. Run 'pawtograder login --token <your-token>' or set PAWTOGRADER_TOKEN environment variable.\n" +
        "Generate a CLI token from the API Tokens menu in Pawtograder settings."
    );
  }
  return { token: creds.token, apiUrl: creds.api_url };
}
