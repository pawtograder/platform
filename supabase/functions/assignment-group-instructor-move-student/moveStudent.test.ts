/**
 * Unit tests for moveStudentBetweenGroups (assignment-group-instructor-move-student).
 *
 * Runs the move against an in-memory fake of both Supabase clients and records the GitHub jobs
 * (archive, permission sync) instead of enqueueing them. The fake enforces the two foreign keys
 * the move depends on, which are NO ACTION by design (see "Deleting repositories and
 * submissions" in AGENTS.md):
 *   - delete_repository_rows fails with 23503 while a submission references the repo;
 *   - deleting an assignment_groups row fails with 23503 while a repo or member references it.
 *
 * Covers: dissolving an empty group, keeping a group that has submissions (and revoking GitHub
 * access to its repo), syncing the remaining members, repo names containing a slash, rejecting a
 * move before changing anything, and finishing the move when a cleanup step or a GitHub enqueue
 * fails after the student has already been removed.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-read --allow-env assignment-group-instructor-move-student/
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { IllegalArgumentError } from "../_shared/HandlerUtils.ts";
import { moveStudentBetweenGroups, type MoveStudentDeps } from "./moveStudent.ts";

// ---- in-memory database -------------------------------------------------

type Member = {
  id: number;
  assignment_group_id: number;
  profile_id: string;
  assignment_id: number;
  class_id: number;
  added_by?: string;
};
type Group = { id: number; assignment_id: number; class_id: number; name: string };
type Repo = { id: number; assignment_group_id: number | null; repository: string };
type Submission = {
  id: number;
  assignment_id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
  repository_id: number | null;
  is_active: boolean;
};
type GroupChild = { id: number; assignment_group_id: number };
type PgError = { code: string; message: string };

const CLASS = { id: 10, slug: "cs3100-f26", github_org: "neu-cs3100" };
const ASSIGNMENT_ID = 100;
const INSTRUCTOR = "instructor-profile";

type FailOn =
  | "remaining_members"
  | "count_submissions"
  | "delete_repository_rows"
  | "delete_group"
  | "insert_member"
  | "new_group_members";

class FakeDb {
  members: Member[] = [];
  groups: Group[] = [];
  repos: Repo[] = [];
  submissions: Submission[] = [];
  invitations: GroupChild[] = [];
  joinRequests: GroupChild[] = [];
  githubUsernames = new Map<string, string | null>();
  failOn = new Set<FailOn>();
  /** Every call the move made to delete_repository_rows. */
  repoDeleteCalls: number[][] = [];
  private nextId = 1000;

  addGroup(id: number, opts: { repo?: string; repoId?: number } = {}) {
    this.groups.push({ id, assignment_id: ASSIGNMENT_ID, class_id: CLASS.id, name: `group-${id}` });
    if (opts.repo) {
      this.repos.push({ id: opts.repoId ?? id * 10, assignment_group_id: id, repository: opts.repo });
    }
  }

  addMember(groupId: number, profileId: string, githubUsername: string | null = `gh-${profileId}`) {
    this.members.push({
      id: this.nextId++,
      assignment_group_id: groupId,
      profile_id: profileId,
      assignment_id: ASSIGNMENT_ID,
      class_id: CLASS.id
    });
    this.githubUsernames.set(profileId, githubUsername);
  }

  addSubmission(s: Partial<Submission>) {
    this.submissions.push({
      id: this.nextId++,
      assignment_id: ASSIGNMENT_ID,
      profile_id: null,
      assignment_group_id: null,
      repository_id: null,
      is_active: true,
      ...s
    });
  }

  repoOf(groupId: number) {
    return this.repos.find((r) => r.assignment_group_id === groupId);
  }

  membersOf(groupId: number) {
    return this.members.filter((m) => m.assignment_group_id === groupId).map((m) => m.profile_id);
  }

  fk(message: string): PgError {
    return { code: "23503", message };
  }

  injected(what: FailOn): PgError {
    return { code: "XX000", message: `injected failure: ${what}` };
  }
}

type Filter = { col: string; val: unknown };

/** Parses the `.or("a.eq.1,b.eq.2")` strings the move builds. */
function parseOr(expr: string): Filter[] {
  return expr.split(",").map((part) => {
    const [col, op, ...rest] = part.split(".");
    assertEquals(op, "eq", `unsupported .or operator in ${expr}`);
    return { col, val: rest.join(".") };
  });
}

