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
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { assertAuthLookupSucceeded, assertRoleLookupSucceeded, UserVisibleError } from "./HandlerUtils.ts";

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

Deno.test("assertAuthLookupSucceeded: a transport failure with no status raises 503", () => {
  // AuthRetryableFetchError and friends: we never reached the auth server, so we know nothing.
  const e = assertThrows(() => assertAuthLookupSucceeded({ message: "error sending request" }), UserVisibleError);
  assertEquals((e as UserVisibleError).status, 503);
});
