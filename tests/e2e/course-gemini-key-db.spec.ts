/**
 * #1126 course-owned Gemini API key: database-level guarantees that client calls alone cannot show.
 *
 * - Serialization: two operations on the same course are interleaved deterministically. Session A
 *   runs its operation inside an open transaction; session B's operation is started; a monitor
 *   observes (pg_blocking_pids) that B is waiting on A before A commits. Acquisition order comes from
 *   that observation, never from launch order. The monitor's deadline (1s) is below the RPCs'
 *   lock_timeout (2s): if the wait is not observed in time the test fails as inconclusive.
 * - Lock-timeout behavior is tested separately and is not counted as serialization evidence.
 * - Failures after the Vault write: a disposable, class-scoped trigger (courseGeminiKeyDb.withFault)
 *   makes the real RPC fail after vault.create_secret / vault.update_secret / the cleanup delete.
 * - Lifecycle: physical deletion cleans up the owned secret in the same statement, a failure in that
 *   cleanup aborts the deletion, TRUNCATE is refused, and a dangling mapping self-heals on save.
 *
 * Stored values are only ever compared in SQL (boolean results). Default per-PR lane.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { expect, test } from "../global-setup";
import {
  GEMINI_KEY_FEATURE,
  assertSameStack,
  backendPid,
  beginAsUser,
  credentialState,
  deleteClassInTransaction,
  inconsistencyCount,
  leftoverFaultObjects,
  privilegedClient,
  storedKeyEquals,
  syntheticKey,
  waitUntilBlocked,
  withFault,
  withPrivileged
} from "./courseGeminiKeyDb";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  setCourseFeature,
  type TestingUser
} from "./TestingUtils";

test.use({ trace: "off", video: "off", screenshot: "off" });

const LOCK_TIMEOUT_MS = 2000;

type Outcome = { ok: true; value: unknown } | { ok: false; code: string };

async function settle(p: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? "unknown" };
  }
}

async function rpcSet(c: Client, classId: number, key: string) {
  return (await c.query("SELECT public.set_course_gemini_key($1, $2) AS r", [classId, key])).rows[0].r;
}
async function rpcRemove(c: Client, classId: number) {
  return (await c.query("SELECT public.remove_course_gemini_key($1) AS r", [classId])).rows[0].r;
}
async function rpcDisable(c: Client, classId: number) {
  await c.query("SELECT public.merge_class_feature($1, $2, false)", [classId, GEMINI_KEY_FEATURE]);
  return "disabled";
}

type Actor = { userId?: string; op: (c: Client) => Promise<unknown> };

/**
 * Runs `first` in an open transaction, starts `second`, waits until the monitor sees `second`
 * blocked by `first`, then commits `first` and lets `second` finish (commit on success).
 */
async function interleave(first: Actor, second: Actor) {
  const a = await privilegedClient();
  const b = await privilegedClient();
  const monitor = await privilegedClient();
  try {
    if (first.userId) await beginAsUser(a, first.userId);
    else await a.query("BEGIN");
    const aPid = await backendPid(a);
    const aOutcome = await settle(first.op(a));
    if (!aOutcome.ok) throw new Error(`first operation failed with ${aOutcome.code}`);

    if (second.userId) await beginAsUser(b, second.userId);
    else await b.query("BEGIN");
    const bPid = await backendPid(b);
    const started = Date.now();
    const bPending = settle(second.op(b));
    const observed = await waitUntilBlocked(monitor, bPid, aPid, 1000);
    if (!observed.observed) {
      await a.query("ROLLBACK");
      await bPending;
      await b.query("ROLLBACK");
      throw new Error("inconclusive: second operation was not observed waiting on the first within 1s");
    }
    await a.query("COMMIT");
    const bOutcome = await bPending;
    const waitedMs = Date.now() - started;
    await b.query(bOutcome.ok ? "COMMIT" : "ROLLBACK");
    return { aOutcome, bOutcome, waitedMs };
  } finally {
    await Promise.all([a.end(), b.end(), monitor.end()]);
  }
}

type Course = { id: number; i1: TestingUser; i2: TestingUser };

async function enabledCourse(name: string): Promise<Course> {
  const cls = await createClass({ name });
  await assertSameStack(cls.id, cls.slug!);
  const i1 = await createUserInClass({ role: "instructor", class_id: cls.id });
  const i2 = await createUserInClass({ role: "instructor", class_id: cls.id });
  await setCourseFeature(cls.id, GEMINI_KEY_FEATURE, true);
  return { id: cls.id, i1, i2 };
}

async function seedKey(course: Course, key: string) {
  await withPrivileged(async (c) => {
    await beginAsUser(c, course.i1.user_id);
    await rpcSet(c, course.id, key);
    await c.query("COMMIT");
  });
}

