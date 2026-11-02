/**
 * Hermetic tests for the engine's write half (docs/handout-sync-git-worker.md §5.5–§5.8, §6.1,
 * §8.3; build plan WP2): resolving files to index updates, the tree, the deterministic commit, the
 * leased push, crash convergence, determinism and cross-student isolation.
 *
 * Every case runs the real engine against `file://` remotes and then reads the result back out
 * of the remote, so "the file was merged" means the pushed commit holds the merged bytes.
 *
 * Run from supabase/functions with a Deno that can spawn git:
 *   deno test --allow-read --allow-write --allow-run --allow-env _shared/gitSync/enginePlan.test.ts
 */
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@^1";
import { SYNC_COMMIT_SUBJECT_RE } from "../handoutSyncPush.ts";
import {
  type CommitPlan,
  planHandoutSync,
  type PushOptions,
  type PushResult,
  type SyncInput,
  type SyncJobContext,
  type SyncPhase,
  type SyncPlan,
  syncCommitMessage,
  withSyncJob
} from "./engine.ts";
import { GitSyncError } from "./errors.ts";
import { TemplateCache } from "./templateCache.ts";
import {
  binary,
  fixtureGit,
  type FixtureRepo,
  GitFixture,
  listTree,
  omit,
  R,
  shouldSkipRealGit,
  type Snapshot,
  spawnsTo,
  T,
  text,
  world,
  verdicts,
  type World
} from "./testFixtures.ts";

const SKIP = await shouldSkipRealGit("enginePlan.test.ts");

function gitTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: SKIP, fn });
}

const REFUSE: PushOptions = {
  confirmResetSafe: ({ head }) => Promise.reject(new Error(`unexpected reset of ${head}`))
};

interface SyncRun {
  plan: SyncPlan;
  push: PushResult | null;
  ctx: ReturnType<GitFixture["jobContext"]>;
}

/** Plans and, for a commit plan, pushes, in one job. */
async function sync(
  fx: GitFixture,
  input: SyncInput,
  overrides: Partial<SyncJobContext> = {},
  opts: PushOptions = REFUSE
): Promise<SyncRun> {
  const ctx = fx.jobContext(overrides);
  const { plan, push } = await withSyncJob(ctx, async (job) => {
    const plan = await job.plan(input);
    const push = plan.kind === "commit" ? await job.push(plan, opts) : null;
    return { plan, push };
  });
  return { plan, push, ctx };
}

function commitPlan(plan: SyncPlan): CommitPlan {
  assertEquals(plan.kind, "commit");
  return plan as CommitPlan;
}

function branchRef(w: World): string {
  return `refs/heads/sync-to-${w.H.slice(0, 7)}`;
}

/** `path -> mode` for the blobs of a commit on a remote. */
async function modes(repo: FixtureRepo, commit: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, meta] of Object.entries(await repo.lsTree(commit))) {
    const [mode, type] = meta.split(" ");
    if (type === "blob") out[path] = mode;
  }
  return out;
}

const TEXT_BEFORE = "line1\nline2\nline3\nline4\nline5\nline6\n";
const TEXT_AFTER = "line1\nline2\nline3\nline4\nline5\nline6\nline7 from the handout\n";

// ---------------------------------------------------------------------------------------------
// §5.5: each file to an index update
// ---------------------------------------------------------------------------------------------

gitTest("§5.5 write rows: untouched modify, add and delete land as the handout's blobs", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "m.txt": "1\n", "d.txt": "d\n", "img.png": binary(1), "keep.txt": "k\n" },
      after: { "m.txt": "2\n", "a.txt": "a\n", "img.png": binary(2), "keep.txt": "k\n" }
    });
    const { plan, push } = await sync(fx, w.input);
    const p = commitPlan(plan);
    assertEquals(push, { pushed: true, previousHead: null });
    assertEquals(await w.student.ref(branchRef(w)), p.commit);
    // Every handout blob, and the student's untouched file, are exactly the handout's tree.
    assertEquals(p.tree, await w.template.treeOf(w.H));
    assertEquals(p.unresolved, []);
    assertEquals(p.changedFiles, ["a.txt", "d.txt", "img.png", "m.txt"]);
  });
});

gitTest(
  "§5.5 handout-owned path: grade.yml lands with the handout's content and mode over a student file",
  async () => {
    const GRADE = ".github/workflows/grade.yml";
    await GitFixture.with(async (fx) => {
      const w = await world(fx, {
        before: { "x.txt": "x\n" },
        after: { "x.txt": "x\n", [GRADE]: "on: push\n" },
        student: (b) => ({ ...b, [GRADE]: { content: "mine\n", mode: "100755" } })
      });
      const p = commitPlan((await sync(fx, w.input)).plan);
      assertEquals(await w.student.show(p.commit, GRADE), "on: push\n");
      assertEquals((await modes(w.student, p.commit))[GRADE], "100644");
      assertEquals(p.unresolved, []);
    });
    await GitFixture.with(async (fx) => {
      const w = await world(fx, {
        before: { "x.txt": "x\n", [GRADE]: "on: push\n" },
        after: { "x.txt": "x\n" },
        student: (b) => ({ ...b, [GRADE]: "on: push\n# mine\n" })
      });
      const p = commitPlan((await sync(fx, w.input)).plan);
      assert(!(GRADE in (await modes(w.student, p.commit))), "grading off removes the student's edited workflow");
    });
  }
);

