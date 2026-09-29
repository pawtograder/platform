/**
 * @jest-environment node
 *
 * F3 and F4 (spec §7.3): the /api/tunnel route handler against a real HTTP stub upstream.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tunnel/route";
import { serializeEnvelope } from "@/lib/bugReport/envelope";

type Received = {
  url: string;
  contentType: string | undefined;
  forwardedFor: string | string[] | undefined;
  body: Buffer;
};

let server: Server;
let port: number;
let received: Received[] = [];
let upstreamStatus = 200;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    received.push({
      url: req.url ?? "",
      contentType: req.headers["content-type"],
      forwardedFor: req.headers["x-forwarded-for"],
      body: await readBody(req)
    });
    res.writeHead(upstreamStatus, { "content-type": "application/json", "retry-after": "7" });
    res.end('{"id":"stub"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const savedEnv = { ...process.env };
beforeEach(() => {
  received = [];
  upstreamStatus = 200;
  process.env.NEXT_PUBLIC_SENTRY_DSN = `http://publickey@127.0.0.1:${port}/42`;
  delete process.env.NEXT_PUBLIC_BUGSINK_DSN;
  // Only the pre-rewrite tunnel read this. Setting it lets the same test run against that
  // implementation to show F3 failing there.
  process.env.NEXT_PUBLIC_BUGSINK_HOST = `http://127.0.0.1:${port}`;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function tunnelRequest(body: Uint8Array | string) {
  return new NextRequest("http://localhost:3001/api/tunnel", {
    method: "POST",
    body: body as BodyInit,
    headers: { "content-type": "text/plain;charset=UTF-8" }
  });
}

function envelopeFor(dsn: string, payload: Uint8Array) {
  return serializeEnvelope({ event_id: "0123456789abcdef0123456789abcdef", dsn, sent_at: new Date().toISOString() }, [
    { header: { type: "replay_event" }, payload: '{"replay_id":"0123456789abcdef0123456789abcdef"}' },
    { header: { type: "replay_recording" }, payload }
  ]);
}

describe("F3: binary envelopes pass through byte for byte", () => {
  it.each([1, 2, 3])("random payload %#", async () => {
    // Random bytes are almost never valid UTF-8, which is what a text() round trip destroys.
    const payload = new Uint8Array([...new TextEncoder().encode('{"segment_id":0}\n'), ...randomBytes(64 * 1024)]);
    const envelope = envelopeFor(`http://publickey@127.0.0.1:${port}/42`, payload);

    const res = await POST(tunnelRequest(envelope));

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/api/42/envelope/");
    expect(received[0].contentType).toBe("application/x-sentry-envelope");
    expect(received[0].body.length).toBe(envelope.length);
    expect(Buffer.compare(received[0].body, Buffer.from(envelope))).toBe(0);
  });

  it("does not forward the user's IP (ADR 3)", async () => {
    const req = new NextRequest("http://localhost:3001/api/tunnel", {
      method: "POST",
      body: envelopeFor(`http://publickey@127.0.0.1:${port}/42`, randomBytes(16)) as BodyInit,
      headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" }
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(received[0].forwardedFor).toBeUndefined();
  });

  it("passes the upstream status and back-off headers through", async () => {
    upstreamStatus = 429;
    const res = await POST(tunnelRequest(envelopeFor(`http://publickey@127.0.0.1:${port}/42`, randomBytes(16))));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("falls back to NEXT_PUBLIC_BUGSINK_DSN with a warning", async () => {
    process.env.NEXT_PUBLIC_BUGSINK_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(tunnelRequest(envelopeFor(`http://publickey@127.0.0.1:${port}/42`, randomBytes(16))));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_BUGSINK_DSN is deprecated"));
    warn.mockRestore();
  });
});

describe("F4: envelopes for another host or project are refused", () => {
  it.each([
    ["another host", "http://publickey@evil.example.com/42"],
    ["another port", "http://publickey@127.0.0.1:1/42"],
    ["another project", `http://publickey@127.0.0.1:PORT/43`],
    ["a path prefix", `http://publickey@127.0.0.1:PORT/prefix/42`]
  ])("%s gets 403 and is not forwarded", async (_label, dsn) => {
    const res = await POST(tunnelRequest(envelopeFor(dsn.replace("PORT", String(port)), randomBytes(16))));
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses everything when no DSN is configured", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const res = await POST(tunnelRequest(envelopeFor(`http://publickey@127.0.0.1:${port}/42`, randomBytes(16))));
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it.each([
    ["an empty body", ""],
    ["a non-JSON header", "garbage\n{}"],
    ["a header without a DSN", '{"event_id":"x"}\n'],
    ["a DSN that is not a URL", '{"dsn":"not a url"}\n'],
    ["a DSN key the SDK would reject", '{"dsn":"http://bad-key@127.0.0.1:1/42"}\n']
  ])("%s gets 400 and is not forwarded", async (_label, body) => {
    const res = await POST(tunnelRequest(body));
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});