async function classExists(classId: number) {
  return withPrivileged(
    async (c) => (await c.query("SELECT 1 FROM public.classes WHERE id = $1", [classId])).rowCount === 1
  );
}

test.describe("course Gemini key: serialized concurrent operations (#1126)", () => {
  test("concurrent first saves serialize: one mapping, one secret, the later commit wins", async () => {
    const course = await enabledCourse("Gemini Race FirstSave");
    const [ka, kb] = [syntheticKey(), syntheticKey()];
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcSet(c, course.id, ka) },
      { userId: course.i2.user_id, op: (c) => rpcSet(c, course.id, kb) }
    );
    expect(r.aOutcome).toMatchObject({ ok: true, value: { outcome: "saved" } });
    expect(r.bOutcome).toMatchObject({ ok: true, value: { outcome: "replaced" } });
    expect(r.waitedMs).toBeLessThan(LOCK_TIMEOUT_MS);
    expect(await storedKeyEquals(course.id, kb), "later commit stored").toBe(true);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 1, secretsNamedForCourse: 1 });
    expect(await inconsistencyCount([course.id])).toEqual({ orphanSecrets: 0, danglingMappings: 0 });
  });

  test("replace then remove: final state is absent with no orphan", async () => {
    const course = await enabledCourse("Gemini Race ReplaceRemove");
    await seedKey(course, syntheticKey());
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcSet(c, course.id, syntheticKey()) },
      { userId: course.i2.user_id, op: (c) => rpcRemove(c, course.id) }
    );
    expect(r.aOutcome).toMatchObject({ ok: true, value: { outcome: "replaced" } });
    expect(r.bOutcome).toMatchObject({ ok: true, value: { outcome: "removed" } });
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
  });

  test("remove then replace: the save becomes a first save of the new value", async () => {
    const course = await enabledCourse("Gemini Race RemoveReplace");
    await seedKey(course, syntheticKey());
    const next = syntheticKey();
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcRemove(c, course.id) },
      { userId: course.i2.user_id, op: (c) => rpcSet(c, course.id, next) }
    );
    expect(r.aOutcome).toMatchObject({ ok: true, value: { outcome: "removed" } });
    expect(r.bOutcome).toMatchObject({ ok: true, value: { outcome: "saved" } });
    expect(await storedKeyEquals(course.id, next)).toBe(true);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 1, secretsNamedForCourse: 1 });
  });

  test("disable then save: the save is rejected and the prior key is retained", async () => {
    const course = await enabledCourse("Gemini Race DisableSave");
    const prior = syntheticKey();
    await seedKey(course, prior);
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcDisable(c, course.id) },
      { userId: course.i2.user_id, op: (c) => rpcSet(c, course.id, syntheticKey()) }
    );
    expect(r.bOutcome).toEqual({ ok: false, code: "55000" });
    expect(await storedKeyEquals(course.id, prior)).toBe(true);
  });

  test("save then disable: the save lands and is retained while disabled", async () => {
    const course = await enabledCourse("Gemini Race SaveDisable");
    const key = syntheticKey();
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcSet(c, course.id, key) },
      { userId: course.i2.user_id, op: (c) => rpcDisable(c, course.id) }
    );
    expect(r.aOutcome).toMatchObject({ ok: true, value: { outcome: "saved" } });
    expect(r.bOutcome).toEqual({ ok: true, value: "disabled" });
    expect(await storedKeyEquals(course.id, key)).toBe(true);
  });

  test("course deletion then save: the save is denied and nothing is left behind", async () => {
    const course = await enabledCourse("Gemini Race DeleteSave");
    await seedKey(course, syntheticKey());
    const r = await interleave(
      { op: (c) => deleteClassInTransaction(c, course.id) },
      { userId: course.i1.user_id, op: (c) => rpcSet(c, course.id, syntheticKey()) }
    );
    expect(r.bOutcome).toEqual({ ok: false, code: "42501" });
    expect(await classExists(course.id)).toBe(false);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
  });

  test("save then course deletion: the deletion removes the newly saved secret", async () => {
    const course = await enabledCourse("Gemini Race SaveDelete");
    const r = await interleave(
      { userId: course.i1.user_id, op: (c) => rpcSet(c, course.id, syntheticKey()) },
      { op: (c) => deleteClassInTransaction(c, course.id) }
    );
    expect(r.aOutcome).toMatchObject({ ok: true, value: { outcome: "saved" } });
    expect(r.bOutcome.ok).toBe(true);
    expect(await classExists(course.id)).toBe(false);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
  });
});