gitTest("§5.5 attempt_patch: a clean merge carries both changes and keeps the student's mode", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "src/user.service.ts": TEXT_BEFORE },
      after: { "src/user.service.ts": TEXT_AFTER },
      student: (b) => ({
        ...b,
        "src/user.service.ts": { content: TEXT_BEFORE.replace("line1", "my line1"), mode: "100755" }
      })
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(await w.student.show(p.commit, "src/user.service.ts"), TEXT_AFTER.replace("line1", "my line1"));
    assertEquals((await modes(w.student, p.commit))["src/user.service.ts"], "100755");
    assertEquals(p.unresolved, []);
    assertEquals(p.changedFiles, ["src/user.service.ts"]);
  });
});

gitTest("§5.5 attempt_patch: a conflict leaves the student's file and reports content_differs", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.ts": TEXT_BEFORE, "b.txt": "b\n" },
      after: { "a.ts": TEXT_BEFORE.replace("line6", "handout line6"), "b.txt": "B\n" },
      student: (b) => ({ ...b, "a.ts": TEXT_BEFORE.replace("line6", "student line6") })
    });
    const { plan } = await sync(fx, w.input);
    const p = commitPlan(plan);
    assertEquals(p.unresolved, [{ path: "a.ts", reason: "content_differs" }]);
    assertEquals(await w.student.show(p.commit, "a.ts"), TEXT_BEFORE.replace("line6", "student line6"));
    assertEquals(await w.student.show(p.commit, "b.txt"), "B\n");
    assertEquals(p.analysis.tags.merge_file_conflicts, "1");
    // The message lists the file the sync tried to merge, as today's syncableFiles does.
    assertEquals(p.changedFiles, ["a.ts", "b.txt"]);
  });
});

gitTest("§5.5 merge cap: a blob over maxMergeBytes is never merged and is tagged", async () => {
  await GitFixture.with(async (fx) => {
    const big = "x\n".repeat(4096);
    const w = await world(fx, {
      before: { "big.txt": big, "b.txt": "b\n" },
      after: { "big.txt": big + "handout\n", "b.txt": "B\n" },
      student: (b) => ({ ...b, "big.txt": "student\n" + big })
    });
    const { plan, ctx } = await sync(fx, w.input, { maxMergeBytes: 1024 });
    const p = commitPlan(plan);
    assertEquals(p.unresolved, [{ path: "big.txt", reason: "content_differs" }]);
    assertEquals(p.analysis.tags.merge_file_too_large, "1");
    assertEquals(
      ctx.spawns.filter((a) => a.includes("merge-file")),
      [],
      "merge-file must not be spawned"
    );
  });
});

gitTest("§5.5 (spec §6.5): a 2 MB text file the student edited is merged under the default cap", async () => {
  await GitFixture.with(async (fx) => {
    const lines = Array.from({ length: 220_000 }, (_, i) => `row ${i}\n`).join("");
    assert(lines.length > 2 * 1024 * 1024, `fixture is ${lines.length} bytes`);
    const w = await world(fx, {
      before: { "data.csv": lines },
      after: { "data.csv": lines + "row from handout\n" },
      student: (b) => ({ ...b, "data.csv": "student header\n" + lines })
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(p.unresolved, []);
    assertEquals(await w.student.show(p.commit, "data.csv"), "student header\n" + lines + "row from handout\n");
  });
});

gitTest("§5.3/§5.5: a NUL-free .pdf is binary, so a student edit is skipped, never merged", async () => {
  await GitFixture.with(async (fx) => {
    const pdf = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n";
    const w = await world(fx, {
      before: { "doc.pdf": pdf },
      after: { "doc.pdf": pdf + "% handout\n" },
      student: (b) => ({ ...b, "doc.pdf": "% student\n" + pdf })
    });
    const { plan, ctx } = await sync(fx, w.input);
    assertEquals(plan.kind, "nothing_survived");
    const f = plan.analysis.files[0];
    assertEquals([f.change.isBinary, f.change.hasPatch, f.action], [true, false, "skip"]);
    assertEquals(
      ctx.spawns.filter((a) => a.includes("merge-file")),
      []
    );
  });
});

gitTest("§5.5 merge-file timeout or error degrades that one file to the student", async () => {
  await GitFixture.with(async (fx) => {
    const big = Array.from({ length: 200_000 }, (_, i) => `line ${i}\n`).join("");
    const w = await world(fx, {
      before: { "slow.txt": big, "binary-now.txt": TEXT_BEFORE, "b.txt": "b\n" },
      after: { "slow.txt": big.replace("line 5\n", "handout 5\n"), "binary-now.txt": TEXT_AFTER, "b.txt": "B\n" },
      student: (b) => ({
        ...b,
        "slow.txt": big.replace("line 199990\n", "student\n"),
        // The student's copy is binary while both handout sides are text: merge-file exits 255.
        "binary-now.txt": binary(3, 128)
      })
    });
    const { plan } = await sync(fx, w.input, { mergeFileTimeoutMs: 1 });
    const p = commitPlan(plan);
    assertEquals(p.unresolved, [
      { path: "binary-now.txt", reason: "content_differs" },
      { path: "slow.txt", reason: "content_differs" }
    ]);
    assertEquals(p.analysis.tags.merge_file_failed, "2");
    assertEquals(await w.student.show(p.commit, "b.txt"), "B\n");
  });
});

gitTest(
  "§5.5.1 modes: a handout chmod on an untouched script is delivered; a student's chmod survives a merge",
  async () => {
    await GitFixture.with(async (fx) => {
      const w = await world(fx, {
        before: { "build.sh": "make\n", "run.sh": TEXT_BEFORE },
        after: { "build.sh": { content: "make\n", mode: "100755" }, "run.sh": TEXT_AFTER },
        student: (b) => ({ ...b, "run.sh": { content: TEXT_BEFORE, mode: "100755" } })
      });
      const p = commitPlan((await sync(fx, w.input)).plan);
      const m = await modes(w.student, p.commit);
      assertEquals([m["build.sh"], m["run.sh"]], ["100755", "100755"]);
      assertEquals(await w.student.show(p.commit, "run.sh"), TEXT_AFTER);
    });
  }
);

// ---------------------------------------------------------------------------------------------
// §5.6: the tree
// ---------------------------------------------------------------------------------------------

gitTest("§5.6: directory to file and file to directory build the handout's shape, removals first", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "foo/a.txt": "a\n", "foo/b.txt": "b\n", config: "old\n", "mine-untouched.txt": "m\n" },
      after: { foo: "now a file\n", "config/settings.ts": "export {}\n", "mine-untouched.txt": "m\n" }
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(p.tree, await w.template.treeOf(w.H));
  });
});

