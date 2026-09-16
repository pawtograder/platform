/**
 * Unit tests for the Bottleneck Lua sentinel normalization in Redis.ts.
 *
 * The reply strings below are verbatim from prod Redis 7.4.2: `redis.error_reply('X')` comes back as
 * `ERR X` whenever X carries no error code of its own, which is true of both of Bottleneck's
 * sentinels. Bottleneck 2.19.5 compares them with `===` (lib/RedisDatastore.js:176), so the prefix
 * silently disables its re-init-and-retry and the reply is handed to a caller's job instead. These
 * assertions are that contract: the two sentinels must arrive at Bottleneck unprefixed, and nothing
 * else may be rewritten.
 *
 * Run from supabase/functions:  deno test --allow-env _shared/BottleneckLuaErrors.test.ts
 */
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import { installBottleneckLuaErrorNormalizer, normalizeBottleneckLuaError } from "./Redis.ts";

Deno.test("the two sentinels Bottleneck recovers from lose the Redis 7 prefix", () => {
  for (const sentinel of ["SETTINGS_KEY_NOT_FOUND", "UNKNOWN_CLIENT"]) {
    const normalized = normalizeBottleneckLuaError(new Error(`ERR ${sentinel}`)) as Error;
    assertEquals(normalized.message, sentinel);
  }
});

Deno.test("an already-bare sentinel is left alone", () => {
  const error = new Error("SETTINGS_KEY_NOT_FOUND");
  assertEquals((normalizeBottleneckLuaError(error) as Error).message, "SETTINGS_KEY_NOT_FOUND");
});

Deno.test("the error object is preserved, not replaced", () => {
  class ReplyError extends Error {}
  const error = new ReplyError("ERR SETTINGS_KEY_NOT_FOUND");
  const normalized = normalizeBottleneckLuaError(error);
  // Bottleneck rejects with whatever it is handed and callers classify on it, so swapping in a
  // plain Error here would lose the ioredis type and the stack.
  assertStrictEquals(normalized, error);
});

Deno.test("a reply that merely mentions a sentinel still propagates", () => {
  // The Upstash adapter synthesizes this one itself, and means it: the only fix is a new worker.
  const synthesized = "UNKNOWN_CLIENT error, failing immediately";
  assertEquals((normalizeBottleneckLuaError(new Error(synthesized)) as Error).message, synthesized);

  const unrelated = "ERR max number of clients reached";
  assertEquals((normalizeBottleneckLuaError(new Error(unrelated)) as Error).message, unrelated);
});

Deno.test("a non-Error rejection passes through untouched", () => {
  assertEquals(normalizeBottleneckLuaError("ERR SETTINGS_KEY_NOT_FOUND"), "ERR SETTINGS_KEY_NOT_FOUND");
  assertEquals(normalizeBottleneckLuaError(undefined), undefined);
});

Deno.test("the connection patch rewrites the callback error Bottleneck rejects on", () => {
  // Stands in for Bottleneck.IORedisConnection: runScript appends a node-style callback via
  // __scriptArgs__ and then calls __scriptFn__(name)(...args), rejecting with the callback's err.
  let received: unknown[] = [];
  const connection = {
    __scriptFn__:
      (name: string) =>
      (...args: unknown[]) => {
        received = args;
        const cb = args[args.length - 1] as (err: unknown, reply?: unknown) => void;
        cb(new Error("ERR SETTINGS_KEY_NOT_FOUND"));
        return name;
      }
  };

  installBottleneckLuaErrorNormalizer(connection);

  let seen: unknown;
  connection.__scriptFn__("check")(2, "b_x_settings", "b_x_job_weights", 1757000000, (err: unknown) => {
    seen = err;
  });

  assertEquals((seen as Error).message, "SETTINGS_KEY_NOT_FOUND");
  // The keys and argv Bottleneck built must reach the script unchanged; only the callback is swapped.
  assertEquals(received.slice(0, -1), [2, "b_x_settings", "b_x_job_weights", 1757000000]);
});

Deno.test("the connection patch leaves a successful reply alone", () => {
  const connection = {
    __scriptFn__:
      (_name: string) =>
      (...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: unknown, reply?: unknown) => void;
        cb(null, ["0", "1"]);
      }
  };

  installBottleneckLuaErrorNormalizer(connection);

  let error: unknown = "unset";
  let reply: unknown;
  connection.__scriptFn__("init")(0, (err: unknown, value: unknown) => {
    error = err;
    reply = value;
  });

  assertEquals(error, null);
  assertEquals(reply, ["0", "1"]);
});

Deno.test("a script call with no callback is passed straight through", () => {
  let called = false;
  const connection = {
    __scriptFn__:
      (_name: string) =>
      (...args: unknown[]) => {
        called = true;
        return args.length;
      }
  };

  installBottleneckLuaErrorNormalizer(connection);

  assertEquals(connection.__scriptFn__("queued")(1, "b_x_settings"), 2);
  assertEquals(called, true);
});