test.describe("course Gemini key: lock-timeout behavior (not serialization evidence)", () => {
  test("a save blocked past lock_timeout fails with 55P03 and leaves the committed state intact", async () => {
    const course = await enabledCourse("Gemini LockTimeout");
    const [held, blocked] = [syntheticKey(), syntheticKey()];
    const a = await privilegedClient();
    const b = await privilegedClient();
    try {
      await beginAsUser(a, course.i1.user_id);
      await rpcSet(a, course.id, held);
      await beginAsUser(b, course.i2.user_id);
      const started = Date.now();
      const out = await settle(rpcSet(b, course.id, blocked));
      expect(out).toEqual({ ok: false, code: "55P03" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 100);
      await b.query("ROLLBACK");
      await a.query("COMMIT");
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect(await storedKeyEquals(course.id, held)).toBe(true);
    expect(await storedKeyEquals(course.id, blocked)).toBe(false);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 1, secretsNamedForCourse: 1 });
  });
});

test.describe("course Gemini key: failures after the Vault write roll back (#1126)", () => {
  let course: Course;
  let asInstructor: SupabaseClient<Database>;

  test.beforeAll(async () => {
    course = await enabledCourse("Gemini Faults");
    asInstructor = await createAuthenticatedClient(course.i1);
  });

  test.afterAll(async () => {
    expect(await leftoverFaultObjects()).toBe(0);
  });

  test("first save failing after vault.create_secret leaves no secret and no mapping", async () => {
    const key = syntheticKey();
    const res = await withFault(course.id, "after_vault_create", () =>
      asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: key })
    );
    expect(res.error?.code).toBe("XX000");
    expect(res.error?.message).toBe("Credential operation failed");
    expect(res.error?.details ?? null).toBeNull();
    expect(JSON.stringify(res.error).includes(key)).toBe(false);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
  });

  test("replace failing after vault.update_secret restores the previous value in the same secret", async () => {
    const s1 = syntheticKey();
    expect(
      (await asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: s1 })).error
    ).toBeNull();
    const before = await credentialState(course.id);
    const s2 = syntheticKey();
    const res = await withFault(course.id, "after_vault_update", () =>
      asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: s2 })
    );
    expect(res.error?.code).toBe("XX000");
    expect(await storedKeyEquals(course.id, s1), "previous value restored").toBe(true);
    expect(await storedKeyEquals(course.id, s2), "new value not committed").toBe(false);
    const after = await credentialState(course.id);
    expect(after).toMatchObject({ mappings: 1, secretsNamedForCourse: 1 });
    expect(after.secretIdDigest === before.secretIdDigest).toBe(true);
  });

  test("removal failing after the secret was deleted restores mapping and secret", async () => {
    const s1 = syntheticKey();
    expect(
      (await asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: s1 })).error
    ).toBeNull();
    const res = await withFault(course.id, "after_cleanup", () =>
      asInstructor.rpc("remove_course_gemini_key", { p_class_id: course.id })
    );
    expect(res.error?.code).toBe("XX000");
    expect(await storedKeyEquals(course.id, s1), "secret restored").toBe(true);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 1, ownedSecretExists: true });
  });

  test("course deletion failing after the cleanup delete restores class, mapping and secret", async () => {
    const s1 = syntheticKey();
    expect(
      (await asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: s1 })).error
    ).toBeNull();
    const out = await withFault(course.id, "after_cleanup", () =>
      withPrivileged(async (c) => {
        await c.query("BEGIN");
        const r = await settle(deleteClassInTransaction(c, course.id));
        await c.query("ROLLBACK");
        return r;
      })
    );
    expect(out.ok).toBe(false);
    expect(await classExists(course.id)).toBe(true);
    expect(await storedKeyEquals(course.id, s1)).toBe(true);
  });
});

