import { NextRequest, NextResponse } from "next/server";
import { parseEnvelopeHeader } from "@/lib/bugReport/envelope";
import { configuredSentryDsn, envelopeEndpoint, parseDsn } from "@/lib/bugReport/sentryDsn";

/**
 * Forwards browser Sentry envelopes to the Sentry project named by NEXT_PUBLIC_SENTRY_DSN.
 *
 * The body is handled as bytes from start to finish. Replay recordings are zlib-compressed binary
 * inside the envelope, and reading the body as text would replace every invalid UTF-8 sequence
 * with U+FFFD and corrupt them.
 *
 * Only the envelope header (the bytes up to the first `\n`) is parsed, to check that its DSN
 * names the configured host and project. Anything else gets 403 and is not forwarded, so the
 * route can't be used to relay traffic to an arbitrary host.
 *
 * Bodies over MAX_TUNNEL_BODY_BYTES get 413. The limit is enforced while reading, so a missing or
 * understated Content-Length can't make the route buffer more.
 */

/** Well above a real envelope: the bug reporter keeps each replay segment under 1 MiB compressed. */
const MAX_TUNNEL_BODY_BYTES = 10 * 1024 * 1024;

function tooLarge() {
  return new NextResponse("Payload Too Large", { status: 413 });
}

/** The body's bytes, or null as soon as more than `limit` bytes have arrived. */
async function readBodyCapped(request: NextRequest, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: NextRequest) {
  const target = parseDsn(configuredSentryDsn());
  if (!target) {
    // No configured project means there is nothing this route may forward to.
    return new NextResponse("Forbidden: error reporting is not configured", { status: 403 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TUNNEL_BODY_BYTES) return tooLarge();

  let body: Uint8Array;
  try {
    const read = await readBodyCapped(request, MAX_TUNNEL_BODY_BYTES);
    if (read === null) return tooLarge();
    body = read;
  } catch (error) {
    // eslint-disable-next-line no-console -- operational visibility
    console.error("Tunnel error reading body:", error);
    return new NextResponse("Bad Request: unreadable body", { status: 400 });
  }
  if (body.length === 0) {
    return new NextResponse("Bad Request: invalid envelope format", { status: 400 });
  }

  let envelopeDsn;
  try {
    const header = parseEnvelopeHeader(body);
    if (typeof header.dsn !== "string") {
      throw new Error("Missing DSN in envelope header");
    }
    envelopeDsn = parseDsn(header.dsn);
    if (!envelopeDsn) {
      throw new Error("Invalid DSN in envelope header");
    }
  } catch (parseError) {
    return new NextResponse(
      `Bad Request: invalid envelope header: ${parseError instanceof Error ? parseError.message : "unknown error"}`,
      { status: 400 }
    );
  }

  if (
    envelopeDsn.host !== target.host ||
    envelopeDsn.projectId !== target.projectId ||
    envelopeDsn.pathPrefix !== target.pathPrefix
  ) {
    return new NextResponse("Forbidden: envelope is not for this project", { status: 403 });
  }

  try {
    const response = await fetch(envelopeEndpoint(target), {
      method: "POST",
      body: body as BodyInit,
      headers: {
        // No X-Forwarded-For: Sentry would store the user's IP, and events identify users by
        // Pawtograder ID and role only (bug reporter ADR 3).
        "Content-Type": "application/x-sentry-envelope"
      }
    });

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "text/plain",
        // Sentry's transport reads these to back off; pass them through.
        ...(response.headers.get("retry-after") ? { "Retry-After": response.headers.get("retry-after")! } : {}),
        ...(response.headers.get("x-sentry-rate-limits")
          ? { "X-Sentry-Rate-Limits": response.headers.get("x-sentry-rate-limits")! }
          : {})
      }
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- operational visibility
    console.error("Tunnel error:", error);
    return new NextResponse("Bad Gateway", { status: 502 });
  }
}
