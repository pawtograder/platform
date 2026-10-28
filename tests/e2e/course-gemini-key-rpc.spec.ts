/**
 * #1126 course-owned Gemini API key: RPC contract, authorization, isolation and flag behavior,
 * exercised through ordinary signed-in clients (PostgREST), with stored-value checks made through
 * privileged boolean comparisons (courseGeminiKeyDb.ts). Synthetic keys only; assertions never
 * print a key: they compare booleans.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd. Requires the disposable
 * database identity described in courseGeminiKeyDb.ts and fails (does not skip) without it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { expect, test } from "../global-setup";
import {
  GEMINI_KEY_FEATURE,
  assertSameStack,
  credentialState,
  inconsistencyCount,
  storedKeyEquals,
  syntheticKey,
  withPrivileged
} from "./courseGeminiKeyDb";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  setCourseFeature,
  supabase,
  type TestingUser
} from "./TestingUtils";

// Credential specs keep traces, video and screenshots off: they would capture request bodies.
test.use({ trace: "off", video: "off", screenshot: "off" });

type Rpc = "get_course_gemini_key_status" | "set_course_gemini_key" | "remove_course_gemini_key";
type RpcResult = {
  data: unknown;
  error: { code?: string; message: string; details?: string | null; hint?: string | null } | null;
};

async function status(client: SupabaseClient<Database>, classId: number): Promise<RpcResult> {
  return client.rpc("get_course_gemini_key_status", { p_class_id: classId });
}
async function setKey(client: SupabaseClient<Database>, classId: number, key: string | null): Promise<RpcResult> {
  return client.rpc("set_course_gemini_key", { p_class_id: classId, p_api_key: key as string });
}
async function removeKey(client: SupabaseClient<Database>, classId: number): Promise<RpcResult> {
  return client.rpc("remove_course_gemini_key", { p_class_id: classId });
}

/** Fails with a message that names the code but never the request body. */
function expectCode(res: RpcResult, code: string, what: string) {
  expect(res.error?.code ?? "no error", what).toBe(code);
}

/** Only these response shapes are allowed; anything else (ids, values) is a disclosure. */
function expectSecretFreeResponse(res: RpcResult, keys: string[]) {
  expect(res.error).toBeNull();
  const body = res.data as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([...keys].sort());
  const serialized = JSON.stringify(body);
  expect(/PAWTO_SYNTH_/.test(serialized), "response must not contain key material").toBe(false);
  expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized), "no ids").toBe(false);
}

function expectSecretFreeError(res: RpcResult, sentinel: string) {
  const serialized = JSON.stringify(res.error ?? {});
  expect(serialized.includes(sentinel), "error must not echo the key").toBe(false);
  expect(res.error?.details ?? null).toBeNull();
  expect(res.error?.hint ?? null).toBeNull();
}

async function setFeaturesRaw(classId: number, features: unknown) {
  const { error } = await supabase
    .from("classes")
    .update({ features: features as never })
    .eq("id", classId);
  if (error) throw new Error(`setFeaturesRaw: ${error.message}`);
}

