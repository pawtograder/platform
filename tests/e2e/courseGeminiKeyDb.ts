/**
 * Privileged database helpers for the course Gemini key specs (#1126).
 *
 * The specs need to look at things no client role can see: whether the Vault secret holds the
 * value a test submitted, whether a mapping or an orphaned secret exists, and how concurrent
 * transactions interleave. Those checks run as `postgres` over a direct connection, so this module
 * refuses to connect unless the target is an explicitly identified disposable database:
 *
 *   BYOK_TEST_DB_URL            connection string of the disposable database
 *   BYOK_TEST_DB_FINGERPRINT    sha256 of the Vault secret `byok-disposable-db-marker` in that
 *                               database, created by whoever provisioned it (CI: the e2e job; locally:
 *                               the task stack's bootstrap)
 *   BYOK_TEST_DB_EXPECTED_PORT  optional; when set, the URL's port must match
 *
 * A database without the marker (any developer's or teammate's stack) fails closed. No credential
 * value is ever returned from here: value checks are SQL comparisons that come back as booleans.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

export const GEMINI_KEY_FEATURE = "gemini-api-key-setup";
const SECRET_NAME_PREFIX = "course_gemini_api_key:";

/** A fresh synthetic credential. Never log it; compare it only through the boolean helpers below. */
export function syntheticKey(): string {
  return `PAWTO_SYNTH_${randomUUID()}`;
}

let verifiedUrl: Promise<string> | null = null;

async function verifyTaskDatabase(): Promise<string> {
  const url = process.env.BYOK_TEST_DB_URL;
  const fingerprint = process.env.BYOK_TEST_DB_FINGERPRINT;
  if (!url || !fingerprint) {
    throw new Error(
      "BYOK_TEST_DB_URL and BYOK_TEST_DB_FINGERPRINT must identify a disposable database; refusing privileged access"
    );
  }
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("privileged credential tests only run against a local disposable database");
  }
  const expectedPort = process.env.BYOK_TEST_DB_EXPECTED_PORT;
  if (expectedPort && parsed.port !== expectedPort) {
    throw new Error("BYOK_TEST_DB_URL does not match BYOK_TEST_DB_EXPECTED_PORT; refusing privileged access");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ h: string }>(
      `SELECT encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex') AS h
         FROM vault.decrypted_secrets WHERE name = 'byok-disposable-db-marker'`
    );
    if (rows.length !== 1 || rows[0].h !== fingerprint) {
      throw new Error("disposable database marker is missing or does not match; refusing privileged access");
    }
  } finally {
    await client.end();
  }
  return url;
}

async function taskDatabaseUrl(): Promise<string> {
  verifiedUrl ??= verifyTaskDatabase();
  return verifiedUrl;
}

/** A new connection as `postgres` to the verified disposable database. Caller must end() it. */
export async function privilegedClient(): Promise<Client> {
  const client = new Client({ connectionString: await taskDatabaseUrl() });
  await client.connect();
  return client;
}

export async function withPrivileged<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await privilegedClient();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Fails unless the database behind BYOK_TEST_DB_URL holds the class the API just created, so
 * privileged assertions and API calls are known to hit the same stack.
 */
export async function assertSameStack(classId: number, slug: string): Promise<void> {
  const rows = await withPrivileged(
    async (c) => (await c.query<{ slug: string }>("SELECT slug FROM public.classes WHERE id = $1", [classId])).rows
  );
  if (rows.length !== 1 || rows[0].slug !== slug) {
    throw new Error("BYOK_TEST_DB_URL is not the database behind SUPABASE_URL");
  }
}

/** True when the course's stored key equals `value`. Returns only the comparison result. */
export async function storedKeyEquals(classId: number, value: string): Promise<boolean> {
  return withPrivileged(async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM course_secrets.course_gemini_api_keys m
         JOIN vault.decrypted_secrets d ON d.id = m.vault_secret_id
         WHERE m.class_id = $1 AND d.decrypted_secret = $2
       ) AS ok`,
      [classId, value]
    );
    return rows[0].ok;
  });
}

export type CredentialState = {
  /** Mapping rows for the course (0 or 1). */
  mappings: number;
  /** Vault secrets carrying the course's secret name. */
  secretsNamedForCourse: number;
  /** The mapping's secret exists in Vault. */
  ownedSecretExists: boolean;
  /** Opaque digest of the mapped secret id, for same-secret comparisons without exposing the id. */
  secretIdDigest: string | null;
};

export async function credentialState(classId: number): Promise<CredentialState> {
  return withPrivileged(async (c) => {
    const { rows } = await c.query<{
      mappings: number;
      named: number;
      owned: boolean;
      sid: string | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM course_secrets.course_gemini_api_keys WHERE class_id = $1) AS mappings,
         (SELECT count(*)::int FROM vault.secrets WHERE name = $2) AS named,
         EXISTS (SELECT 1 FROM course_secrets.course_gemini_api_keys m JOIN vault.secrets s ON s.id = m.vault_secret_id
                 WHERE m.class_id = $1) AS owned,
         (SELECT vault_secret_id::text FROM course_secrets.course_gemini_api_keys WHERE class_id = $1) AS sid`,
      [classId, SECRET_NAME_PREFIX + classId]
    );
    const r = rows[0];
    return {
      mappings: r.mappings,
      secretsNamedForCourse: r.named,
      ownedSecretExists: r.owned,
      secretIdDigest: r.sid ? createHash("sha256").update(r.sid).digest("hex") : null
    };
  });
}

