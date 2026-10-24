/**
 * DB-level coverage for two RLS boundaries that failed silently.
 *
 * 1. public.audit had RLS enabled and NO policy. That is default-deny, and a default-denied SELECT
 *    returns zero rows and no error, so the instructor audit view rendered "0 Rows" and nothing
 *    logged a failure. 20251228143943_partitioned_audit_system.sql renamed the old audit table to
 *    audit_legacy and the `instructors read` policy followed it through the rename; the new
 *    partitioned table never got one back until
 *    20260825140000_audit_findings_2026_08.sql.
 *
 *    The positive assertion is the point here. A test that only checked "students cannot read the
 *    audit log" passed throughout the outage. This pins that an instructor CAN read their class.
 *
 * 2. assignment_leaderboard's SELECT policy led with `auth.uid() IS NULL`, so any holder of the
 *    anon key (public in a browser app) read every class's rows.
 *
 * Also pins the boundary that is deliberately open: an unauthenticated visitor must keep being able
 * to read a LIVE poll, because app/poll/[course_id]/page.tsx is a public QR-join page.
 * 20260817120000_tighten_survey_and_poll_rls.sql narrowed that policy once already; this guards
 * against a later "hardening" pass closing it and breaking the feature.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  type TestingUser
} from "./TestingUtils";

function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Marker written into audit."table" so assertions can find these rows and ignore trigger noise. */
const AUDIT_MARKER = `rls-probe-${Math.random().toString(36).slice(2)}`;

test.describe("audit + leaderboard RLS", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructorA: TestingUser;
  let studentA: TestingUser;
  let instructorB: TestingUser;

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Audit RLS A" });
    classB = await createClass({ name: "E2E Audit RLS B" });
    instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });

    // Seed audit rows in both classes via service_role, which bypasses RLS.
    const { error } = await supabase.from("audit").insert([
      { class_id: classA.id, table: AUDIT_MARKER, new: { probe: "class-a" } },
      { class_id: classB.id, table: AUDIT_MARKER, new: { probe: "class-b" } }
    ] as never);
    expect(error, "seeding audit rows should succeed as service_role").toBeNull();
  });

  test("an instructor can read their own class's audit rows", async () => {
    const authed = await createAuthenticatedClient(instructorA);
    const { data, error } = await authed
      .from("audit")
      .select("id, class_id, table")
      .eq("table", AUDIT_MARKER)
      .eq("class_id", classA.id);

    // The regression this exists for: no error, but zero rows.
    expect(error, "instructor audit read should not error").toBeNull();
    expect(data ?? [], "instructor must see their class's audit rows").not.toHaveLength(0);
  });

  test("an instructor cannot read another class's audit rows", async () => {
    const authed = await createAuthenticatedClient(instructorA);
    const { data, error } = await authed.from("audit").select("id, class_id").eq("table", AUDIT_MARKER);
    expect(error).toBeNull();
    const foreign = (data ?? []).filter((r) => r.class_id !== classA.id);
    expect(foreign, "instructor must not see other classes' audit rows").toHaveLength(0);
  });

  test("a student cannot read their class's audit rows", async () => {
    const authed = await createAuthenticatedClient(studentA);
    const { data, error } = await authed.from("audit").select("id").eq("table", AUDIT_MARKER);
    expect(error).toBeNull();
    expect(data ?? [], "audit log is instructor-only").toHaveLength(0);
  });

  test("an unauthenticated caller cannot read the audit log", async () => {
    const { data, error } = await anonClient().from("audit").select("id").eq("table", AUDIT_MARKER);
    expect(data ?? []).toHaveLength(0);
    if (error) expect(error.code).toBe("42501");
  });

  test("an unauthenticated caller cannot read the leaderboard, but an enrolled user can", async () => {
    const assignment = await insertAssignment({
      class_id: classA.id,
      name: "Leaderboard RLS Assignment",
      due_date: new Date(Date.now() + 86_400_000).toUTCString(),
      show_leaderboard: true
    });
    const { error: seedError } = await supabase.from("assignment_leaderboard").insert({
      assignment_id: assignment!.id,
      class_id: classA.id,
      public_profile_id: studentA.public_profile_id,
      autograder_score: 87,
      max_score: 100
    } as never);
    expect(seedError, "seeding a leaderboard row should succeed as service_role").toBeNull();

    // anon: the `auth.uid() IS NULL` leg used to return this row (and every other class's).
    const { data: anonRows, error: anonError } = await anonClient()
      .from("assignment_leaderboard")
      .select("id, class_id")
      .eq("class_id", classA.id);
    expect(anonRows ?? [], "anon must not read leaderboard rows").toHaveLength(0);
    if (anonError) expect(anonError.code).toBe("42501");

    // An enrolled member still can.
    const authed = await createAuthenticatedClient(studentA);
    const { data: memberRows, error: memberError } = await authed
      .from("assignment_leaderboard")
      .select("id, class_id")
      .eq("class_id", classA.id);
    expect(memberError).toBeNull();
    expect(memberRows ?? [], "an enrolled member must read their class's leaderboard").not.toHaveLength(0);

    // A member of a different class must not.
    const outsider = await createAuthenticatedClient(instructorB);
    const { data: outsiderRows } = await outsider.from("assignment_leaderboard").select("id").eq("class_id", classA.id);
    expect(outsiderRows ?? [], "another class's staff must not read this leaderboard").toHaveLength(0);
  });

  test("an unauthenticated caller CAN still read a live poll (public QR-join page)", async () => {
    const { data: poll, error: seedError } = await supabase
      .from("live_polls")
      .insert({
        class_id: classA.id,
        created_by: instructorA.public_profile_id,
        question: { elements: [{ type: "text", name: "q1", title: "Live?" }] },
        is_live: true,
        require_login: false
      } as never)
      .select("id")
      .single();
    expect(seedError).toBeNull();

    // app/poll/[course_id]/page.tsx issues exactly this, with select("*"), unauthenticated.
    // select("*") is load-bearing: a column-level grant on live_polls would make it fail 42501.
    const { data, error } = await anonClient()
      .from("live_polls")
      .select("*")
      .eq("class_id", classA.id)
      .eq("is_live", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(error, "the public poll page must not be broken by RLS/grant hardening").toBeNull();
    expect(data?.id, "anon must be able to read a live poll").toBe(poll!.id);

    // A poll that is not live stays hidden.
    await supabase.from("live_polls").update({ is_live: false }).eq("id", poll!.id);
    const { data: afterClose } = await anonClient().from("live_polls").select("id").eq("id", poll!.id);
    expect(afterClose ?? [], "a closed poll must not be readable by anon").toHaveLength(0);
  });
});