gitTest("§5.6: a blocked directory swap keeps the student's tree and still applies the removals", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "foo/a.txt": "a\n", "x.txt": "x\n" },
      after: { foo: "now a file\n", "x.txt": "X\n" },
      student: (b) => ({ ...b, "foo/mine.txt": "work\n" })
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(Object.keys(await modes(w.student, p.commit)).sort(), ["foo/mine.txt", "x.txt"]);
    assertEquals(p.unresolved, [{ path: "foo", reason: "directory_in_your_repo" }]);
  });
});

gitTest("§5.6 nothing survived: every file the student's, no commit, no branch", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.ts": TEXT_BEFORE, "img.png": binary(1), "gone.txt": "g\n" },
      after: { "a.ts": TEXT_BEFORE.replace("line3", "handout 3"), "img.png": binary(2) },
      student: (b) => ({
        ...omit(b, "gone.txt"),
        "a.ts": TEXT_BEFORE.replace("line3", "student 3"),
        "img.png": binary(3)
      })
    });
    const ctx = fx.jobContext();
    const { plan, recheck } = await withSyncJob(ctx, async (job) => {
      const plan = await job.plan(w.input);
      assertEquals(plan.kind, "nothing_survived");
      const recheck = await job.classifyPathsAgainstHead(
        plan.analysis,
        plan.kind === "nothing_survived" ? plan.unresolved.map((f) => f.path) : []
      );
      return { plan, recheck };
    });
    assert(plan.kind === "nothing_survived");
    // The handout deleting a file the student already deleted is a noop, not unresolved.
    assertEquals(plan.unresolved, [
      { path: "a.ts", reason: "content_differs" },
      { path: "img.png", reason: "content_differs" }
    ]);
    assertEquals([...recheck.stillDiffering.keys()], ["a.ts", "img.png"]);
    assertEquals(spawnsTo(ctx, fx, R, "push"), []);
    assertEquals(await w.student.ref(branchRef(w)), null);
  });
});

// ---------------------------------------------------------------------------------------------
// §5.7: the commit
// ---------------------------------------------------------------------------------------------

gitTest("§5.7: the commit is S's child with the bot identity, H's date and today's message", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n", "b.txt": "b\n" },
      after: { "a.txt": "A\n", "c.txt": "c\n" }
    });
    const { plan, ctx } = await sync(fx, w.input);
    const p = commitPlan(plan);
    assertEquals(p.parent, w.S);
    const raw = text(await w.student.git(["cat-file", "commit", p.commit]));
    const [header, ...body] = raw.split("\n\n");
    const id = `${ctx.identity.name} <${ctx.identity.email}> 1700000500 -0500`;
    assertEquals(header.split("\n"), [`tree ${p.tree}`, `parent ${w.S}`, `author ${id}`, `committer ${id}`]);
    const message = body.join("\n\n");
    assertEquals(message, p.message);
    assertEquals(
      message,
      `Sync handout updates to ${w.H.slice(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
- a.txt
- b.txt
- c.txt`
    );
    assertEquals(message, syncCommitMessage(w.H, ["a.txt", "b.txt", "c.txt"]));
    assertMatch(message.split("\n")[0], SYNC_COMMIT_SUBJECT_RE);
  });
});

gitTest("§5.7: the parent is S even when main has moved on, so GitHub's PR merge handles later work", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n", "b.txt": "b\n" },
      after: { "a.txt": "A\n", "b.txt": "b\n" }
    });
    const later = await w.student.commitOn("main", { "a.txt": "a\n", "b.txt": "student after sync\n" });
    const { plan } = await sync(fx, w.input);
    const p = commitPlan(plan);
    assertEquals([p.parent, p.analysis.mainSha], [w.S, later]);
    assertEquals(text(await w.student.git(["rev-parse", `${p.commit}^`])), w.S);
    // The branch carries S's b.txt; the student's later edit arrives through the merge.
    assertEquals(await w.student.show(p.commit, "b.txt"), "b\n");
  });
});

