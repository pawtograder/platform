/**
 * Classification of Gemini failures by the real provider (#1077).
 *
 * The provider is pointed (EXAM_GEMINI_BASE_URL) at a raw TCP stand-in on localhost, so these go
 * through the real fetch and GeminiVision.generate: an actual 503, 429 and 400, an actual dropped
 * connection, and actual malformed/valid bodies. Only the 60s timeout is simulated, by a fetch that
 * rejects the way AbortSignal.timeout does. The worker-side behaviour (retry, no premature
 * finalization) is covered end to end by tests/e2e/exam-provider-faults.spec.ts.
 *
 * Run from supabase/functions:  deno test --no-check --allow-net --allow-env _shared/examVision.provider.test.ts
 */
import { assert, assertEquals, assertInstanceOf, assertRejects } from "jsr:@std/assert@^1";
import { getExamVisionProvider, ProviderRateLimitError, ProviderTransientError } from "./examVision.ts";

const DUMMY_KEY = "dummy-gemini-key-must-not-leak";
const PAGE = { name: "page-1.png", bytes: new Uint8Array([137, 80, 78, 71]), width: 10, height: 10 };
const REGION = { x: 0, y: 0, width: 1, height: 1 };

type Mode = "503" | "503-echo" | "429" | "400-echo" | "redirect" | "drop" | "truncated" | "malformed" | "ok";

function geminiBody(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

/** A one-connection-at-a-time HTTP stand-in that can also drop the connection without replying. */
function startStandIn() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const state = { mode: "ok" as Mode, requestHeads: [] as string[], redirectTo: "" };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const respond = (status: number, reason: string, body: string) =>
    encoder.encode(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${encoder.encode(body).length}\r\nConnection: close\r\n\r\n${body}`
    );
  const serving = (async () => {
    for await (const conn of listener) {
      // Read the full request (headers + Content-Length body) before answering or dropping it.
      let raw = "";
      const buf = new Uint8Array(65536);
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        raw += decoder.decode(buf.subarray(0, n));
        const headEnd = raw.indexOf("\r\n\r\n");
        if (headEnd >= 0) {
          const length = Number(/content-length:\s*(\d+)/i.exec(raw.slice(0, headEnd))?.[1] ?? 0);
          if (encoder.encode(raw.slice(headEnd + 4)).length >= length) break;
        }
      }
      state.requestHeads.push(raw.slice(0, raw.indexOf("\r\n\r\n")));
      try {
        if (state.mode === "503") await conn.write(respond(503, "Service Unavailable", '{"error":"overloaded"}'));
        if (state.mode === "503-echo") {
          // A misbehaving upstream or proxy that reflects request material into its error page.
          await conn.write(
            respond(503, "Service Unavailable", JSON.stringify({ error: "overloaded", echo: DUMMY_KEY }))
          );
        }
        if (state.mode === "429") await conn.write(respond(429, "Too Many Requests", '{"error":"quota"}'));
        if (state.mode === "400-echo") {
          // A permanent error page can reflect request material just as a 5xx one can.
          await conn.write(respond(400, "Bad Request", JSON.stringify({ error: "bad", echo: DUMMY_KEY })));
        }
        if (state.mode === "redirect") {
          await conn.write(
            encoder.encode(
              `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${state.redirectTo}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
            )
          );
        }
        if (state.mode === "malformed") await conn.write(respond(200, "OK", geminiBody("this is not json")));
        if (state.mode === "ok") await conn.write(respond(200, "OK", geminiBody('{"value": 42, "text": "42"}')));
        if (state.mode === "truncated") {
          // Headers promise a body, then the connection drops part-way through it.
          await conn.write(
            encoder.encode('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"candi')
          );
        }
      } finally {
        conn.close(); // "drop" closes having written nothing
      }
    }
  })();
  return {
    state,
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    async close() {
      listener.close();
      await serving.catch(() => {});
    }
  };
}

