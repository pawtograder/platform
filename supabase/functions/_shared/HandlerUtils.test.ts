/**
 * Unit tests for the authorization-lookup guards.
 *
 * These encode the distinction the assertions used to lose: a role lookup that came back EMPTY is a
 * denial (401/403, and the negative-path e2e tests depend on it staying that way), while a role lookup
 * that FAILED is a 503. The PGRST116 case is the load-bearing one — `.single()` reports "no unique row"
 * as an error, so treating every error as a failure would turn every genuine denial into a 503.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env _shared/HandlerUtils.test.ts
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  assertAuthLookupSucceeded,
  assertRoleLookupSucceeded,
  IllegalArgumentError,
  NotFoundError,
  readJsonObjectBody,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "./HandlerUtils.ts";

Deno.test("assertRoleLookupSucceeded: no error passes", () => {
  assertRoleLookupSucceeded(null, "Role lookup");
});

Deno.test("assertRoleLookupSucceeded: PGRST116 passes so the caller can report the denial", () => {
  // `.single()` on zero rows. This must NOT become a 503 — it is the denial itself.
  assertRoleLookupSucceeded(
    { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
    "Enrollment lookup"
  );
});

Deno.test("assertRoleLookupSucceeded: a 502 from PostgREST raises a retryable 503", () => {
  const e = assertThrows(
    () =>
      assertRoleLookupSucceeded(
        { message: "An invalid response was received from the upstream server" },
        "Role lookup"
      ),
    UserVisibleError
  );
  assertEquals((e as UserVisibleError).status, 503);
  assertEquals(
    e.message,
    "Role lookup is temporarily unavailable: An invalid response was received from the upstream server"
  );
});

Deno.test("assertRoleLookupSucceeded: any other error code is also a failure, not a denial", () => {
  const e = assertThrows(
    () =>
      assertRoleLookupSucceeded(
        { code: "42P01", message: 'relation "public.user_roles" does not exist' },
        "Role lookup"
      ),
    UserVisibleError
  );
  assertEquals((e as UserVisibleError).status, 503);
});

Deno.test("assertAuthLookupSucceeded: no error passes", () => {
  assertAuthLookupSucceeded(null);
  assertAuthLookupSucceeded(undefined);
});

Deno.test("assertAuthLookupSucceeded: an explicit 4xx is a real statement about the token", () => {
  // Left to the caller, which raises SecurityError -> 401.
  assertAuthLookupSucceeded({ status: 401, message: "invalid JWT" });
  assertAuthLookupSucceeded({ status: 403, message: "bad_jwt" });
});

Deno.test("assertAuthLookupSucceeded: a 5xx from the auth server raises 503", () => {
  const e = assertThrows(() => assertAuthLookupSucceeded({ status: 502, message: "Bad Gateway" }), UserVisibleError);
  assertEquals((e as UserVisibleError).status, 503);
});

Deno.test("assertAuthLookupSucceeded: AuthRetryableFetchError's status 0 raises 503", () => {
  // @supabase/auth-js reports DNS/connection/CORS failures as AuthRetryableFetchError with `status: 0`.
  // A `< 500` test would have accepted that as a real answer and returned 401 — exactly the
  // misclassification this guard exists to prevent.
  const e = assertThrows(() => assertAuthLookupSucceeded({ status: 0, message: "Failed to fetch" }), UserVisibleError);
  assertEquals((e as UserVisibleError).status, 503);
});

Deno.test("assertAuthLookupSucceeded: a 3xx or 5xx is not a statement about the token", () => {
  for (const status of [301, 500, 502, 504]) {
    const e = assertThrows(() => assertAuthLookupSucceeded({ status, message: "upstream" }), UserVisibleError);
    assertEquals((e as UserVisibleError).status, 503);
  }
});

Deno.test("assertAuthLookupSucceeded: a transport failure with no status raises 503", () => {
  // AuthRetryableFetchError and friends: we never reached the auth server, so we know nothing.
  const e = assertThrows(() => assertAuthLookupSucceeded({ message: "error sending request" }), UserVisibleError);
  assertEquals((e as UserVisibleError).status, 503);
});

// --- wrapRequestHandler status ladder ---------------------------------------
//
// Every typed branch set a status, but the catch-all for unclassified throws did not, and
// `new Response(body)` defaults to 200. So a TypeError, an OOM, or anything else not one of our
// error types was reported to the caller as a SUCCESSFUL request carrying an error object.

function post(): Request {
  return new Request("https://example.test/fn", { method: "POST", body: "{}" });
}

Deno.test("wrapRequestHandler: an unclassified throw is a 500, not a 200", async () => {
  const res = await wrapRequestHandler(post(), () => {
    throw new Error("boom");
  });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.message, "Internal Server Error");
});

Deno.test("wrapRequestHandler: a non-Error throw is also a 500", async () => {
  const res = await wrapRequestHandler(post(), () => {
    throw "a bare string";
  });
  assertEquals(res.status, 500);
});

Deno.test("wrapRequestHandler: typed errors keep their own statuses", async () => {
  const cases: [Error, number][] = [
    [new SecurityError("nope"), 401],
    [new IllegalArgumentError("bad"), 400],
    [new NotFoundError("gone"), 404],
    [new UserVisibleError("explained"), 500]
  ];
  for (const [err, status] of cases) {
    const res = await wrapRequestHandler(post(), () => {
      throw err;
    });
    assertEquals(res.status, status, err.constructor.name);
  }
});

Deno.test("wrapRequestHandler: a successful handler is still 200", async () => {
  const res = await wrapRequestHandler(post(), () => Promise.resolve({ ok: true }));
  assertEquals(res.status, 200);
});

// --- Request bodies that are not objects (readJsonObjectBody) ---------------
//
// Every handler here does `const { a, b } = await req.json()`. A malformed body throws a
// SyntaxError out of `req.json()`, and a body of JSON `null` or a bare scalar throws a TypeError on
// the destructuring. Neither is a typed error, so the ladder above turns both into a 500 "Internal
// Server Error" AND captures them to Sentry: a caller sending a bad body pages us and is told
// nothing about what was wrong with their request.
//
// Driven through wrapRequestHandler with real Requests, because the status is the thing being
// pinned down — a helper that throws the right class but still comes back as a 500 has fixed
// nothing.

function postBody(body: string): Request {
  return new Request("https://example.test/fn", { method: "POST", body });
}

Deno.test("readJsonObjectBody: an object body passes through with its fields intact", async () => {
  const body = await readJsonObjectBody(postBody(JSON.stringify({ assignment_id: 7, new_repo: "org/repo" })));
  assertEquals(body.assignment_id, 7);
  assertEquals(body.new_repo, "org/repo");
});

Deno.test("readJsonObjectBody: malformed JSON is a 400, not a 500", async () => {
  const res = await wrapRequestHandler(postBody("{not json"), async (req) => await readJsonObjectBody(req));
  assertEquals(res.status, 400);
});

Deno.test("readJsonObjectBody: an empty body is a 400", async () => {
  // `req.json()` on zero bytes is the same SyntaxError as malformed input.
  const res = await wrapRequestHandler(postBody(""), async (req) => await readJsonObjectBody(req));
  assertEquals(res.status, 400);
});

Deno.test("readJsonObjectBody: a JSON null body is a 400, not a 500", async () => {
  // Valid JSON, so it survives req.json() and only fails at the destructuring — which is why this
  // one reached the caller as an unexplained 500 rather than as a parse error.
  const res = await wrapRequestHandler(postBody("null"), async (req) => await readJsonObjectBody(req));
  assertEquals(res.status, 400);
});

Deno.test("readJsonObjectBody: scalars and arrays are not objects to destructure", async () => {
  // An array would destructure without throwing and hand every named field back as `undefined` —
  // reported as a missing-field problem rather than as the wrong shape of body.
  for (const body of ["42", '"a string"', "true", "[]", '[{"assignment_id":1}]']) {
    const res = await wrapRequestHandler(postBody(body), async (req) => await readJsonObjectBody(req));
    assertEquals(res.status, 400, body);
  }
});

Deno.test("readJsonObjectBody: the thrown error is a 400 UserVisibleError", async () => {
  const e = await assertRejects(() => readJsonObjectBody(postBody("null")), UserVisibleError);
  assertEquals((e as UserVisibleError).status, 400);
});