// Git's bare `<secs> <tz>` parser refuses dates outside ~1973-2100, and git writes a `-0000` zone
// as `+0000`. H's date is copied verbatim out of its commit object, so each of these has to commit,
// and do so deterministically.
for (const [date, stored] of [
  ["86400 +0000", "86400 +0000"],
  ["99999999 +0000", "99999999 +0000"],
  ["4102444800 +0000", "4102444800 +0000"],
  ["1700000500 -0000", "1700000500 +0000"]
] as const) {
  gitTest(`§5.7: a handout commit dated "${date}" builds the same commit on every run`, async () => {
    await GitFixture.with(async (fx) => {
      const template = await fx.createRepo(T);
      const F = await template.commitOn("main", { "a.txt": "a\n" });
      const tree = await template.treeOf(await template.commit({ "a.txt": "A\n" }));
      // Written as a raw object so the header carries exactly `date`, which git itself would not
      // write for -0000.
      const raw = `tree ${tree}\nparent ${F}\nauthor I <i@x> ${date}\ncommitter I <i@x> ${date}\n\nv2\n`;
      const H = text(await template.git(["hash-object", "-t", "commit", "-w", "--stdin"], { stdin: raw }));
      await template.setRef("refs/heads/main", H);
      const student = await fx.createRepo(R);
      const S = await student.commitOn("main", { "a.txt": "a\n" });
      const input = { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R };
      assertEquals((await sync(fx, input, {}, REFUSE)).plan.analysis.handoutCommitDate, date);
      const commits: string[] = [];
      for (let i = 0; i < 2; i++) {
        const plan = await planHandoutSync(
          input,
          fx.jobContext({ templateCache: new TemplateCache(`${fx.root}/c${i}`) })
        );
        commits.push(commitPlan(plan).commit);
      }
      assertEquals(commits[0], commits[1]);
      assertEquals(await student.ref(`refs/heads/sync-to-${H.slice(0, 7)}`), commits[0]);
      const header = text(await student.git(["cat-file", "commit", commits[0]]));
      assert(header.includes(`> ${stored}\ncommitter `) && header.includes(`> ${stored}\n\n`), header);
    });
  });
}

gitTest("determinism: fresh job dirs and a fresh cache build the identical commit", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.ts": TEXT_BEFORE, "d.txt": "d\n", "img.png": binary(1) },
      after: { "a.ts": TEXT_AFTER, "img.png": binary(2), "n.txt": "n\n" },
      student: (b) => ({ ...b, "a.ts": TEXT_BEFORE.replace("line1", "mine") })
    });
    const shas: string[] = [];
    for (let i = 0; i < 2; i++) {
      const plan = await planHandoutSync(
        w.input,
        fx.jobContext({ templateCache: new TemplateCache(`${fx.root}/cache-${i}`) })
      );
      shas.push(commitPlan(plan).commit);
    }
    assertEquals(shas[0], shas[1]);
  });
});

gitTest("planHandoutSync (shadow mode) never reads or writes the sync branch", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    const ctx = fx.jobContext();
    const plan = commitPlan(await planHandoutSync(w.input, ctx));
    assertEquals(plan.tree, await w.template.treeOf(w.H));
    assertEquals(spawnsTo(ctx, fx, R, "push"), []);
    assertEquals(spawnsTo(ctx, fx, R, "ls-remote"), []);
    assertEquals(await w.student.ref(branchRef(w)), null);
  });
});

gitTest("spec §6.5: on a rewritten handout a modified file merges against F's blob", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const F = await template.commitOn("old-main", { "a.ts": TEXT_BEFORE });
    const H = await template.commit({ "a.ts": TEXT_AFTER }, { message: "rewritten\n" });
    await template.setRef("refs/heads/main", H);
    const student = await fx.createRepo(R);
    await student.commitOn("main", { "a.ts": TEXT_BEFORE });
    const S = await student.commitOn("main", { "a.ts": TEXT_BEFORE.replace("line2", "mine") });
    const p = commitPlan(
      (await sync(fx, { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R })).plan
    );
    assertEquals(verdicts(p.analysis.files), { "a.ts": "modified content_differs attempt_patch" });
    assertEquals(await student.show(p.commit, "a.ts"), TEXT_AFTER.replace("line2", "mine"));
  });
});

// ---------------------------------------------------------------------------------------------
// Parity findings from the round-A policy review
// ---------------------------------------------------------------------------------------------

gitTest("parity: a BOM-prefixed path is its own path on both sides, never collapsed onto its twin", async () => {
  const BOM = "\uFEFFfoo.txt";
  await GitFixture.with(async (fx) => {
    // The handout adds the BOM path next to an untouched foo.txt.
    const w = await world(fx, { before: { "foo.txt": "plain\n" }, after: { "foo.txt": "plain\n", [BOM]: "bom\n" } });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files), { [BOM]: "added - write" });
    assertEquals(await w.student.show(p.commit, "foo.txt"), "plain\n");
    assertEquals(p.tree, await w.template.treeOf(w.H));
  });
  await GitFixture.with(async (fx) => {
    // The student's own BOM file must not read as their edit of foo.txt.
    const w = await world(fx, {
      before: { "foo.txt": "v1\n" },
      after: { "foo.txt": "v2\n" },
      student: (b) => ({ ...b, [BOM]: "mine\n" })
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files), { "foo.txt": "modified - write" });
    assertEquals(await w.student.show(p.commit, BOM), "mine\n");
  });
});

