/**
 * DB-level coverage for the access ceiling on the LTI service-internal tables
 * (lti_nonces — the OIDC replay-protection table — plus the grade-sync/identity
 * tables). A max-effort review found the chart migration runner (migrate.sh
 * Phase 3.5) was handing `anon`/`authenticated` blanket DML on these; the fix
 * excludes them. Because the GRANT layer is murky (Supabase's default privileges
 * auto-grant new tables in local/CLI environments), the property that actually
 * matters — and the one this test pins — is the EFFECTIVE one: RLS must reject
 * writes from anon and from a plain authenticated (non-service-role) user.
 *
 * Default per-PR lane (no Canvas); lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createClass, createUserInClass, createAuthenticatedClient } from "./TestingUtils";

const SERVICE_INTERNAL_TABLES = ["lti_nonces", "lti_users", "lti_grade_sync_state", "lti_grade_sync_queue"] as const;

/** Minimal NOT-NULL-satisfying insert payload per table. The row never lands — RLS
 *  (or a missing grant) rejects it first — so dummy FK values are fine. */
const sampleRow: Record<(typeof SERVICE_INTERNAL_TABLES)[number], Record<string, unknown>> = {
  lti_nonces: {
    nonce: `probe-${Math.random().toString(36).slice(2)}`,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  },
  lti_users: { platform_id: 999_999, sub: `probe-${Math.random().toString(36).slice(2)}` },
  lti_grade_sync_state: {
    class_id: 999_999,
    assignment_id: 999_999,
    student_profile_id: "00000000-0000-0000-0000-000000000000",
    status: "synced"
  },
  lti_grade_sync_queue: { assignment_id: 999_999, class_id: 999_999 }
};

async function expectWriteDenied(client: SupabaseClient<Database>, table: (typeof SERVICE_INTERNAL_TABLES)[number]) {
  const { data, error } = await client
    .from(table)
    .insert(sampleRow[table] as never)
    .select();
  // RLS denial surfaces as an error (or, if the grant is absent, "permission denied").
  // Either way: an error and no inserted row.
  expect(error, `${table} insert should be rejected`).not.toBeNull();
  expect(data ?? []).toHaveLength(0);
}

test.describe("LTI service-internal tables — anon & authenticated writes are denied by RLS", () => {
  test("anon cannot write the nonce / grade-sync / identity tables", async () => {
    const anon = createClient<Database>(
      process.env.SUPABASE_URL!,
      (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    for (const table of SERVICE_INTERNAL_TABLES) {
      await expectWriteDenied(anon, table);
    }
  });

  test("a plain authenticated (non-service-role) user cannot write them either", async () => {
    const course = await createClass({ name: "E2E LTI Grants" });
    const student = await createUserInClass({ role: "student", class_id: course.id });
    const authed = await createAuthenticatedClient(student);
    for (const table of SERVICE_INTERNAL_TABLES) {
      await expectWriteDenied(authed, table);
    }
  });
});