/** For the given courses: course-key Vault secrets with no mapping, and mappings with no secret. */
export async function inconsistencyCount(
  classIds: number[]
): Promise<{ orphanSecrets: number; danglingMappings: number }> {
  return withPrivileged(async (c) => {
    const names = classIds.map((id) => SECRET_NAME_PREFIX + id);
    const { rows } = await c.query<{ orphans: number; dangling: number }>(
      `SELECT
         (SELECT count(*)::int FROM vault.secrets s WHERE s.name = ANY ($1::text[])
            AND NOT EXISTS (SELECT 1 FROM course_secrets.course_gemini_api_keys m WHERE m.vault_secret_id = s.id)) AS orphans,
         (SELECT count(*)::int FROM course_secrets.course_gemini_api_keys m
            WHERE m.class_id = ANY ($2::bigint[])
              AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = m.vault_secret_id)) AS dangling`,
      [names, classIds]
    );
    return { orphanSecrets: rows[0].orphans, danglingMappings: rows[0].dangling };
  });
}

/** Opens a transaction that PostgREST would run for `userId`: authenticated role plus JWT claims. */
export async function beginAsUser(client: Client, userId: string): Promise<void> {
  await client.query("BEGIN");
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" })
  ]);
  await client.query("SET LOCAL ROLE authenticated");
}

export async function backendPid(client: Client): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

/**
 * Polls until `waiterPid` is blocked by `blockerPid`. Resolves false if that is not observed within
 * `deadlineMs`; callers keep the deadline below the RPC's lock_timeout (2s) so a slow observation
 * fails the test as inconclusive instead of turning it into a timeout test.
 */
export async function waitUntilBlocked(
  monitor: Client,
  waiterPid: number,
  blockerPid: number,
  deadlineMs = 1000
): Promise<{ observed: boolean; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { rows } = await monitor.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked",
      [waiterPid, blockerPid]
    );
    if (rows[0].blocked) return { observed: true, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, 20));
  }
  return { observed: false, elapsedMs: Date.now() - start };
}

/**
 * Physically deletes a class in the caller's open transaction. Rows in tables whose foreign key to
 * classes has no ON DELETE action (the default structure created with every class: gradebook,
 * discussion topics, help queue, ...) are removed first, then `DELETE FROM public.classes` runs, so
 * the ON DELETE CASCADE to the credential mapping and its cleanup trigger fire exactly as they would
 * for any physical deletion.
 */
export async function deleteClassInTransaction(client: Client, classId: number): Promise<void> {
  // classes.gradebook_id points back at the class's own gradebook (no ON DELETE action).
  await client.query("UPDATE public.classes SET gradebook_id = NULL WHERE id = $1", [classId]);
  await client.query(
    `DO $del$
     DECLARE r record; pass int; remaining int;
     BEGIN
       FOR pass IN 1..10 LOOP
         remaining := 0;
         FOR r IN
           SELECT c.conrelid::regclass AS tbl, a.attname AS col
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           WHERE c.contype = 'f' AND c.confrelid = 'public.classes'::regclass AND c.confdeltype IN ('a', 'r')
             AND c.conrelid <> 'public.classes'::regclass
         LOOP
           BEGIN
             EXECUTE format('DELETE FROM %s WHERE %I = $1', r.tbl, r.col) USING ${Number(classId)}::bigint;
           EXCEPTION WHEN foreign_key_violation THEN
             remaining := remaining + 1;
           END;
         END LOOP;
         EXIT WHEN remaining = 0;
       END LOOP;
     END
     $del$`
  );
  await client.query("DELETE FROM public.classes WHERE id = $1", [classId]);
}

export type FaultPoint =
  | "after_vault_create" // BEFORE INSERT on the mapping: vault.create_secret already ran
  | "after_vault_update" // BEFORE UPDATE on the mapping: vault.update_secret already ran
  | "after_cleanup"; // AFTER DELETE on the mapping, named to fire after the cleanup trigger

/**
 * Installs a disposable fault-injection trigger on the mapping table, scoped to one class so other
 * tests are unaffected, runs `fn`, and always removes it. Test-only: the schema is created and
 * dropped here and nothing in the product references it.
 */
export async function withFault<T>(classId: number, point: FaultPoint, fn: () => Promise<T>): Promise<T> {
  const schema = `byok_test_fault_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const timing =
    point === "after_vault_create"
      ? "BEFORE INSERT"
      : point === "after_vault_update"
        ? "BEFORE UPDATE"
        : "AFTER DELETE";
  await withPrivileged(async (c) => {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(
      `CREATE FUNCTION ${schema}.fail() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN
         IF COALESCE(NEW.class_id, OLD.class_id) = ${Number(classId)} THEN
           RAISE EXCEPTION 'injected test fault';
         END IF;
         RETURN COALESCE(NEW, OLD);
       END $f$`
    );
    await c.query(
      `CREATE TRIGGER zz_${schema} ${timing} ON course_secrets.course_gemini_api_keys
       FOR EACH ROW EXECUTE FUNCTION ${schema}.fail()`
    );
  });
  try {
    return await fn();
  } finally {
    await withPrivileged(async (c) => {
      await c.query(`DROP TRIGGER IF EXISTS zz_${schema} ON course_secrets.course_gemini_api_keys`);
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
}

/** Count of leftover fault-injection objects (expected 0 after every suite). */
export async function leftoverFaultObjects(): Promise<number> {
  return withPrivileged(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'byok\\_test\\_fault\\_%')
             + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'zz\\_byok\\_test\\_fault\\_%'))::int AS n`
    );
    return rows[0].n;
  });
}
