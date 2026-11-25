/**
 * Classification of Gemini failures by the real provider (#1077).
 *
 * The provider is pointed (EXAM_GEMINI_BASE_URL) at a raw TCP stand-in on localhost, so these go
 * through the real fetch and GeminiVision.generate: an actual 503, 429 and 400, an actual dropped
 * connection, and actual malformed/valid bodies. Only the 60s timeout is simulated, by a fetch that
 * rejects the way AbortSignal.timeout does. That the worker retries a ProviderTransientError
 * instead of finalizing with the raw OCR text is covered by
 * tests/e2e/exam-finalize-provider-retry.spec.ts, through the fake provider.
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
  const state = { mode: "ok" as Mode, requestHeads: [] as string[], redirectTo: "", truncatedStatus: 200 };
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
            encoder.encode(
              `HTTP/1.1 ${state.truncatedStatus} Status\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"candi`
            )
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

    // An error status is classified by the status alone, even when its body then fails to arrive:
    // no error message carries the body, so a reset or timeout while reading it must not turn a
    // permanent 400 or a 429 into a generic transient failure.
    const bodyDrops = async (status: number, check: () => Promise<void>) => {
      standIn.state.mode = "truncated";
      standIn.state.truncatedStatus = status;
      try {
        await check();
      } finally {
        standIn.state.truncatedStatus = 200;
      }
    };
    const bodyTimesOut = async (status: number, check: () => Promise<void>) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new DOMException("Signal timed out.", "TimeoutError"));
              }
            }),
            { status }
          )
        );
      try {
        await check();
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    for (const [failure, withFailingBody] of [
      ["drops", bodyDrops],
      ["times out", bodyTimesOut]
    ] as const) {
      await t.step(`a 400 whose body ${failure} stays a plain Error`, () =>
        withFailingBody(400, async () => {
          const err = await assertRejects(structure, Error);
          assert(!(err instanceof ProviderTransientError), "a 400 was made retryable");
          assert(!(err instanceof ProviderRateLimitError), "a 400 was made a rate limit");
          assertNoKey(err);
          assert(err.message === "Gemini failed: 400", "error message is not the bounded diagnostic");
        })
      );
      await t.step(`a 429 whose body ${failure} stays a ProviderRateLimitError`, () =>
        withFailingBody(429, async () => {
          const err = await assertRejects(structure, ProviderRateLimitError);
          assertNoKey(err);
        })
      );
    }

    await t.step("a 503 whose body drops is still a server error with its status", () =>
      bodyDrops(503, async () => {
        const err = await assertRejects(structure, ProviderTransientError);
        assertDiagnostic(err, "server_error", 503);
      })
    );

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

Deno.test("Auto-extract sends a long template in groups of pages and merges the answers (#1369)", async (t) => {
  const names = ["EXAM_VISION_PROVIDER", "GOOGLE_API_KEY", "EXAM_GEMINI_BASE_URL", "EXAM_GEMINI_RPM"] as const;
  const saved = names.map((name) => [name, Deno.env.get(name)] as const);
  const realFetch = globalThis.fetch;
  Deno.env.set("EXAM_VISION_PROVIDER", "gemini");
  Deno.env.set("GOOGLE_API_KEY", DUMMY_KEY);
  Deno.env.set("EXAM_GEMINI_RPM", "0");
  Deno.env.delete("EXAM_GEMINI_BASE_URL");

  type Tree = { questions: Record<string, unknown>[]; regions: Record<string, unknown>[] };
  const q = (client_id: string, label: string, ordinal: number, parent_client_id: string | null = null) => ({
    client_id,
    parent_client_id,
    level: parent_client_id === null ? 1 : 2,
    ordinal,
    label
  });
  const region = (question_client_id: string | null, page_number: number, kind = "answer") => ({
    question_client_id,
    kind,
    page_number,
    x: 0.1,
    y: 0.1,
    width: 0.5,
    height: 0.1
  });

  // Page n's image is the single byte n, so the stand-in can tell which pages a request carries.
  // answer() gets those page numbers and returns Gemini's proposal for them, a string for the
  // model's raw text, or an error to throw from fetch. getExamVisionProvider caches its provider, so
  // each case loads a fresh module.
  let instance = 0;
  const extract = async (pageCount: number, answer: (pages: number[]) => Tree | string | Error) => {
    const requests: number[][] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await (input instanceof Request ? input : new Request(input, init)).json();
      const pages = (body.contents[0].parts as { inline_data?: { data: string } }[])
        .filter((p) => p.inline_data)
        .map((p) => atob(p.inline_data!.data).charCodeAt(0));
      requests.push(pages);
      const reply = answer(pages);
      if (reply instanceof Error) throw reply;
      return new Response(geminiBody(typeof reply === "string" ? reply : JSON.stringify(reply)), { status: 200 });
    };
    const mod: typeof import("./examVision.ts") = await import(`./examVision.ts?extract-case=${++instance}`);
    const images = Array.from({ length: pageCount }, (_, i) => ({
      name: `page-${i + 1}.png`,
      bytes: new Uint8Array([i + 1]),
      width: 10,
      height: 10
    }));
    return { run: () => mod.getExamVisionProvider().extractTemplate(images), requests, mod };
  };

  try {
    await t.step("a 5-page template is sent as requests of 2, 2 and 1 pages", async () => {
      const { run, requests } = await extract(5, () => ({ questions: [], regions: [] }));
      await run();
      assertEquals(
        requests.sort((a, b) => a[0] - b[0]),
        [[1, 2], [3, 4], [5]]
      );
    });

    await t.step("a region on a later group's page lands on that page of the whole template", async () => {
      // Each group answers with page numbers counted from 1 within the request. Page 3 of a
      // 2-page request doesn't exist, so it is dropped rather than shifted onto someone else's page.
      const { run } = await extract(4, (pages) => ({
        questions: [q("q1", `Problem ${pages[0]}`, 1)],
        regions: [region("q1", 1), region("q1", 2), region("q1", 3)]
      }));
      const tree = await run();
      assertEquals(
        tree.regions.map((r) => r.page_number),
        [1, 2, 3, 4]
      );
    });

    await t.step("two groups that both say q1 stay two questions, each with its own parts", async () => {
      const { run } = await extract(4, (pages) => ({
        questions: [q("q1", `Problem ${pages[0]}`, 1), q("q1a", "(a)", 1, "q1")],
        regions: [region("q1a", 1)]
      }));
      const tree = await run();
      const byId = new Map(tree.questions.map((x) => [x.client_id, x]));
      assertEquals(byId.size, 4, "client_ids collided");
      const tops = tree.questions.filter((x) => !x.parent_client_id);
      assertEquals(
        tops.map((x) => [x.label, x.ordinal]),
        [
          ["Problem 1", 1],
          ["Problem 3", 2]
        ]
      );
      // Each group's region is on that group's first page and must point at that group's (a).
      for (const r of tree.regions) {
        const part = byId.get(r.question_client_id!)!;
        assertEquals(part.label, "(a)");
        assertEquals(byId.get(part.parent_client_id!)!.label, `Problem ${r.page_number}`);
      }
    });

    await t.step("a problem that continues onto the next group's pages becomes one problem", async () => {
      const { run } = await extract(4, (pages) =>
        pages[0] === 1
          ? {
              questions: [
                q("p1", "Problem 1", 1),
                q("p1a", "(a)", 1, "p1"),
                q("p2", "Problem 2", 2),
                q("p2a", "(a)", 1, "p2"),
                q("p2b", "(b)", 2, "p2"),
                { ...q("p2b1", "call 1", 1, "p2b"), level: 3 }
              ],
              regions: [region("p2b1", 2)]
            }
          : {
              questions: [
                q("p2", "Problem 2 (continued)", 1),
                q("p2b", "(b)", 1, "p2"),
                { ...q("p2b2", "call 2", 1, "p2b"), level: 3 },
                q("p2c", "(c)", 2, "p2"),
                q("p3", "Problem 3", 2),
                q("p3a", "(a)", 1, "p3")
              ],
              regions: [region("p2b2", 1), region("p2c", 2)]
            }
      );
      const tree = await run();
      const byId = new Map(tree.questions.map((x) => [x.client_id, x]));
      const kids = (id: unknown) =>
        tree.questions
          .filter((x) => x.parent_client_id === id)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((x) => [x.label, x.ordinal]);
      const tops = tree.questions.filter((x) => !x.parent_client_id).sort((a, b) => a.ordinal - b.ordinal);
      assertEquals(
        tops.map((x) => [x.label, x.ordinal]),
        [
          ["Problem 1", 1],
          ["Problem 2", 2],
          ["Problem 3", 3]
        ]
      );
      assertEquals(kids(tops[1].client_id), [
        ["(a)", 1],
        ["(b)", 2],
        ["(c)", 3]
      ]);
      const partB = tree.questions.find((x) => x.parent_client_id === tops[1].client_id && x.label === "(b)")!;
      assertEquals(kids(partB.client_id), [
        ["call 1", 1],
        ["call 2", 2]
      ]);
      // Every region still points at a question that exists.
      for (const r of tree.regions) assert(byId.has(r.question_client_id!), "region points at a dropped question");
    });

    await t.step("a timeout on pages 3-4 names those pages and says to draw the regions by hand", async () => {
      const { run, mod } = await extract(6, (pages) =>
        pages.includes(3) ? new DOMException("Signal timed out.", "TimeoutError") : { questions: [], regions: [] }
      );
      const err = await assertRejects(run, mod.TemplateExtractError);
      assert(err.message.includes("pages 3–4"), "message doesn't name the failed pages");
      assert(!err.message.includes("1–2") && !err.message.includes("5–6"), "message names pages that worked");
      assert(/by hand/.test(err.message), "message doesn't say to draw the regions by hand");
      assert(!err.message.includes(DUMMY_KEY), "message contains the credential");
    });

    // A group whose answer can't be read must fail the import, not become an empty group that
    // leaves a gap in the middle of the exam. So must an answer whose questions or regions the merge
    // can't read: it would otherwise crash after the failed groups are collected, with no pages named.
    const unreadable: [string, string, string | null][] = [
      ["isn't JSON", "Here are the questions: {", "Here are the questions"],
      ["is {} because Gemini sent no text", "{}", null],
      ["has questions that aren't a list", '{"questions": "Q1", "regions": []}', "Q1"],
      ["is a list instead of an object", "[]", null],
      ["has a question that is null", '{"questions":[null],"regions":[]}', null],
      ["has a region that is null", '{"questions":[],"regions":[null]}', null],
      ["has a question whose label is a number", '{"questions":[{"client_id":"q1","label":7}],"regions":[]}', null],
      ["has a question with no client_id", '{"questions":[{"label":"Q1"}],"regions":[]}', "Q1"]
    ];
    for (const [what, text, distinctive] of unreadable) {
      await t.step(`an answer for pages 3-4 that ${what} fails the import and names those pages`, async () => {
        const { run, mod } = await extract(6, (pages) => (pages.includes(3) ? text : { questions: [], regions: [] }));
        const err = await assertRejects(run, mod.TemplateExtractError);
        assert(err.message.includes("pages 3–4"), "message doesn't name the failed pages");
        assert(!err.message.includes("1–2") && !err.message.includes("5–6"), "message names pages that worked");
        assert(err.message.includes("couldn't be read"), "message doesn't say the answer couldn't be read");
        if (distinctive) assert(!err.message.includes(distinctive), "message contains the model's answer");
      });
    }

    await t.step("a numeric client_id of 0 still works as a parent and as a region's question", async () => {
      // 0 is falsy, so a truthiness check on the reference made the part top-level and dropped the
      // region's question.
      const { run } = await extract(2, () => ({
        questions: [
          { client_id: 0, parent_client_id: null, level: 1, ordinal: 1, label: "Problem 1" },
          { client_id: 1, parent_client_id: 0, level: 2, ordinal: 1, label: "(a)" }
        ],
        regions: [{ ...region(null, 1), question_client_id: 0 }]
      }));
      const tree = await run();
      assertEquals(
        tree.questions.map((q) => [q.client_id, q.parent_client_id]),
        [
          ["g1:0", null],
          ["g1:1", "g1:0"]
        ]
      );
      assertEquals(tree.regions[0].question_client_id, "g1:0");
    });

    await t.step("only the first name and student ID regions are kept", async () => {
      // A name line in every page footer would otherwise give one name region per group, and the
      // worker reads whichever the database returns first.
      const { run } = await extract(4, () => ({
        questions: [],
        regions: [region(null, 1, "name"), region(null, 1, "student_id")]
      }));
      const tree = await run();
      assertEquals(
        tree.regions.map((r) => [r.kind, r.page_number]),
        [
          ["name", 1],
          ["student_id", 1]
        ]
      );
    });
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
