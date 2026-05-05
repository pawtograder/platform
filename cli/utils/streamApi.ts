/* eslint-disable no-console */
/**
 * Streaming NDJSON consumer for CLI commands.
 *
 * Mirrors apiCall() but reads the response body as a stream and yields one
 * parsed JSON record per line. Used by assessment export, which can be
 * hundreds of MB of fact rows that we never want to buffer in memory.
 *
 * Errors mid-stream surface as records of the form {kind: "error", message}
 * — the server writes one before closing if a handler throws after headers
 * have already been flushed.
 */

import { requireCredentials } from "./api";
import { CLIError } from "./logger";

export interface StreamCallOptions {
  command: string;
  params: Record<string, unknown>;
}

export async function* streamApiCall(opts: StreamCallOptions): AsyncGenerator<Record<string, unknown>, void, void> {
  const creds = requireCredentials();
  const verbose = !!process.env.DEBUG || process.env.PAWTOGRADER_VERBOSE === "1";

  if (verbose) {
    console.error(`[cli] STREAM POST ${creds.api_url} command=${opts.command}`);
  }

  const response = await fetch(creds.api_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      Accept: "application/x-ndjson"
    },
    body: JSON.stringify({ command: opts.command, params: opts.params })
  });

  if (!response.ok) {
    // Non-2xx responses are JSON errors built before the stream opened. Read
    // the full body (it's small) and surface a useful message.
    const body = await response.text();
    let parsed: { error?: string } = {};
    try {
      parsed = body ? (JSON.parse(body) as { error?: string }) : {};
    } catch {
      // not json — fall through with raw body in error
    }
    const errorMsg = parsed.error || `HTTP ${response.status}: ${body.slice(0, 200)}`;
    if (response.status === 401) {
      throw new CLIError(`Authentication failed: ${errorMsg}\n   Run 'pawtograder login' to re-authenticate.`);
    }
    if (response.status === 403) {
      throw new CLIError(`Permission denied: ${errorMsg}`);
    }
    throw new CLIError(`API error: ${errorMsg}`);
  }

  if (!response.body) {
    throw new CLIError("Server did not return a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process all complete lines in the buffer; the last (possibly partial)
    // line stays in the buffer for the next chunk.
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CLIError(`Invalid NDJSON line from server: ${msg}\n   line: ${line.slice(0, 200)}`);
      }
      if (record.kind === "error") {
        throw new CLIError(`Server error mid-stream: ${String(record.message ?? "(no message)")}`);
      }
      yield record;
    }
  }

  // Flush any final non-newline-terminated record (servers shouldn't send
  // these, but defend against it).
  const tail = buffer.trim();
  if (tail.length > 0) {
    try {
      const record = JSON.parse(tail) as Record<string, unknown>;
      if (record.kind === "error") {
        throw new CLIError(`Server error mid-stream: ${String(record.message ?? "(no message)")}`);
      }
      yield record;
    } catch {
      // ignore truncated trailing junk
    }
  }
}