function matches(row: Record<string, unknown>, eqs: Filter[], ors: Filter[] | null) {
  const eqOk = eqs.every((f) => String(row[f.col]) === String(f.val));
  const orOk = ors === null || ors.some((f) => String(row[f.col]) === String(f.val));
  return eqOk && orOk;
}

/**
 * A query builder covering exactly the chains moveStudentBetweenGroups uses. It is thenable,
 * so `await query` and `await query.single()` both resolve.
 */
class FakeQuery {
  private op: "select" | "delete" | "insert" | "update" = "select";
  private columns = "*";
  private countHead = false;
  private eqs: Filter[] = [];
  private ors: Filter[] | null = null;
  private payload: Record<string, unknown> = {};

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(columns = "*", opts?: { count?: string; head?: boolean }) {
    this.columns = columns;
    this.countHead = !!opts?.head;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  insert(row: Record<string, unknown>) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = "update";
    this.payload = values;
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqs.push({ col, val });
    return this;
  }
  or(expr: string) {
    this.ors = parseOr(expr);
    return this;
  }
  single() {
    return this.run().then(({ data, error }) => {
      const rows = (data as unknown[] | null) ?? [];
      if (error) return { data: null, error };
      if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
      return { data: rows[0], error: null };
    });
  }
  then<T>(
    resolve: (v: { data: unknown; error: PgError | null; count?: number | null }) => T,
    reject?: (e: unknown) => T
  ) {
    return this.run().then(resolve, reject);
  }

  // deno-lint-ignore require-await
  private async run(): Promise<{ data: unknown; error: PgError | null; count?: number | null }> {
    const db = this.db;
    const filter = <R extends object>(rows: R[]) =>
      rows.filter((r) => matches(r as Record<string, unknown>, this.eqs, this.ors));

    switch (`${this.table}:${this.op}`) {
      case "assignment_groups_members:select": {
        if (this.columns.includes("assignment_groups(")) {
          const rows = filter(db.members).map((m) => {
            const group = db.groups.find((g) => g.id === m.assignment_group_id)!;
            return {
              ...m,
              assignments: { slug: "hw1" },
              classes: CLASS,
              assignment_groups: { ...group, repositories: db.repos.filter((r) => r.assignment_group_id === group.id) }
            };
          });
          return { data: rows, error: null };
        }
        const groupId = Number(this.eqs.find((f) => f.col === "assignment_group_id")?.val);
        const isNewGroupRead = db.members.some((m) => m.assignment_group_id === groupId && m.added_by === INSTRUCTOR);
        if (db.failOn.has(isNewGroupRead ? "new_group_members" : "remaining_members")) {
          return { data: null, error: db.injected(isNewGroupRead ? "new_group_members" : "remaining_members") };
        }
        const rows = filter(db.members).map((m) => ({
          ...m,
          profiles: { user_roles: { users: { github_username: db.githubUsernames.get(m.profile_id) ?? null } } }
        }));
        return { data: rows, error: null };
      }
      case "assignment_groups_members:delete": {
        const doomed = new Set(filter(db.members).map((m) => m.id));
        db.members = db.members.filter((m) => !doomed.has(m.id));
        return { data: null, error: null };
      }
      case "assignment_groups_members:insert": {
        if (db.failOn.has("insert_member")) return { data: null, error: db.injected("insert_member") };
        db.members.push({ id: 9999, ...(this.payload as Omit<Member, "id">) });
        return { data: null, error: null };
      }
      case "assignment_groups:select": {
        const rows = filter(db.groups).map((g) => ({
          ...g,
          repositories: db.repos.filter((r) => r.assignment_group_id === g.id),
          classes: { github_org: CLASS.github_org, slug: CLASS.slug }
        }));
        return { data: rows, error: null };
      }
      case "assignment_groups:delete": {
        if (db.failOn.has("delete_group")) return { data: null, error: db.injected("delete_group") };
        const doomed = filter(db.groups).map((g) => g.id);
        if (db.repos.some((r) => r.assignment_group_id !== null && doomed.includes(r.assignment_group_id))) {
          return { data: null, error: db.fk("repositories_assignment_group_id_fkey") };
        }
        if (db.members.some((m) => doomed.includes(m.assignment_group_id))) {
          return { data: null, error: db.fk("assignment_groups_members_assignment_group_id_fkey") };
        }
        db.groups = db.groups.filter((g) => !doomed.includes(g.id));
        return { data: null, error: null };
      }
      case "assignment_group_invitations:delete": {
        const doomed = new Set(filter(db.invitations).map((r) => r.id));
        db.invitations = db.invitations.filter((r) => !doomed.has(r.id));
        return { data: null, error: null };
      }
      case "assignment_group_join_request:delete": {
        const doomed = new Set(filter(db.joinRequests).map((r) => r.id));
        db.joinRequests = db.joinRequests.filter((r) => !doomed.has(r.id));
        return { data: null, error: null };
      }
      case "submissions:select": {
        assert(this.countHead, "the move only counts submissions");
        if (db.failOn.has("count_submissions")) {
          return { data: null, error: db.injected("count_submissions"), count: null };
        }
        return { data: null, error: null, count: filter(db.submissions).length };
      }
      case "submissions:update": {
        for (const s of filter(db.submissions)) Object.assign(s, this.payload);
        return { data: null, error: null };
      }
    }
    throw new Error(`fake supabase: unexpected ${this.op} on ${this.table}`);
  }
}

