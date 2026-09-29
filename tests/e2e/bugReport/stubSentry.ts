import { createServer, type Server } from "node:http";
import { parseCapturedEnvelope, type CapturedEnvelope } from "./tunnel";

/**
 * A local stand-in for Sentry's ingest, for PR-tier tests that need the envelopes the SERVER
 * sends (the Next server and middleware post straight to the DSN host, not through
 * /api/tunnel, so `captureTunnel` never sees them).
 *
 * A build made with `NEXT_PUBLIC_SENTRY_DSN=STUB_SENTRY_DSN` reports here: the server SDK
 * directly, and the browser through /api/tunnel, which forwards to the DSN host. The stub answers
 * every envelope 200 and keeps it.
 */

/** Port and DSN a PR-tier build points at. CI's e2e-local build uses the same value. */
export const STUB_SENTRY_PORT = Number(process.env.BUG_REPORT_STUB_SENTRY_PORT ?? 54399);
export const STUB_SENTRY_PROJECT_ID = "1";
export const STUB_SENTRY_DSN = `http://e2epublickey@127.0.0.1:${STUB_SENTRY_PORT}/${STUB_SENTRY_PROJECT_ID}`;

export type StubSentry = {
  readonly dsn: string;
  /** Every envelope received, in arrival order */
  readonly envelopes: CapturedEnvelope[];
  waitForEnvelope(predicate: (e: CapturedEnvelope) => boolean, timeoutMs?: number): Promise<CapturedEnvelope>;
  close(): Promise<void>;
};

export async function startStubSentry(port = STUB_SENTRY_PORT): Promise<StubSentry> {
  const envelopes: CapturedEnvelope[] = [];
  const waiters: { predicate: (e: CapturedEnvelope) => boolean; resolve: (e: CapturedEnvelope) => void }[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && /^\/api\/\d+\/envelope\/?/.test(req.url ?? "")) {
        const envelope = parseCapturedEnvelope(new Uint8Array(Buffer.concat(chunks)), req.url ?? "");
        envelopes.push(envelope);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(envelope)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(envelope);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    dsn: `http://e2epublickey@127.0.0.1:${port}/${STUB_SENTRY_PROJECT_ID}`,
    envelopes,
    waitForEnvelope: (predicate, timeoutMs = 20_000) => {
      const existing = envelopes.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) {
            waiters.splice(i, 1);
            reject(
              new Error(`Stub Sentry got no matching envelope within ${timeoutMs} ms (${envelopes.length} received)`)
            );
          }
        }, timeoutMs);
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
