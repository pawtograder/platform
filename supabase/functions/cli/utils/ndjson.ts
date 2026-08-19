/**
 * NDJSON streaming response builder.
 *
 * Streaming commands (assessment.export) need to write thousands of small JSON
 * records to the HTTP response without buffering them all in memory. This
 * helper wraps a TransformStream so handlers can call writer.write({...}) to
 * append a JSON line and get backpressure for free via the underlying stream.
 *
 * Each write produces exactly one line: a JSON object terminated by `\n`.
 * The CLI consumes the response line-by-line and demultiplexes by the `kind`
 * discriminator in each record.
 */

import * as Sentry from "npm:@sentry/deno@10.10.0";
import { CLICommandError } from "../errors.ts";
import { corsHeaders } from "./supabase.ts";

export interface NdjsonWriter {
  write(record: Record<string, unknown>): Promise<void>;
  /** Close the stream. After this, no more writes are allowed. */
  close(): Promise<void>;
  /**
   * Abort the stream with an error. The CLI will see a truncated stream and
   * surface the error message; do this when you must fail mid-stream after
   * headers have already been flushed.
   */
  abort(reason: string): Promise<void>;
}

/**
 * Build an NDJSON streaming Response. The handler is invoked with a writer;
 * any error it throws is written as a final {kind:"error", message} line and
 * the stream is closed. Headers are flushed before handler execution begins,
 * so callers must do auth/permission checks BEFORE calling streamNdjson.
 */
export function streamNdjson(handler: (writer: NdjsonWriter) => Promise<void>): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writable = stream.writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const writer: NdjsonWriter = {
    async write(record) {
      if (closed) throw new Error("ndjson writer is already closed");
      const line = JSON.stringify(record) + "\n";
      await writable.write(encoder.encode(line));
    },
    async close() {
      if (closed) return;
      closed = true;
      await writable.close();
    },
    async abort(reason) {
      if (closed) return;
      try {
        const line = JSON.stringify({ kind: "error", message: reason }) + "\n";
        await writable.write(encoder.encode(line));
      } finally {
        closed = true;
        await writable.close().catch(() => {});
      }
    }
  };

  // Run the handler asynchronously; do not await, so the Response is returned
  // (with headers flushed) while the body is still being filled. Both abort
  // and close can reject if the consumer disconnected mid-stream — swallow
  // those so a broken pipe doesn't surface as an unhandled rejection in the
  // edge runtime (broken pipe is exactly when we most want a quiet death).
  (async () => {
    try {
      try {
        await handler(writer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The Response left before the handler ran, so cli/index.ts's catch can
        // never see this: without reporting here, every server fault inside a
        // streaming export (statement timeouts on large courses, storage errors)
        // is an HTTP 200 with an error line in the body and nothing in Sentry.
        // Client errors thrown before the stream opened are still handled by the
        // dispatcher; anything reaching here is mid-stream and ours.
        if (!(err instanceof CLICommandError) || err.status >= 500) {
          Sentry.captureException(err, { tags: { endpoint: "cli", phase: "ndjson_stream" } });
        }
        await writer.abort(message).catch(() => {});
        return;
      }
      await writer.close().catch(() => {});
    } finally {
      // The Response left before any of this ran, so the flush that
      // serveWithSentryFlush does on the request has already happened. This is
      // the only point at which a mid-stream capture above can still be
      // delivered before the per_request isolate is torn down.
      await Sentry.flush(2000);
    }
  })();

  return new Response(stream.readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