function makeClient(db: FakeDb) {
  return {
    from: (table: string) => new FakeQuery(db, table),
    // deno-lint-ignore require-await
    rpc: async (fn: string, args: { p_repository_ids: number[] }) => {
      assertEquals(fn, "delete_repository_rows", `unexpected rpc ${fn}`);
      db.repoDeleteCalls.push(args.p_repository_ids);
      if (db.failOn.has("delete_repository_rows")) {
        return { data: null, error: db.injected("delete_repository_rows") };
      }
      // Never deletes submissions: one that still references the repo blocks the delete.
      if (db.submissions.some((s) => s.repository_id !== null && args.p_repository_ids.includes(s.repository_id))) {
        return { data: null, error: db.fk("submissions_repository_id_fkey") };
      }
      db.repos = db.repos.filter((r) => !args.p_repository_ids.includes(r.id));
      return { data: args.p_repository_ids.length, error: null };
    }
  };
}

// ---- recorded GitHub jobs ------------------------------------------------

type ArchiveJob = { class_id: number; org: string; repo: string };
type SyncJob = { repo: string; githubUsernames: string[]; org: string; course_slug: string };

function harness(db: FakeDb, opts: { archiveThrows?: boolean; syncThrows?: boolean } = {}) {
  const archives: ArchiveJob[] = [];
  const syncs: SyncJob[] = [];
  const reported: unknown[] = [];
  const client = makeClient(db);
  const deps: MoveStudentDeps = {
    supabase: client as unknown as MoveStudentDeps["supabase"],
    adminSupabase: client as unknown as MoveStudentDeps["adminSupabase"],
    addedBy: INSTRUCTOR,
    // deno-lint-ignore require-await
    enqueueGithubArchiveRepo: async (class_id, org, repo) => {
      if (opts.archiveThrows) throw new Error("Failed to enqueue github archive repo");
      archives.push({ class_id, org, repo });
    },
    // deno-lint-ignore require-await
    enqueueSyncRepoPermissions: async ({ repo, githubUsernames, org, course_slug }) => {
      if (opts.syncThrows) throw new Error("Failed to enqueue sync repo permissions");
      syncs.push({ repo, githubUsernames: [...githubUsernames].sort(), org, course_slug });
    },
    reportError: (e) => reported.push(e)
  };
  return { deps, archives, syncs, reported };
}

function move(old_assignment_group_id: number | null, new_assignment_group_id: number | null, profile_id = "alice") {
  return { old_assignment_group_id, new_assignment_group_id, profile_id, class_id: CLASS.id };
}

const OLD_REPO = "neu-cs3100/cs3100-f26-hw1-group-1";
const NEW_REPO = "neu-cs3100/cs3100-f26-hw1-group-2";

/** Group 1 (alice alone, with a repo) and group 2 (bob, with a repo). */
function twoGroups() {
  const db = new FakeDb();
  db.addGroup(1, { repo: OLD_REPO });
  db.addGroup(2, { repo: NEW_REPO });
  db.addMember(1, "alice");
  db.addMember(2, "bob");
  return db;
}

// ---- last member leaves --------------------------------------------------

Deno.test("last member leaves a group with no submissions: repo deleted and archived, group dissolved", async () => {
  const db = twoGroups();
  db.invitations.push({ id: 1, assignment_group_id: 1 });
  db.joinRequests.push({ id: 1, assignment_group_id: 1 });
  const { deps, archives, syncs, reported } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, [[10]]);
  assertEquals(db.repoOf(1), undefined);
  assertEquals(
    db.groups.find((g) => g.id === 1),
    undefined
  );
  assertEquals(db.invitations, []);
  assertEquals(db.joinRequests, []);
  assertEquals(archives, [{ class_id: CLASS.id, org: CLASS.github_org, repo: "cs3100-f26-hw1-group-1" }]);
  // No sync for a repo that is gone; the destination is synced to its new member list.
  assertEquals(syncs, [
    { repo: NEW_REPO, githubUsernames: ["gh-alice", "gh-bob"], org: CLASS.github_org, course_slug: CLASS.slug }
  ]);
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported, []);
});