test.describe("course Gemini key RPCs (#1126)", () => {
  test.describe.configure({ mode: "serial" });

  let classA: { id: number; slug: string | null };
  let classB: { id: number; slug: string | null };
  let instructorA: TestingUser;
  let instructorA2: TestingUser;
  let studentA: TestingUser;
  let graderA: TestingUser;
  let instructorB: TestingUser;
  let outsider: TestingUser;
  let asInstructorA: SupabaseClient<Database>;
  let asInstructorA2: SupabaseClient<Database>;

  test.beforeAll(async () => {
    classA = await createClass({ name: "Gemini Key RPC A" });
    classB = await createClass({ name: "Gemini Key RPC B" });
    await assertSameStack(classA.id, classA.slug!);
    instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    instructorA2 = await createUserInClass({ role: "instructor", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    graderA = await createUserInClass({ role: "grader", class_id: classA.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    // Enrolled only in B, so a non-member of A.
    outsider = await createUserInClass({ role: "student", class_id: classB.id });
    asInstructorA = await createAuthenticatedClient(instructorA);
    asInstructorA2 = await createAuthenticatedClient(instructorA2);
  });

  test("setup defaults off: an absent flag rejects save, while status and removal work", async () => {
    const s = await status(asInstructorA, classA.id);
    expectSecretFreeResponse(s, ["setup_enabled", "configured"]);
    expect(s.data).toEqual({ setup_enabled: false, configured: false });

    const key = syntheticKey();
    const rejected = await setKey(asInstructorA, classA.id, key);
    expectCode(rejected, "55000", "save with setup absent");
    expectSecretFreeError(rejected, key);
    expect((await credentialState(classA.id)).mappings).toBe(0);

    const removed = await removeKey(asInstructorA, classA.id);
    expectSecretFreeResponse(removed, ["setup_enabled", "configured", "outcome"]);
    expect(removed.data).toEqual({ setup_enabled: false, configured: false, outcome: "already_absent" });
  });

  test("malformed or non-boolean flag values count as disabled", async () => {
    const cases: unknown[] = [
      [{ name: GEMINI_KEY_FEATURE, enabled: "true" }],
      [{ name: GEMINI_KEY_FEATURE, enabled: "yes" }],
      [{ name: GEMINI_KEY_FEATURE, enabled: 1 }],
      [{ name: GEMINI_KEY_FEATURE }],
      { [GEMINI_KEY_FEATURE]: true },
      [{ name: GEMINI_KEY_FEATURE, enabled: false }]
    ];
    for (const features of cases) {
      await setFeaturesRaw(classA.id, features);
      const s = await status(asInstructorA, classA.id);
      expect((s.data as { setup_enabled: boolean }).setup_enabled, JSON.stringify(features)).toBe(false);
      expectCode(await setKey(asInstructorA, classA.id, syntheticKey()), "55000", JSON.stringify(features));
    }
    expect((await credentialState(classA.id)).mappings).toBe(0);
    await setFeaturesRaw(classA.id, null);
  });

  test("explicitly enabled with no credential: first save succeeds and persists", async () => {
    await setCourseFeature(classA.id, GEMINI_KEY_FEATURE, true);
    const before = await status(asInstructorA, classA.id);
    expect(before.data).toEqual({ setup_enabled: true, configured: false });

    const s1 = syntheticKey();
    const saved = await setKey(asInstructorA, classA.id, s1);
    expectSecretFreeResponse(saved, ["setup_enabled", "configured", "outcome"]);
    expect(saved.data).toEqual({ setup_enabled: true, configured: true, outcome: "saved" });
    expect(await storedKeyEquals(classA.id, s1), "stored value is S1").toBe(true);

    // A fresh session (as after a page refresh) sees the persisted status.
    const fresh = await createAuthenticatedClient(instructorA);
    expect((await status(fresh, classA.id)).data).toEqual({ setup_enabled: true, configured: true });
    const st = await credentialState(classA.id);
    expect(st).toMatchObject({ mappings: 1, secretsNamedForCourse: 1, ownedSecretExists: true });
  });

  test("replace keeps one secret (same id) holding the new value; a co-instructor can manage it", async () => {
    const before = await credentialState(classA.id);
    const s2 = syntheticKey();
    const replaced = await setKey(asInstructorA2, classA.id, s2);
    expectSecretFreeResponse(replaced, ["setup_enabled", "configured", "outcome"]);
    expect(replaced.data).toEqual({ setup_enabled: true, configured: true, outcome: "replaced" });
    expect(await storedKeyEquals(classA.id, s2), "stored value is S2").toBe(true);
    const after = await credentialState(classA.id);
    expect(after).toMatchObject({ mappings: 1, secretsNamedForCourse: 1, ownedSecretExists: true });
    expect(after.secretIdDigest === before.secretIdDigest, "same Vault secret replaced in place").toBe(true);
  });

  test("whitespace handling: blank keys are rejected and keep the prior value; surrounding whitespace is trimmed", async () => {
    const prior = syntheticKey();
    expect((await setKey(asInstructorA, classA.id, prior)).error).toBeNull();
    const blanks: (string | null)[] = ["", "   ", "\t\n\r ", "  ", "​﻿", null];
    for (const blank of blanks) {
      const res = await setKey(asInstructorA, classA.id, blank);
      expectCode(res, "22023", `blank key ${JSON.stringify(blank)}`);
    }
    const tooLong = "PAWTO_SYNTH_" + "x".repeat(4100);
    const longRes = await setKey(asInstructorA, classA.id, tooLong);
    expectCode(longRes, "22023", "over-long key");
    expectSecretFreeError(longRes, tooLong);
    expect(await storedKeyEquals(classA.id, prior), "prior value preserved after rejected input").toBe(true);

    const padded = syntheticKey();
    expect((await setKey(asInstructorA, classA.id, `  \t${padded} \n`)).error).toBeNull();
    expect(await storedKeyEquals(classA.id, padded), "trimmed value stored").toBe(true);
  });

  test("students, graders, non-members and anon cannot read status or change the key", async () => {
    const sentinel = syntheticKey();
    const anon = createClient<Database>(
      process.env.SUPABASE_URL!,
      (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const callers: [string, SupabaseClient<Database>][] = [
      ["student", await createAuthenticatedClient(studentA)],
      ["grader", await createAuthenticatedClient(graderA)],
      ["non-member", await createAuthenticatedClient(outsider)],
      ["instructor of another course", await createAuthenticatedClient(instructorB)]
    ];
    for (const [who, client] of callers) {
      expectCode(await status(client, classA.id), "42501", `${who} status`);
      const s = await setKey(client, classA.id, sentinel);
      expectCode(s, "42501", `${who} set`);
      expectSecretFreeError(s, sentinel);
      expectCode(await removeKey(client, classA.id), "42501", `${who} remove`);
    }
    // anon has no EXECUTE at all; PostgREST reports a permission error, never data.
    for (const res of [
      await status(anon, classA.id),
      await setKey(anon, classA.id, sentinel),
      await removeKey(anon, classA.id)
    ]) {
      expect(res.error, "anon call must fail").not.toBeNull();
      expect(res.data ?? null).toBeNull();
    }
    expect(await storedKeyEquals(classA.id, sentinel), "no unauthorized write landed").toBe(false);
    expect((await credentialState(classA.id)).mappings).toBe(1);
  });

  test("course isolation: an instructor of A cannot manage B, and B is unaffected by A", async () => {
    expectCode(await status(asInstructorA, classB.id), "42501", "A->B status");
    expectCode(await setKey(asInstructorA, classB.id, syntheticKey()), "42501", "A->B set");
    expectCode(await removeKey(asInstructorA, classB.id), "42501", "A->B remove");
    const asB = await createAuthenticatedClient(instructorB);
    expect((await status(asB, classB.id)).data).toEqual({ setup_enabled: false, configured: false });
    expect((await credentialState(classB.id)).mappings).toBe(0);
    // A nonexistent course is indistinguishable from one the caller does not teach.
    expectCode(await status(asInstructorA, 2_000_000_000), "42501", "nonexistent course");
  });

  test("disabling setup keeps the stored key; status and removal still work, save/replace are blocked", async () => {
    const current = syntheticKey();
    expect((await setKey(asInstructorA, classA.id, current)).error).toBeNull();
    await setCourseFeature(classA.id, GEMINI_KEY_FEATURE, false);
    expect((await status(asInstructorA, classA.id)).data).toEqual({ setup_enabled: false, configured: true });
    expectCode(await setKey(asInstructorA, classA.id, syntheticKey()), "55000", "replace while disabled");
    expect(await storedKeyEquals(classA.id, current), "value retained while disabled").toBe(true);

    const removed = await removeKey(asInstructorA, classA.id);
    expect(removed.data).toEqual({ setup_enabled: false, configured: false, outcome: "removed" });
    expect(await credentialState(classA.id)).toMatchObject({
      mappings: 0,
      secretsNamedForCourse: 0,
      ownedSecretExists: false
    });
    expect((await removeKey(asInstructorA, classA.id)).data).toEqual({
      setup_enabled: false,
      configured: false,
      outcome: "already_absent"
    });
  });

  test("role revocation: the next request after a committed revocation is denied (same session)", async () => {
    await setCourseFeature(classA.id, GEMINI_KEY_FEATURE, true);
    const revoked = await createUserInClass({ role: "instructor", class_id: classA.id });
    const session = await createAuthenticatedClient(revoked);
    expect((await status(session, classA.id)).error).toBeNull();
    const { error } = await supabase
      .from("user_roles")
      .update({ disabled: true })
      .eq("class_id", classA.id)
      .eq("user_id", revoked.user_id);
    expect(error).toBeNull();
    expectCode(await status(session, classA.id), "42501", "status after revocation");
    expectCode(await setKey(session, classA.id, syntheticKey()), "42501", "set after revocation");
    expectCode(await removeKey(session, classA.id), "42501", "remove after revocation");
  });

  test("archiving the course keeps the stored key", async () => {
    const key = syntheticKey();
    expect((await setKey(asInstructorA, classA.id, key)).error).toBeNull();
    const { error } = await supabase.from("classes").update({ archived: true }).eq("id", classA.id);
    expect(error).toBeNull();
    expect(await storedKeyEquals(classA.id, key), "archived course retains key").toBe(true);
    expect((await credentialState(classA.id)).ownedSecretExists).toBe(true);
    await supabase.from("classes").update({ archived: false }).eq("id", classA.id);
  });

  test("client roles cannot reach the private mapping or Vault through the API", async () => {
    const asStudent = await createAuthenticatedClient(studentA);
    for (const client of [asInstructorA, asStudent]) {
      const mapping = await (client as unknown as SupabaseClient)
        .schema("course_secrets")
        .from("course_gemini_api_keys")
        .select("*");
      expect(mapping.error, "course_secrets is not exposed").not.toBeNull();
      expect(mapping.data ?? null).toBeNull();
      const vault = await (client as unknown as SupabaseClient).schema("vault").from("decrypted_secrets").select("*");
      expect(vault.error, "vault is not exposed").not.toBeNull();
      expect(vault.data ?? null).toBeNull();
    }
  });

  test("synthetic keys do not reach audit rows, cron, statement stats or migration history", async () => {
    const key = syntheticKey();
    expect((await setKey(asInstructorA, classA.id, key)).error).toBeNull();
    const leaks = await withPrivileged(async (c) => {
      const q = async (sql: string) => (await c.query<{ n: number }>(sql, [`%${key}%`])).rows[0].n;
      return {
        audit: await q(
          "SELECT count(*)::int AS n FROM public.audit WHERE coalesce(old::text,'') LIKE $1 OR coalesce(new::text,'') LIKE $1"
        ),
        cron: await q("SELECT count(*)::int AS n FROM cron.job WHERE command LIKE $1"),
        statements: await q("SELECT count(*)::int AS n FROM extensions.pg_stat_statements WHERE query LIKE $1"),
        migrations: await q(
          "SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations WHERE array_to_string(statements, ' ') LIKE $1"
        ),
        activity: await q(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()"
        )
      };
    });
    expect(leaks).toEqual({ audit: 0, cron: 0, statements: 0, migrations: 0, activity: 0 });
    expect(await inconsistencyCount([classA.id, classB.id])).toEqual({ orphanSecrets: 0, danglingMappings: 0 });
  });
});