gitTest("parity: a mode-only handout change is not merged into a student's edit; it is left and listed", async () => {
  const before: Snapshot = { "build.sh": "make\n" };
  const after: Snapshot = { "build.sh": { content: "make\n", mode: "100755" } };
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after, student: (b) => ({ ...b, "build.sh": "make all\n" }) });
    const { plan, ctx } = await sync(fx, w.input);
    assertEquals(verdicts(plan.analysis.files), { "build.sh": "modified content_differs skip" });
    assert(plan.kind === "nothing_survived");
    // Listed, so resolveAutoMerge holds the PR open.
    assertEquals(plan.unresolved, [{ path: "build.sh", reason: "content_differs" }]);
    assertEquals(
      ctx.spawns.filter((a) => a.includes("merge-file")),
      []
    );
  });
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files), { "build.sh": "modified - write" });
    assertEquals((await modes(w.student, p.commit))["build.sh"], "100755");
  });
});

gitTest("parity: a handout truncating a file to 0 bytes is a deletion-shaped patch", async () => {
  const before: Snapshot = { "a.txt": "content\n", "keep.txt": "k\n" };
  const after: Snapshot = { "a.txt": "", "keep.txt": "K\n" };
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after, student: (b) => omit(b, "a.txt") });
    const a = (await sync(fx, w.input)).plan.analysis;
    assertEquals(verdicts(a.files)["a.txt"], "modified deleted_in_your_repo noop");
    assertEquals(a.files.find((f) => f.change.path === "a.txt")!.change.patchDeletesFile, true);
  });
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after, student: (b) => ({ ...b, "a.txt": "mine\n" }) });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files)["a.txt"], "modified content_differs skip");
    assertEquals(p.unresolved, [{ path: "a.txt", reason: "content_differs" }]);
  });
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files)["a.txt"], "modified - write");
    assertEquals(await w.student.show(p.commit, "a.txt"), "");
  });
});

gitTest("parity: symlinks the student retargeted are left to them", async () => {
  await GitFixture.with(async (fx) => {
    // The handout retargets a link the student also retargeted: a one-line conflict.
    const w = await world(fx, {
      before: { link: { content: "a", mode: "120000" } },
      after: { link: { content: "b", mode: "120000" } },
      student: (b) => ({ ...b, link: { content: "c", mode: "120000" } })
    });
    const { plan } = await sync(fx, w.input);
    assertEquals(verdicts(plan.analysis.files), { link: "modified content_differs attempt_patch" });
    assert(plan.kind === "nothing_survived");
    assertEquals(plan.unresolved, [{ path: "link", reason: "content_differs" }]);
  });
  await GitFixture.with(async (fx) => {
    // The handout turns a link into a regular file; the student had retargeted the link.
    const w = await world(fx, {
      before: { link: { content: "target", mode: "120000" } },
      after: { link: "now a file\n" },
      student: (b) => ({ ...b, link: { content: "elsewhere", mode: "120000" } })
    });
    const { plan } = await sync(fx, w.input);
    assertEquals(verdicts(plan.analysis.files), { link: "modified content_differs skip" });
  });
});

gitTest("parity: case-distinct paths are distinct paths", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "Readme.md": "r\n" },
      after: { "Readme.md": "r\n", "README.md": "R\n" },
      student: (b) => ({ ...b, "readme.md": "mine\n" })
    });
    const p = commitPlan((await sync(fx, w.input)).plan);
    assertEquals(verdicts(p.analysis.files), { "README.md": "added - write" });
    const m = await modes(w.student, p.commit);
    assertEquals(Object.keys(m).sort(), ["README.md", "Readme.md", "readme.md"]);
  });
});

gitTest("parity: a file the student pre-added identically, with F set, is still theirs", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n" },
      after: { "a.txt": "a\n", "new.txt": "n\n" },
      student: (b) => ({ ...b, "new.txt": "n\n" })
    });
    const { plan } = await sync(fx, w.input);
    assertEquals(verdicts(plan.analysis.files), { "new.txt": "added only_in_your_repo skip" });
    assert(plan.kind === "nothing_survived");
  });
});

// ---------------------------------------------------------------------------------------------
// §5.8: the push
// ---------------------------------------------------------------------------------------------

async function simpleWorld(fx: GitFixture): Promise<World> {
  return await world(fx, {
    before: { "a.txt": "a\n", "b.txt": "b\n" },
    after: { "a.txt": "A\n", "b.txt": "b\n" },
    student: (b) => ({ ...b, "notes.md": "mine\n" })
  });
}

gitTest("§5.8 absent: the branch is created with an empty lease", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const { plan, push, ctx } = await sync(fx, w.input);
    assertEquals(push, { pushed: true, previousHead: null });
    assertEquals(await w.student.ref(branchRef(w)), commitPlan(plan).commit);
    const pushArgv = spawnsTo(ctx, fx, R, "push")[0];
    assert(pushArgv.includes(`--force-with-lease=${branchRef(w)}:`), pushArgv.join(" "));
  });
});

gitTest("§5.8 == S: the branch a previous attempt created at the base is leased from S", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    await w.student.setRef(branchRef(w), w.S);
    const { plan, push } = await sync(fx, w.input);
    assertEquals(push, { pushed: true, previousHead: w.S });
    assertEquals(await w.student.ref(branchRef(w)), commitPlan(plan).commit);
  });
});

gitTest("§5.8 == COMMIT: a retry of a job that already pushed skips the push", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const first = await sync(fx, w.input);
    const second = await sync(fx, w.input);
    assertEquals(commitPlan(second.plan).commit, commitPlan(first.plan).commit);
    assertEquals(second.push, { pushed: false, previousHead: commitPlan(first.plan).commit });
    assertEquals(spawnsTo(second.ctx, fx, R, "push"), []);
  });
});