test.describe("course Gemini key: course lifecycle (#1126)", () => {
  test("physical course deletion removes the mapping and the owned Vault secret", async () => {
    const course = await enabledCourse("Gemini Delete");
    await seedKey(course, syntheticKey());
    expect((await credentialState(course.id)).ownedSecretExists).toBe(true);
    await withPrivileged(async (c) => {
      await c.query("BEGIN");
      await deleteClassInTransaction(c, course.id);
      await c.query("COMMIT");
    });
    expect(await classExists(course.id)).toBe(false);
    expect(await credentialState(course.id)).toMatchObject({ mappings: 0, secretsNamedForCourse: 0 });
  });

  test("a cleanup failure (Vault row unavailable) aborts the course deletion", async () => {
    const course = await enabledCourse("Gemini Delete Blocked");
    const key = syntheticKey();
    await seedKey(course, key);
    const holder = await privilegedClient();
    const deleter = await privilegedClient();
    try {
      // The holder deletes the secret row without committing, so the cleanup trigger's DELETE has
      // to wait for it; the deleting session's lock_timeout turns that wait into a cleanup failure.
      await holder.query("BEGIN");
      await holder.query(
        "DELETE FROM vault.secrets WHERE id = (SELECT vault_secret_id FROM course_secrets.course_gemini_api_keys WHERE class_id = $1)",
        [course.id]
      );
      await deleter.query("BEGIN");
      await deleter.query("SET LOCAL lock_timeout = '300ms'");
      const out = await settle(deleteClassInTransaction(deleter, course.id));
      expect(out).toEqual({ ok: false, code: "55P03" });
      await deleter.query("ROLLBACK");
      await holder.query("ROLLBACK");
    } finally {
      await Promise.all([holder.end(), deleter.end()]);
    }
    expect(await classExists(course.id)).toBe(true);
    expect(await storedKeyEquals(course.id, key)).toBe(true);
  });

  test("TRUNCATE of the mapping is refused (it would bypass secret cleanup)", async () => {
    const out = await withPrivileged(async (c) => {
      await c.query("BEGIN");
      const r = await settle(c.query("TRUNCATE course_secrets.course_gemini_api_keys"));
      await c.query("ROLLBACK");
      return r;
    });
    expect(out.ok).toBe(false);
  });

  test("a dangling mapping reports not configured and the next save repairs it", async () => {
    const course = await enabledCourse("Gemini Dangling");
    await seedKey(course, syntheticKey());
    await withPrivileged((c) =>
      c.query(
        "DELETE FROM vault.secrets WHERE id = (SELECT vault_secret_id FROM course_secrets.course_gemini_api_keys WHERE class_id = $1)",
        [course.id]
      )
    );
    const asInstructor = await createAuthenticatedClient(course.i1);
    const st = await asInstructor.rpc("get_course_gemini_key_status", { p_class_id: course.id });
    expect(st.data).toEqual({ setup_enabled: true, configured: false });
    const fresh = syntheticKey();
    const saved = await asInstructor.rpc("set_course_gemini_key", { p_class_id: course.id, p_api_key: fresh });
    expect(saved.data).toMatchObject({ outcome: "saved" });
    expect(await storedKeyEquals(course.id, fresh)).toBe(true);
    expect(await inconsistencyCount([course.id])).toEqual({ orphanSecrets: 0, danglingMappings: 0 });
  });
});

test.describe("course Gemini key: effective privileges (#1126)", () => {
  test("client roles have no access to the private schema, mapping, Vault or internal functions", async () => {
    const rows = await withPrivileged(async (c) => {
      const { rows } = await c.query<{ role: string; check: string; allowed: boolean }>(`
        WITH roles(role) AS (VALUES ('anon'), ('authenticated'))
        SELECT role, 'usage course_secrets' AS check, has_schema_privilege(role, 'course_secrets', 'USAGE') AS allowed FROM roles
        UNION ALL SELECT role, 'mapping any', has_table_privilege(role, 'course_secrets.course_gemini_api_keys', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') FROM roles
        UNION ALL SELECT role, 'usage vault', has_schema_privilege(role, 'vault', 'USAGE') FROM roles
        UNION ALL SELECT role, 'vault.secrets select', has_table_privilege(role, 'vault.secrets', 'SELECT') FROM roles
        UNION ALL SELECT role, 'vault.decrypted_secrets select', has_table_privilege(role, 'vault.decrypted_secrets', 'SELECT') FROM roles
        UNION ALL SELECT role, 'exec ' || p.oid::regprocedure::text, has_function_privilege(role, p.oid, 'EXECUTE')
          FROM roles, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'course_secrets'
        UNION ALL SELECT role, 'exec ' || p.oid::regprocedure::text, has_function_privilege(role, p.oid, 'EXECUTE')
          FROM roles, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'vault' AND p.proname IN ('create_secret', 'update_secret')
        ORDER BY 1, 2`);
      return rows;
    });
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.allowed)).toEqual([]);
  });

  test("only authenticated (and service_role) may execute the management RPCs; anon may not", async () => {
    const rows = await withPrivileged(async (c) => {
      const { rows } = await c.query<{ fn: string; anon: boolean; authenticated: boolean; public_acl: boolean }>(`
        SELECT p.oid::regprocedure::text AS fn,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
               EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('get_course_gemini_key_status', 'set_course_gemini_key', 'remove_course_gemini_key')
        ORDER BY 1`);
      return rows;
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r, r.fn).toMatchObject({ anon: false, authenticated: true, public_acl: false });
    }
  });
});