Deno.test(
  "last member leaves a group with a submission: group, repo and submission kept, GitHub access revoked",
  async () => {
    const db = twoGroups();
    db.addSubmission({ assignment_group_id: 1, repository_id: 10 });
    db.invitations.push({ id: 1, assignment_group_id: 1 });
    const { deps, archives, syncs, reported } = harness(db);

    await moveStudentBetweenGroups(move(1, 2), deps);

    // Nothing about the old group is deleted, and its repo is not archived.
    assertEquals(db.repoDeleteCalls, []);
    assert(db.groups.some((g) => g.id === 1));
    assertEquals(db.repoOf(1)?.repository, OLD_REPO);
    assertEquals(db.submissions.length, 1);
    assertEquals(db.submissions[0].is_active, true);
    assertEquals(db.invitations.length, 1);
    assertEquals(archives, []);
    // The kept repo is reconciled to nobody, which removes alice's collaborator access.
    assertEquals(syncs[0], { repo: OLD_REPO, githubUsernames: [], org: CLASS.github_org, course_slug: CLASS.slug });
    assertEquals(syncs[1].repo, NEW_REPO);
    assertEquals(db.membersOf(1), []);
    assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
    assertEquals(reported, []);
  }
);

Deno.test("a submission that references only the group (no repository_id) still keeps the group", async () => {
  const db = twoGroups();
  db.addSubmission({ assignment_group_id: 1 });
  const { deps, syncs } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, []);
  assert(db.repoOf(1));
  assertEquals(syncs[0], { repo: OLD_REPO, githubUsernames: [], org: CLASS.github_org, course_slug: CLASS.slug });
});

Deno.test("last member removed with no destination: group with a submission is kept and access revoked", async () => {
  const db = twoGroups();
  db.addSubmission({ assignment_group_id: 1, repository_id: 10 });
  const { deps, syncs, archives } = harness(db);

  await moveStudentBetweenGroups(move(1, null), deps);

  assert(db.repoOf(1));
  assertEquals(archives, []);
  assertEquals(syncs, [{ repo: OLD_REPO, githubUsernames: [], org: CLASS.github_org, course_slug: CLASS.slug }]);
  assertEquals(db.membersOf(2), ["bob"]);
});

Deno.test("last member leaves a group that never got a repo: group dissolved, no GitHub jobs for it", async () => {
  const db = new FakeDb();
  db.addGroup(1);
  db.addGroup(2, { repo: NEW_REPO });
  db.addMember(1, "alice");
  const { deps, archives, syncs } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, []);
  assertEquals(
    db.groups.find((g) => g.id === 1),
    undefined
  );
  assertEquals(archives, []);
  assertEquals(syncs, [
    { repo: NEW_REPO, githubUsernames: ["gh-alice"], org: CLASS.github_org, course_slug: CLASS.slug }
  ]);
});

Deno.test("archive uses everything after the first slash of a repo name that contains one", async () => {
  const db = new FakeDb();
  db.addGroup(1, { repo: "neu-cs3100/e2e-31/10/26-hw1-group-1" });
  db.addMember(1, "alice");
  const { deps, archives } = harness(db);

  await moveStudentBetweenGroups(move(1, null), deps);

  assertEquals(
    archives.map((a) => a.repo),
    ["e2e-31/10/26-hw1-group-1"]
  );
});

// ---- other members remain ------------------------------------------------

Deno.test("a member leaves a group that still has members: repo synced to the rest, group untouched", async () => {
  const db = twoGroups();
  db.addMember(1, "carol");
  db.addMember(1, "dave", null); // no GitHub username: cannot be a collaborator
  const { deps, archives, syncs } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, []);
  assert(db.repoOf(1));
  assertEquals(archives, []);
  assertEquals(syncs[0], {
    repo: OLD_REPO,
    githubUsernames: ["gh-carol"],
    org: CLASS.github_org,
    course_slug: CLASS.slug
  });
  assertEquals(db.membersOf(1).sort(), ["carol", "dave"]);
});

// ---- joining from no group -----------------------------------------------

