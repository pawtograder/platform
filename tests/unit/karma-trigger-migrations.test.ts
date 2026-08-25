/**
 * @jest-environment node
 *
 * Static drift guards for the two karma trigger defects fixed in
 * 20260825140000_audit_findings_2026_08.sql.
 *
 * The behavioural coverage lives in tests/e2e/karma-credit-and-notes-db.spec.ts, but
 * that lane is heavy. These assertions are cheap and run on every PR, and they read the
 * NEWEST migration that redefines each function — so they also fail if a future
 * migration reintroduces either bug, which is exactly how both of these shipped.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

/** Strip `--` line comments so prose explaining the bug can't satisfy the assertions. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The newest migration that redefines `functionName`, since CREATE OR REPLACE wins by order. */
function latestDefinitionOf(functionName: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // Deliberately loose: a later migration may use DROP + plain CREATE FUNCTION, omit the
  // public. prefix, or wrap before the paren. If this pattern missed such a migration the
  // guard would read an older file, pass, and report green while the bug was reinstalled.
  const needle = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${functionName}\\s*\\(`, "i");
  const match = files.filter((f) => needle.test(readFileSync(join(MIGRATIONS_DIR, f), "utf8"))).pop();
  if (!match) {
    throw new Error(`No migration defines public.${functionName}`);
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, match), "utf8");
  const body = sql.slice([...sql.matchAll(new RegExp(needle, "gi"))].pop()!.index);
  const end = body.indexOf("$$;");
  return stripSqlComments(end === -1 ? body : body.slice(0, end));
}

describe("broadcast_help_request_staff_data_change — student_karma_notes branch", () => {
  test("does not read help_request_id, a column student_karma_notes does not have", () => {
    const definition = latestDefinitionOf("broadcast_help_request_staff_data_change");
    const branchStart = definition.indexOf("ELSIF TG_TABLE_NAME = 'student_karma_notes' THEN");
    expect(branchStart).toBeGreaterThan(-1);
    const afterBranch = definition.indexOf("ELSIF TG_TABLE_NAME", branchStart + 1);
    const branch = definition.slice(branchStart, afterBranch === -1 ? undefined : afterBranch);

    // student_karma_notes is class-scoped: (student_profile_id, class_id), no help request.
    // Reading NEW/OLD.help_request_id here aborts every write to the table.
    expect(branch).not.toMatch(/\b(NEW|OLD)\.help_request_id\b/);
    // The branch must still set the payload key, so subscribers see a stable shape.
    expect(branch).toMatch(/help_request_id\s*:=\s*NULL/i);
  });

  test("is SECURITY DEFINER with a pinned search_path", () => {
    const definition = latestDefinitionOf("broadcast_help_request_staff_data_change");
    expect(definition).toMatch(/SECURITY DEFINER/);
    expect(definition).toMatch(/SET search_path/);
  });
});

describe("update_discussion_karma — credits the authoring profile", () => {
  test("does not normalize the public profile to the private profile", () => {
    const definition = latestDefinitionOf("update_discussion_karma");

    // Karma is per-identity by design. Normalizing the credit to
    // user_roles.private_profile_id makes karma earned on anonymous posts invisible
    // (bylines render the karma of `thread.author` verbatim), and surfacing that
    // cross-identity total on a pseudonymous byline would deanonymize the author by
    // correlation. Whole-student totals belong in get_discussion_engagement, which is
    // staff-only. See the migration header before changing this.
    expect(definition).not.toMatch(/private_profile_id/);
    expect(definition).not.toMatch(/user_roles/);
    // It must credit the raw thread author.
    expect(definition).toMatch(/SELECT\s+dt\.author\s+INTO\s+thread_author_id/);
  });
});

describe("transfer_discussion_karma_on_author_change — karma follows the post", () => {
  test("a trigger moves the count when discussion_threads.author changes", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const sql = files
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .filter((body) => body.includes("transfer_discussion_karma_on_author_change_trigger"))
      .pop();
    expect(sql).toBeDefined();
    const trigger = stripSqlComments(sql!).slice(
      stripSqlComments(sql!).indexOf("CREATE TRIGGER transfer_discussion_karma_on_author_change_trigger")
    );

    // Per-identity karma is only correct if it follows a post moved between a
    // student's two identities (e.g. staff toggling anonymity).
    expect(trigger).toMatch(/AFTER UPDATE OF author\s+ON public\.discussion_threads/);
    // `UPDATE OF author` fires whenever the column is in the statement's SET list,
    // even when the value is unchanged. The WHEN clause is what prevents double
    // counting on a no-op write, so it is not optional.
    expect(trigger).toMatch(/WHEN \(OLD\.author IS DISTINCT FROM NEW\.author\)/);
  });
});

describe("karma trigger concurrency invariants", () => {
  // A deterministic test for a race is not writable here without sleeps that pass by
  // luck, so these assert the two properties that were verified manually instead.
  // Manual reproduction of the deadlock (before the ordering fix): two psql workers
  // running 600 alternating `UPDATE discussion_threads SET author = ...` statements
  // each, on two threads owned by the same student in opposite directions, with
  // `SET enable_seqscan=off` to force the production plan. That produced 5 deadlocks
  // per 1200 transfers; with the ordering below it produces 0.
  test("the like path locks the thread row before reading its author", () => {
    const definition = latestDefinitionOf("update_discussion_karma");
    // Serializes a like against a concurrent author change. Today update_thread_likes
    // already write-locks this row, but the karma invariant must not depend on an
    // unrelated denormalized counter staying where it is.
    expect(definition).toMatch(/SELECT\s+dt\.author\s+INTO\s+thread_author_id[\s\S]*?FOR UPDATE/);
    expect(definition.match(/FOR UPDATE/g)).toHaveLength(2); // INSERT and DELETE paths
  });

  test("the transfer path debits and credits in a deterministic profile order", () => {
    const definition = latestDefinitionOf("transfer_discussion_karma_on_author_change");
    // A single UPDATE ... FROM (VALUES (OLD.author, ...), (NEW.author, ...)) locks in
    // OLD-then-NEW order under the production plan, so two transfers moving posts in
    // opposite directions between the same two profiles deadlock.
    expect(definition).not.toMatch(/FROM \(VALUES \(OLD\.author/);
    expect(definition).toMatch(/IF OLD\.author < NEW\.author THEN/);
  });
});

describe("get_discussion_engagement — staff-only cross-identity roll-up", () => {
  test("sums both profiles' karma and keeps the authorization guard", () => {
    const definition = latestDefinitionOf("get_discussion_engagement");
    // The only place allowed to sum a student's two identities.
    expect(definition).toMatch(/priv\.discussion_karma[^)]*\)\s*\+\s*COALESCE\(pub\.discussion_karma/);
    // ...precisely because it refuses non-staff callers.
    expect(definition).toMatch(/insufficient_privilege/);
    expect(definition).toMatch(/role IN \('instructor', 'grader'\)/);
  });
});