gitTest("§5.8 other, ours-stale: confirmResetSafe approves and the lease pins the old head", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    // An earlier sync to the same H built on an older baseline.
    const stale = await w.student.commit(
      { "a.txt": "A\n", "b.txt": "b\n" },
      {
        parents: [await w.student.git(["rev-parse", `${w.S}~1`]).then(text)],
        message: syncCommitMessage(w.H, ["a.txt"])
      }
    );
    await w.student.setRef(branchRef(w), stale);
    const asked: string[] = [];
    const { plan, push, ctx } = await sync(
      fx,
      w.input,
      {},
      {
        confirmResetSafe: ({ head, base }) => {
          asked.push(head, base);
          return Promise.resolve(head);
        }
      }
    );
    assertEquals(asked, [stale, w.S]);
    assertEquals(push, { pushed: true, previousHead: stale });
    assertEquals(await w.student.ref(branchRef(w)), commitPlan(plan).commit);
    assert(spawnsTo(ctx, fx, R, "push")[0].includes(`--force-with-lease=${branchRef(w)}:${stale}`));
  });
});

gitTest("§5.8 other, foreign: a refusal propagates and the branch is untouched", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const theirs = await w.student.commit(
      { "a.txt": "my resolution\n", "b.txt": "b\n" },
      {
        parents: [w.S],
        message: "resolve conflicts\n",
        author: { name: "Student", email: "s@example.com" }
      }
    );
    await w.student.setRef(branchRef(w), theirs);
    class NotOurs extends Error {}
    const ctx = fx.jobContext();
    await assertRejects(
      () =>
        withSyncJob(ctx, async (job) => {
          const plan = commitPlan(await job.plan(w.input));
          return await job.push(plan, { confirmResetSafe: () => Promise.reject(new NotOurs("sync_branch_not_ours")) });
        }),
      NotOurs
    );
    assertEquals(await w.student.ref(branchRef(w)), theirs);
    assertEquals(spawnsTo(ctx, fx, R, "push"), []);
  });
});

gitTest("§5.8 other: an approval of any sha but the head ls-remote read pushes nothing", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    // Our earlier sync commit, and the student's resolution on top of it. ls-remote sees the
    // student's; a lagging branch read in the REST check sees ours and approves it.
    const ours = await w.student.commit(
      { "a.txt": "A\n", "b.txt": "b\n" },
      { parents: [w.S], message: syncCommitMessage(w.H, ["a.txt"]) }
    );
    const theirs = await w.student.commit(
      { "a.txt": "my resolution\n", "b.txt": "b\n" },
      { parents: [ours], message: "resolve\n", author: { name: "Student", email: "s@example.com" } }
    );
    await w.student.setRef(branchRef(w), theirs);
    const ctx = fx.jobContext();
    const e = await assertRejects(
      () =>
        withSyncJob(ctx, async (job) => {
          const plan = commitPlan(await job.plan(w.input));
          return await job.push(plan, { confirmResetSafe: () => Promise.resolve(ours) });
        }),
      GitSyncError
    );
    assertEquals([e.kind, e.retryable], ["reset_check_mismatch", true]);
    assertEquals(spawnsTo(ctx, fx, R, "push"), []);
    assertEquals(await w.student.ref(branchRef(w)), theirs);
  });
});

gitTest("§5.8 lease race: a push landing between the read and the write is rejected, retryably", async () => {
  // The branch moves while the reset is being authorized.
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const ours = await w.student.commit({ "a.txt": "old\n", "b.txt": "b\n" }, { parents: [w.S], message: "x\n" });
    const raced = await w.student.commit({ "a.txt": "raced\n", "b.txt": "b\n" }, { parents: [w.S], message: "y\n" });
    await w.student.setRef(branchRef(w), ours);
    const e = await assertRejects(
      () =>
        sync(
          fx,
          w.input,
          {},
          {
            confirmResetSafe: async ({ head }) => {
              await w.student.setRef(branchRef(w), raced);
              return head;
            }
          }
        ),
      GitSyncError
    );
    assertEquals([e.kind, e.retryable], ["lease_rejected", true]);
    assertEquals(await w.student.ref(branchRef(w)), raced);
  });
  // The branch appears between ls-remote and the push of a "must not exist" lease.
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const raced = await w.student.commit({ "a.txt": "raced\n", "b.txt": "b\n" }, { parents: [w.S], message: "y\n" });
    const ref = branchRef(w);
    const e = await assertRejects(
      () =>
        sync(fx, w.input, {
          testOnly: {
            git: {
              onSpawn: (argv) => {
                if (!argv.includes("push")) return;
                const out = new Deno.Command("git", {
                  args: ["--git-dir", w.student.gitDir, "update-ref", ref, raced],
                  clearEnv: true,
                  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: fx.root, GIT_CONFIG_GLOBAL: "/dev/null" }
                }).outputSync();
                assert(out.success);
              }
            }
          }
        }),
      GitSyncError
    );
    assertEquals(e.kind, "lease_rejected");
    assertEquals(await w.student.ref(ref), raced);
  });
});

// ---------------------------------------------------------------------------------------------
// §6.1: crash convergence
// ---------------------------------------------------------------------------------------------

/** A world built identically in any fixture: same contents, dates and messages, so the same shas. */
async function convergenceWorld(fx: GitFixture): Promise<World> {
  return await world(fx, {
    before: { "a.ts": TEXT_BEFORE, "d.txt": "d\n", "img.png": binary(1), "dir/x.txt": "x\n" },
    after: { "a.ts": TEXT_AFTER, "img.png": binary(2), dir: "now a file\n", "n.txt": "n\n" },
    student: (b) => ({ ...b, "a.ts": TEXT_BEFORE.replace("line2", "mine"), "notes.md": "n\n" })
  });
}