Deno.test("Gemini failures are classified by the real provider", async (t) => {
  const standIn = startStandIn();
  Deno.env.set("EXAM_VISION_PROVIDER", "gemini");
  Deno.env.set("GOOGLE_API_KEY", DUMMY_KEY);
  Deno.env.set("EXAM_GEMINI_BASE_URL", standIn.url);
  Deno.env.set("EXAM_GEMINI_RPM", "0");
  const provider = getExamVisionProvider();
  const structure = () => provider.structureAnswer("numeric", PAGE, REGION, "42");
  // Never interpolate the message into an assertion: if it leaked, the failure output would too.
  const assertNoKey = (err: Error) => {
    assert(!err.message.includes(DUMMY_KEY), "error message contains the credential");
    assert(!/https?:\/\//.test(err.message), "error message contains a URL");
  };
  // Retryable failures carry only provider, category and status, never response or transport text.
  const assertDiagnostic = (err: Error, category: string, status?: number) => {
    assertNoKey(err);
    const e = err as ProviderTransientError;
    assertEquals([e.provider, e.category, e.status], ["gemini", category, status]);
    const expected = `gemini request failed: category=${category}${status === undefined ? "" : ` status=${status}`}`;
    assert(err.message === expected, "error message is not the bounded diagnostic");
  };

  try {
    await t.step("503 -> ProviderTransientError", async () => {
      standIn.state.mode = "503";
      const err = await assertRejects(structure, ProviderTransientError);
      assertDiagnostic(err, "server_error", 503);
    });

    await t.step("a 503 body echoing the credential is not carried into the error", async () => {
      standIn.state.mode = "503-echo";
      const err = await assertRejects(structure, ProviderTransientError);
      assertDiagnostic(err, "server_error", 503);
    });

    await t.step("a transport error message echoing the credential is not carried into the error", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.reject(new TypeError(`connection reset by peer (request carried x-goog-api-key: ${DUMMY_KEY})`));
      try {
        const err = await assertRejects(structure, ProviderTransientError);
        assertDiagnostic(err, "network");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    await t.step("dropped connection -> ProviderTransientError without the URL", async () => {
      standIn.state.mode = "drop";
      const err = await assertRejects(structure, ProviderTransientError);
      assertDiagnostic(err, "network");
    });

    await t.step("timeout -> ProviderTransientError", async () => {
      // Simulated: the real signal is 60s. This is the rejection AbortSignal.timeout produces.
      const realFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new DOMException("Signal timed out.", "TimeoutError"));
      try {
        const err = await assertRejects(structure, ProviderTransientError);
        assertDiagnostic(err, "timeout");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    await t.step("connection dropped while reading the body -> ProviderTransientError", async () => {
      standIn.state.mode = "truncated";
      const err = await assertRejects(structure, ProviderTransientError);
      assertDiagnostic(err, "network");
    });

    await t.step("timeout while reading the body -> ProviderTransientError", async () => {
      // Headers arrived, then the 60s signal fired mid-body: the body stream errors with it.
      const realFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new DOMException("Signal timed out.", "TimeoutError"));
              }
            }),
            { status: 200 }
          )
        );
      try {
        const err = await assertRejects(structure, ProviderTransientError);
        assertDiagnostic(err, "timeout");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    await t.step("an error that is not a transport failure is not made retryable", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new RangeError("programming error"));
      try {
        const err = await assertRejects(structure, RangeError);
        assert(!(err instanceof ProviderTransientError));
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    await t.step("429 -> ProviderRateLimitError (unchanged)", async () => {
      standIn.state.mode = "429";
      const err = await assertRejects(structure, ProviderRateLimitError);
      assertNoKey(err);
    });

    await t.step(
      "other 4xx stays a plain Error, and a body echoing the credential is not carried into it",
      async () => {
        standIn.state.mode = "400-echo";
        const err = await assertRejects(structure, Error);
        assert(!(err instanceof ProviderTransientError) && !(err instanceof ProviderRateLimitError));
        assertNoKey(err);
        assert(err.message === "Gemini failed: 400", "error message is not the bounded diagnostic");
      }
    );

    await t.step("a redirect is not followed, so the key is not resent to where it points", async () => {
      // A second local server stands in for wherever an allowed endpoint might redirect to.
      const target = startStandIn();
      try {
        standIn.state.redirectTo = `${target.url}/v1beta/models/elsewhere:generateContent`;
        standIn.state.mode = "redirect";
        let err: unknown = null;
        try {
          await structure();
        } catch (e) {
          err = e;
        }
        const reached = target.state.requestHeads;
        const keyResent = reached.some((head) => head.includes(DUMMY_KEY));
        assert(
          reached.length === 0,
          `the redirect was followed: the target received ${reached.length} request(s), key resent: ${keyResent}`
        );
        assertInstanceOf(err, ProviderTransientError);
        assertDiagnostic(err, "network");
      } finally {
        await target.close();
      }
    });

    await t.step("malformed model output -> raw OCR text fallback (unchanged)", async () => {
      standIn.state.mode = "malformed";
      assertEquals(await structure(), { value: "42", text: "42" });
    });

    await t.step("valid model output -> typed value (unchanged)", async () => {
      standIn.state.mode = "ok";
      const result = await structure();
      assertEquals(result.value, 42);
    });

    await t.step("the key travels in the header, never in the request line", () => {
      const heads = standIn.state.requestHeads;
      assert(heads.length > 0);
      for (const head of heads) {
        const [requestLine, ...headers] = head.split("\r\n");
        assert(!requestLine.includes(DUMMY_KEY), "request line contains the credential");
        const header = headers.find((h) => h.toLowerCase().startsWith("x-goog-api-key:"));
        assert(header?.split(":")[1].trim() === DUMMY_KEY, "x-goog-api-key header does not carry the credential");
      }
    });
  } finally {
    await standIn.close();
  }
});

Deno.test("ProviderTransientError is an Error with its own name", () => {
  const err = new ProviderTransientError("gemini", "server_error", 502);
  assertInstanceOf(err, Error);
  assertEquals(err.name, "ProviderTransientError");
  assertEquals(err.message, "gemini request failed: category=server_error status=502");
});

Deno.test("EXAM_GEMINI_BASE_URL can only name a local test server", async (t) => {
  const names = [
    "EXAM_VISION_PROVIDER",
    "GOOGLE_API_KEY",
    "EXAM_GEMINI_BASE_URL",
    "EXAM_GEMINI_RPM",
    "EXAM_GEMINI_MODEL"
  ] as const;
  const saved = names.map((name) => [name, Deno.env.get(name)] as const);
  const realFetch = globalThis.fetch;
  const sent: Request[] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(input instanceof Request ? input : new Request(input, init));
    return Promise.resolve(new Response(geminiBody('{"value": 42, "text": "42"}'), { status: 200 }));
  };
  Deno.env.set("EXAM_VISION_PROVIDER", "gemini");
  Deno.env.set("GOOGLE_API_KEY", DUMMY_KEY);
  Deno.env.set("EXAM_GEMINI_RPM", "0");
  Deno.env.set("EXAM_GEMINI_MODEL", "test-model");
  // getExamVisionProvider caches its provider per module instance, so each case loads a fresh one.
  let instance = 0;
  const providerFor = async (baseUrl: string | undefined) => {
    if (baseUrl === undefined) Deno.env.delete("EXAM_GEMINI_BASE_URL");
    else Deno.env.set("EXAM_GEMINI_BASE_URL", baseUrl);
    const mod: typeof import("./examVision.ts") = await import(`./examVision.ts?base-url-case=${++instance}`);
    return () => mod.getExamVisionProvider();
  };
  const REJECTED = "EXAM_GEMINI_BASE_URL may only point at a local test server";
  const GOOGLE = "https://generativelanguage.googleapis.com";

  try {
    // [configured value, origin the request must go to]
    const allowed: [string | undefined, string][] = [
      [undefined, GOOGLE],
      ["", GOOGLE],
      ["   ", GOOGLE],
      ["http://127.0.0.1:58080", "http://127.0.0.1:58080"],
      ["http://localhost:58080/", "http://localhost:58080"],
      ["http://host.docker.internal:58080", "http://host.docker.internal:58080"],
      ["http://[::1]:58080", "http://[::1]:58080"],
      ["HTTPS://LOCALHOST:8443", "https://localhost:8443"],
      // Spellings the URL parser normalizes to an allowed host. Accepted, and the request goes to
      // that normalized host, because it is built from the parsed origin rather than the string.
      ["http://\uFF4C\uFF4F\uFF43\uFF41\uFF4C\uFF48\uFF4F\uFF53\uFF54:58080", "http://localhost:58080"],
      ["http://%6c%6f%63%61%6c%68%6f%73%74:58080", "http://localhost:58080"],
      ["http://0x7f.1:58080", "http://127.0.0.1:58080"],
      ["http://2130706433:58080", "http://127.0.0.1:58080"],
      ["http://local\thost:58080", "http://localhost:58080"],
      ["http://local\nhost:58080", "http://localhost:58080"]
    ];
    for (const [value, origin] of allowed) {
      await t.step(`${JSON.stringify(value)} -> requests ${origin}`, async () => {
        sent.length = 0;
        const provider = (await providerFor(value))();
        await provider.structureAnswer("numeric", PAGE, REGION, "42");
        assertEquals(sent.length, 1);
        const url = new URL(sent[0].url);
        assertEquals(url.origin, origin);
        assertEquals(url.pathname, "/v1beta/models/test-model:generateContent");
        assertEquals(sent[0].redirect, "error");
        assert(sent[0].headers.get("x-goog-api-key") === DUMMY_KEY, "request does not carry the key header");
      });
    }

    const rejected = [
      "https://attacker.example",
      "http://localhost.attacker.example:58080",
      "http://localhost@attacker.example",
      "http://127.0.0.1.nip.io:58080",
      "http://169.254.169.254",
      "ftp://localhost:58080",
      "file:///etc/hosts",
      "localhost:58080",
      "not a url",
      "http://localhost:58080/proxy",
      "http://localhost:58080/?x=1",
      "http://localhost:58080/#x",
      "http://user:pw@localhost:58080",
      // Bypass attempts: each parses to a host or shape outside the allowlist.
      "http://localhost:58080\\@attacker.example",
      "http://attacker.example#@localhost",
      "http://attacker.example?@localhost",
      "http://localhost.:58080",
      "http://[::ffff:127.0.0.1]:58080"
    ];
    for (const value of rejected) {
      await t.step(`${JSON.stringify(value)} is rejected before any request`, async () => {
        sent.length = 0;
        const get = await providerFor(value);
        let err: unknown = null;
        try {
          await get().structureAnswer("numeric", PAGE, REGION, "42");
        } catch (e) {
          err = e;
        }
        assertEquals(sent.length, 0, "a request was sent");
        assertInstanceOf(err, Error);
        assert(err.message.startsWith(REJECTED), "not the base-URL rejection");
        assert(!err.message.includes(value) && !err.message.includes(DUMMY_KEY), "message echoes the value");
      });
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
