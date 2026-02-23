/**
 * Authentication utilities for the Pawtograder CLI
 *
 * Login flow:
 *   pawtograder login --token <token> --url <url>
 *
 * The token is a CLI API token generated from the Pawtograder web UI
 * (Settings → API Tokens → Create a "CLI" token).
 */

import { saveCredentials, loadCredentials, clearCredentials } from "./credentials";
import { logger, CLIError } from "./logger";

interface LoginOptions {
  token?: string;
  url?: string;
  email?: string; // kept for interface compat, not used with tokens
  noBrowser?: boolean; // kept for interface compat
}

/**
 * Login by saving a CLI token
 */
export async function startLoginFlow(options: LoginOptions): Promise<void> {
  if (!options.token) {
    logger.step("How to get a CLI token");
    logger.blank();
    logger.info("1. Go to your Pawtograder instance in a browser");
    logger.info("2. Open Settings → API Tokens");
    logger.info("3. Create a new token with type 'CLI (Command Line)'");
    logger.info("4. Copy the token and run:");
    logger.blank();
    logger.info("   pawtograder login --token <your-token> --url <your-pawtograder-url>");
    logger.blank();
    logger.info("Or set environment variables:");
    logger.info("   export PAWTOGRADER_TOKEN=mcp_...");
    logger.info("   export PAWTOGRADER_API_URL=https://your-instance.supabase.co");
    throw new CLIError("Token required. Use --token flag or follow the instructions above.");
  }

  if (!options.url) {
    // Try to infer from environment
    const envUrl =
      process.env.PAWTOGRADER_API_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!envUrl) {
      throw new CLIError(
        "API URL required. Use --url flag or set PAWTOGRADER_API_URL environment variable.\n" +
          "Example: pawtograder login --token mcp_... --url https://your-instance.supabase.co"
      );
    }
    options.url = envUrl;
  }

  // Validate token format
  if (!options.token.startsWith("mcp_")) {
    throw new CLIError("Invalid token format. CLI tokens should start with 'mcp_'.");
  }

  // Test the token by calling the CLI edge function
  logger.info("Verifying token...");

  const url = `${options.url}/functions/v1/cli`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command: "classes.list", params: {} })
    });

    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      throw new CLIError(
        `Token verification failed: ${body.error || `HTTP ${res.status}`}\n` +
          "Make sure you created a token with CLI scopes (cli:read, cli:write)."
      );
    }

    if (!res.ok) {
      throw new CLIError(`Server error during verification: HTTP ${res.status}`);
    }
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw new CLIError(`Could not reach server at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Save credentials
  saveCredentials(options.token, options.url);
  logger.success("Logged in successfully!");
  logger.info(`Credentials saved to ~/.pawtograder/credentials.json`);
}

/**
 * Logout by clearing stored credentials
 */
export async function logout(): Promise<void> {
  clearCredentials();
}

/**
 * Get info about the current authentication state
 */
export async function getCurrentUser(): Promise<{ email: string; name: string; id: string } | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // Token-based auth doesn't store user info locally.
  // Return a placeholder indicating we're authenticated via token.
  return {
    email: "(token-based auth)",
    name: "(token-based auth)",
    id: `token:${creds.token.substring(0, 12)}...`
  };
}