for (const phase of ["fetch", "classify", "tree", "commit", "push"] as const satisfies readonly SyncPhase[]) {
  gitTest(
    `§6.1 crash convergence: a crash after ${phase} then a fresh re-run matches an uninterrupted run`,
    async () => {
      const reference = await GitFixture.create();
      const crashed = await GitFixture.create();
      try {
        const rw = await convergenceWorld(reference);
        const clean = commitPlan((await sync(reference, rw.input)).plan);

        const cw = await convergenceWorld(crashed);
        assertEquals([cw.F, cw.H, cw.S], [rw.F, rw.H, rw.S], "fixtures must be identical");
        const cache = new TemplateCache(crashed.templatesDir);
        await assertRejects(
          () =>
            sync(crashed, cw.input, {
              templateCache: cache,
              testOnly: {
                afterPhase: (p) => {
                  if (p === phase) throw new Error(`crash after ${p}`);
                }
              }
            }),
          Error,
          `crash after ${phase}`
        );
        const rerun = await sync(crashed, cw.input, { templateCache: cache });
        assertEquals(commitPlan(rerun.plan).commit, clean.commit);
        assertEquals(rerun.push?.pushed, phase !== "push", "only a crash after the push finds it already done");
        assertEquals(await cw.student.refs(), await rw.student.refs());
        assertEquals([...Deno.readDirSync(crashed.jobsDir)], [], "no job dir survives the crash");
      } finally {
        await Deno.remove(reference.root, { recursive: true });
        await Deno.remove(crashed.root, { recursive: true });
      }
    }
  );
}

// ---------------------------------------------------------------------------------------------
// §8.3: isolation, and no working tree
// ---------------------------------------------------------------------------------------------

gitTest("§8.3 isolation: nothing that exists only in student B reaches student A's remote", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const before: Snapshot = { "a.ts": TEXT_BEFORE, "img.png": binary(1) };
    const F = await template.commitOn("main", before);
    const H = await template.commitOn("main", { "a.ts": TEXT_AFTER, "img.png": binary(2), "new.txt": "n\n" });
    const students: Record<string, { repo: FixtureRepo; S: string }> = {};
    for (const [name, edit] of [
      ["org/student-a", "A's line"],
      ["org/student-b", "B's line"]
    ] as const) {
      const repo = await fx.createRepo(name);
      await repo.commitOn("main", before);
      const S = await repo.commitOn("main", {
        ...before,
        "a.ts": TEXT_BEFORE.replace("line1", edit),
        [`${name.slice(4)}-secret.txt`]: `${name} private work\n`,
        "big.bin": binary(name.length * 7, 8192)
      });
      students[name] = { repo, S };
    }
    const cache = new TemplateCache(fx.templatesDir);
    // B first, so the cache and any shared state have seen B before A pushes.
    for (const name of ["org/student-b", "org/student-a"]) {
      const { S } = students[name];
      await sync(
        fx,
        { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: name },
        { templateCache: cache }
      );
    }
    const a = students["org/student-a"].repo;
    const b = students["org/student-b"].repo;
    const aObjects = await a.allObjects();
    const templateObjects = await template.allObjects();
    const aBefore = await a.reachableObjects();
    let bOnly = 0;
    for (const oid of await b.allObjects()) {
      if (templateObjects.has(oid)) continue;
      // Objects A also produced on its own (same bytes) are not B's.
      if (aBefore.has(oid)) continue;
      bOnly++;
      assert(!aObjects.has(oid), `object ${oid} from student B reached student A`);
    }
    assert(bOnly >= 4, `fixture should give B unique objects (got ${bOnly})`);
    // And the shared cache holds template objects only.
    const cacheObjects = text(
      await fixtureGit(
        ["--git-dir", cache.dirFor(T), "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
        {
          cwd: fx.root
        }
      )
    ).split("\n");
    for (const oid of cacheObjects) assert(templateObjects.has(oid), `non-template object ${oid} in the cache`);
  });
});

const BARE_LAYOUT_RE =
  /^(HEAD|config|description|shallow|packed-refs|sync\.index|objects\/.*|refs\/.*|info\/.*|hooks\/)$/;

gitTest("no working tree at any phase, through tree building and the push", async () => {
  await GitFixture.with(async (fx) => {
    const w = await convergenceWorld(fx);
    const seen = new Map<SyncPhase, string[]>();
    let jobDir = "";
    await sync(fx, w.input, {
      testOnly: {
        afterPhase: async (phase, gitDir) => {
          jobDir = gitDir;
          seen.set(phase, await listTree(gitDir));
        }
      }
    });
    assertEquals([...seen.keys()], ["fetch", "classify", "tree", "commit", "push"]);
    for (const [phase, entries] of seen) {
      const stray = entries.filter((p) => !BARE_LAYOUT_RE.test(p) && !["objects/", "refs/", "info/"].includes(p));
      assertEquals([phase, stray], [phase, []]);
    }
    assert(seen.get("tree")!.includes("sync.index"));
    await assertRejects(() => Deno.stat(jobDir), Deno.errors.NotFound);
  });
});

