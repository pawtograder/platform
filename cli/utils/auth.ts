/**
 * CLI authentication utilities
 *
 * Token-based authentication for the Pawtograder CLI.
 * Tokens are created in the web UI (Settings > API Tokens).
 */

import * as fs from "fs";
import * as readline from "readline";
import { Writable } from "stream";
import { readCredentials, writeCredentials, apiCall, DEFAULT_API_URL, type Credentials } from "./api";
import { getCredentialsPath } from "./credentials";
import { logger, CLIError } from "./logger";

export interface LoginOptions {
  token?: string;
  url?: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Prompt for a line of input from stdin without echoing (for API tokens).
 */
function promptForInput(prompt: string): Promise<string> {
  const mutedOut = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedOut
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (action: "ok" | "cancel", answer?: string) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSigInt);
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      try {
        mutedOut.destroy();
      } catch {
        /* ignore */
      }
      process.stdout.write("\n");
      if (action === "ok") resolve(answer ?? "");
      else reject(new CLIError("Login cancelled."));
    };

    const onSigInt = () => {
      finish("cancel");
    };

    process.on("SIGINT", onSigInt);

    process.stdout.write(prompt);
    rl.question("", (answer) => {
      finish("ok", answer);
    });
  });
}

/**
 * Login with an API token.
 * Token can be passed via --token flag or prompted interactively.
 */
export async function startLoginFlow(options: LoginOptions): Promise<void> {
  let token = options.token;

  if (!token) {
    logger.info("Enter your Pawtograder API token.");
    logger.info("Create one at: https://app.pawtograder.com -> User Menu -> API Tokens");
    logger.info('Choose "CLI" or "MCP + CLI" token type.');
    logger.blank();

    token = await promptForInput("Token: ");
  }

  if (!token || !token.trim()) {
    throw new CLIError("No token provided.");
  }

  token = token.trim();

  if (!token.startsWith("mcp_")) {
    throw new CLIError("Invalid token format. Pawtograder API tokens start with 'mcp_'.");
  }

  const apiUrl = options.url || DEFAULT_API_URL;

  const previousCreds: Credentials | null = readCredentials();

  writeCredentials({ token, api_url: apiUrl });

  logger.info("Verifying token...");
  try {
    await apiCall("token.info");
    logger.success("Authentication successful!");
    logger.info(`Credentials stored at: ${getCredentialsPath()}`);
  } catch (error) {
    const credPath = getCredentialsPath();
    try {
      if (previousCreds) {
        writeCredentials(previousCreds);
      } else if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
      }
    } catch {
      // ignore restore/cleanup errors
    }
    throw error;
  }
}

/**
 * Log out and clear stored credentials
 */
export async function logout(): Promise<void> {
  const credPath = getCredentialsPath();
  try {
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
  } catch {
    // Ignore errors when clearing credentials
  }
}

/**
 * Get the currently authenticated user, if any
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const creds = readCredentials();
  if (!creds) return null;

  try {
    const data = await apiCall("token.info");
    return {
      id: data.user_id,
      email: data.email || "(unknown)",
      name: data.name || null
    };
  } catch {
    return null;
  }
}
