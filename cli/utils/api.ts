/**
 * API client for the Pawtograder CLI edge function
 *
 * Each CLI command = one POST to /functions/v1/cli
 * Authenticated via Bearer token (API token with cli:read / cli:write scope)
 */

import { requireToken } from "./credentials";
import { CLIError } from "./logger";

export interface CLIResponse {
  success: boolean;
  data?: any;
  error?: string;
  available_commands?: string[];
}

/**
 * Call the CLI edge function with a command and params.
 *
 * @param command  Dotted command name, e.g. "classes.list"
 * @param params   Command-specific parameters
 * @returns        The response data from the edge function
 */
export async function callCLI(
  command: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  const { token, apiUrl } = requireToken();

  if (!apiUrl) {
    throw new CLIError(
      "API URL not configured. Run 'pawtograder login --token <token> --url <url>' or set PAWTOGRADER_API_URL."
    );
  }

  const url = `${apiUrl}/functions/v1/cli`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ command, params })
  });

  let body: CLIResponse;
  try {
    body = await res.json();
  } catch {
    throw new CLIError(`Server returned non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || body.error) {
    const msg = body.error || `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new CLIError(`Authentication failed: ${msg}\nRun 'pawtograder login' to re-authenticate.`);
    }
    if (res.status === 403) {
      throw new CLIError(`Permission denied: ${msg}\nYour token may not have the required CLI scopes.`);
    }
    throw new CLIError(msg);
  }

  return body.data;
}