Deno.test("joining a group from no group deactivates the student's individual submissions", async () => {
  const db = twoGroups();
  db.members = db.members.filter((m) => m.profile_id !== "alice");
  db.addSubmission({ profile_id: "alice" });
  db.addSubmission({ profile_id: "bob" });
  const { deps, syncs } = harness(db);

  await moveStudentBetweenGroups(move(null, 2), deps);

  assertEquals(db.submissions.find((s) => s.profile_id === "alice")?.is_active, false);
  assertEquals(db.submissions.find((s) => s.profile_id === "bob")?.is_active, true);
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(db.members.find((m) => m.profile_id === "alice")?.added_by, INSTRUCTOR);
  assertEquals(syncs, [
    { repo: NEW_REPO, githubUsernames: ["gh-alice", "gh-bob"], org: CLASS.github_org, course_slug: CLASS.slug }
  ]);
});

// ---- rejected before anything changes ------------------------------------

Deno.test("student not in the old group: rejected, nothing changed", async () => {
  const db = twoGroups();
  const before = structuredClone(db.members);
  const { deps, archives, syncs } = harness(db);

  await assertRejects(() => moveStudentBetweenGroups(move(1, 2, "mallory"), deps), IllegalArgumentError);

  assertEquals(db.members, before);
  assertEquals(archives, []);
  assertEquals(syncs, []);
});

Deno.test("destination group does not exist: rejected before the student leaves the old group", async () => {
  const db = twoGroups();
  const { deps, archives, syncs } = harness(db);

  await assertRejects(() => moveStudentBetweenGroups(move(1, 999), deps), IllegalArgumentError);

  assertEquals(db.membersOf(1), ["alice"]);
  assert(db.repoOf(1));
  assertEquals(archives, []);
  assertEquals(syncs, []);
});

// ---- failures after the removal never strand the student -----------------

Deno.test("delete_repository_rows fails: group and repo kept, access revoked, move completes", async () => {
  const db = twoGroups();
  db.failOn.add("delete_repository_rows");
  const { deps, archives, syncs, reported } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assert(db.groups.some((g) => g.id === 1));
  assert(db.repoOf(1));
  assertEquals(archives, []);
  assertEquals(syncs[0], { repo: OLD_REPO, githubUsernames: [], org: CLASS.github_org, course_slug: CLASS.slug });
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported.length, 1);
});

Deno.test("counting submissions fails: group treated as having submissions and kept", async () => {
  const db = twoGroups();
  db.failOn.add("count_submissions");
  const { deps, archives, syncs, reported } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, []);
  assert(db.repoOf(1));
  assertEquals(archives, []);
  assertEquals(syncs[0], { repo: OLD_REPO, githubUsernames: [], org: CLASS.github_org, course_slug: CLASS.slug });
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported.length, 1);
});

Deno.test("reading the remaining members fails: old group left as is, move completes", async () => {
  const db = twoGroups();
  db.failOn.add("remaining_members");
  const { deps, archives, syncs, reported } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.repoDeleteCalls, []);
  assert(db.groups.some((g) => g.id === 1));
  assertEquals(archives, []);
  assertEquals(
    syncs.map((s) => s.repo),
    [NEW_REPO]
  );
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported.length, 1);
});

Deno.test("archive enqueue throws: reported, group still dissolved, move completes", async () => {
  const db = twoGroups();
  const { deps, archives, reported } = harness(db, { archiveThrows: true });

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(archives, []);
  assertEquals(db.repoOf(1), undefined);
  assertEquals(
    db.groups.find((g) => g.id === 1),
    undefined
  );
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported.length, 1);
});

Deno.test("permission sync enqueue throws: reported, move completes", async () => {
  const db = twoGroups();
  db.addMember(1, "carol");
  const { deps, reported } = harness(db, { syncThrows: true });

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.membersOf(1), ["carol"]);
  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  // One for the old repo's sync, one for the new repo's.
  assertEquals(reported.length, 2);
});

Deno.test("deleting the empty group fails: reported, move completes", async () => {
  const db = twoGroups();
  db.failOn.add("delete_group");
  const { deps, reported } = harness(db);

  await moveStudentBetweenGroups(move(1, 2), deps);

  assertEquals(db.membersOf(2).sort(), ["alice", "bob"]);
  assertEquals(reported.length, 1);
});

Deno.test("adding to the new group fails: the error surfaces", async () => {
  const db = twoGroups();
  db.failOn.add("insert_member");
  const { deps } = harness(db);

  await assertRejects(() => moveStudentBetweenGroups(move(1, 2), deps), Error, "Failed to add member to group");
});