gitTest("push refuses a plan this job did not build", async () => {
  await GitFixture.with(async (fx) => {
    const w = await simpleWorld(fx);
    const plan = commitPlan(await planHandoutSync(w.input, fx.jobContext()));
    await assertRejects(
      () =>
        withSyncJob(fx.jobContext(), async (job) => {
          await job.analyze(w.input);
          return await job.push(plan, REFUSE);
        }),
      Error,
      "built by this job"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Memory (spec §2, plan WP2)
//
// Two bounds. GNU time's "Maximum resident set size" is the max of the measured process and the
// largest child it waited for, so for this script it is max(Deno, largest git child): the 150 MB
// bound covers the whole job. Deno's own peak, sampled inside the script with
// `Deno.memoryUsage().rss`, is held under 100 MB, which is the property the rewrite is for: file
// content never enters the JS heap.
// ---------------------------------------------------------------------------------------------

const TIME = "/usr/bin/time";
const MEMORY_SCRIPT = new URL("./engineMemory.script.ts", import.meta.url).pathname;
const RSS_LIMIT_KB = 150 * 1024;
const DENO_OWN_RSS_LIMIT_MB = 100;

async function haveTime(): Promise<boolean> {
  try {
    await Deno.stat(TIME);
    return true;
  } catch {
    return false;
  }
}

/** Writes `bytes` of deterministic content to a file in 1 MiB chunks, never holding more. */
async function writeLargeFile(path: string, bytes: number, kind: "ascii-ppm" | "binary", seed: number) {
  const file = await Deno.open(path, { write: true, create: true, truncate: true });
  try {
    const chunk = new Uint8Array(1024 * 1024);
    let written = 0;
    if (kind === "ascii-ppm") {
      const header = new TextEncoder().encode("P3\n1024 1024\n255\n");
      await file.write(header);
      written += header.length;
    }
    let state = seed;
    while (written < bytes) {
      const n = Math.min(chunk.length, bytes - written);
      for (let i = 0; i < n; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        chunk[i] = kind === "ascii-ppm" ? (i % 12 === 11 ? 0x0a : 0x30 + ((state >>> 16) % 10)) : (state >>> 16) & 0xff;
      }
      if (kind === "binary") chunk[0] = 0;
      let off = 0;
      while (off < n) off += await file.write(chunk.subarray(off, n));
      written += n;
    }
  } finally {
    file.close();
  }
}

for (const scenario of ["hw-img1 (8.4 MB PPM + 11 x 2 MB)", "one 90 MB file"] as const) {
  Deno.test({
    name: `memory: ${scenario}: max(Deno, any git child) under 150 MB, Deno's own peak under 100 MB`,
    ignore: SKIP || (!Deno.env.get("CI") && !(await haveTime())),
    fn: async () => {
      await GitFixture.with(async (fx) => {
        const files = `${fx.root}/files`;
        await Deno.mkdir(files);
        const after: Snapshot = { "README.md": "hw\n" };
        if (scenario.startsWith("hw-img1")) {
          await writeLargeFile(`${files}/image.ppm`, 8_400_000, "ascii-ppm", 1);
          after["images/image.ppm"] = { fromFile: `${files}/image.ppm` };
          for (let i = 0; i < 11; i++) {
            await writeLargeFile(`${files}/p${i}.png`, 2 * 1024 * 1024, "binary", 100 + i);
            after[`images/p${i}.png`] = { fromFile: `${files}/p${i}.png` };
          }
        } else {
          await writeLargeFile(`${files}/big.bin`, 90 * 1024 * 1024, "binary", 7);
          after["data/big.bin"] = { fromFile: `${files}/big.bin` };
        }
        const w = await world(fx, { before: { "README.md": "hw\n" }, after });
        await Deno.remove(files, { recursive: true });
        const config = `${fx.root}/memory-config.json`;
        await Deno.writeTextFile(
          config,
          JSON.stringify({
            input: w.input,
            root: fx.root,
            remotesDir: fx.remotesDir,
            jobsDir: fx.jobsDir,
            templatesDir: fx.templatesDir
          })
        );
        const out = await new Deno.Command(TIME, {
          args: [
            "-v",
            Deno.execPath(),
            "run",
            "--no-check",
            "--allow-read",
            "--allow-write",
            "--allow-run",
            "--allow-env",
            MEMORY_SCRIPT,
            config
          ],
          stdout: "piped",
          stderr: "piped"
        }).output();
        const stderr = new TextDecoder().decode(out.stderr);
        const stdout = new TextDecoder().decode(out.stdout);
        assert(out.success, `memory script failed:\n${stdout}\n${stderr}`);
        const kb = Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(stderr)?.[1]);
        const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
        console.log(
          `  ${scenario}: max(Deno, largest git child) RSS ${Math.round(kb / 1024)} MB (time -v); Deno's own peak RSS ${result.peakRssMb} MB (sampled)`
        );
        assertEquals(result.pushed, true);
        assertEquals(await w.student.ref(`refs/heads/sync-to-${w.H.slice(0, 7)}`), result.commit);
        assertEquals(await w.student.treeOf(result.commit), await w.template.treeOf(w.H));
        assert(kb > 0 && kb < RSS_LIMIT_KB, `max RSS of Deno and its git children ${kb} kB is over ${RSS_LIMIT_KB} kB`);
        assert(
          result.peakRssMb > 0 && result.peakRssMb < DENO_OWN_RSS_LIMIT_MB,
          `Deno's own peak RSS ${result.peakRssMb} MB is over ${DENO_OWN_RSS_LIMIT_MB} MB`
        );
      });
    }
  });
}
