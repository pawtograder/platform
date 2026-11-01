/**
 * Hermetic tests for the git sync engine (docs/handout-sync-git-worker.md §9.1; build plan WP2).
 *
 * Every case builds its own `file://` remotes with `testFixtures.ts` and runs the engine against
 * them, with no GitHub and no mock of git. The policy cases port the scenarios that
 * `syncConflictGuard.test.ts` and `GitHubSyncHelpers.test.ts` pin against GitHub's API shapes,
 * and assert the same verdicts from real trees.
 *
 * Run from supabase/functions with a Deno that can spawn git:
 *   deno test --allow-read --allow-write --allow-run --allow-env _shared/gitSync/engine.test.ts
 */
import { assert, assertEquals, assertInstanceOf, assertRejects } from "jsr:@std/assert@^1";
import type { UnresolvedReason } from "../syncConflictGuard.ts";
import {
  type ClassifiedFile,
  HandoutRevisionUnfetchableError,
  type SyncAnalysis,
  type SyncInput,
  type SyncJobContext,
  sweepStaleJobDirs,
  withSyncJob
} from "./engine.ts";
import { GitSyncError, GitSyncTerminalError, InvalidSyncInputError } from "./errors.ts";
import { runGit } from "./runGit.ts";
import { TemplateCache } from "./templateCache.ts";
import {
  fixtureGit,
  type FixtureRepo,
  GitFixture,
  listTree,
  shouldSkipRealGit,
  type Snapshot,
  text
} from "./testFixtures.ts";
import { EMPTY_TREE_SHA } from "./validate.ts";
import { escapePath, parseCommitHeader, parseDiffTreeRaw, parseLsTree, parseNumstatBinary } from "./gitOutput.ts";
import { classifyPaths, mapHandoutDiff } from "./engine.ts";

const SKIP = await shouldSkipRealGit("engine.test.ts");

/** A Deno.test that needs real git. Ignored, loudly (see `shouldSkipRealGit`), where git is missing. */
function gitTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: SKIP, fn });
}

const T = "org/handout";
const R = "org/student-a";

/** Bytes git's numstat reads as binary: a NUL in the first 8000 bytes. */
function binary(seed: number, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  out[0] = 0;
  return out;
}

interface World {
  fx: GitFixture;
  template: FixtureRepo;
  student: FixtureRepo;
  F: string;
  H: string;
  /** The student's commit at the last sync. */
  S: string;
  input: SyncInput;
}

/**
 * The common shape: the handout goes from `before` to `after` (H's parent is F); the student repo
 * starts from the handout's `before` contents (GitHub's "generate from template" makes a new root
 * commit with the same tree) and, when `student` is given, commits that snapshot on top. `S` is
 * the student's latest commit, so everything in `student` predates the last sync and is theirs.
 */
async function world(
  fx: GitFixture,
  spec: { before: Snapshot; after: Snapshot; student?: (before: Snapshot) => Snapshot }
): Promise<World> {
  const template = await fx.createRepo(T);
  const F = await template.commitOn("main", spec.before, { message: "handout v1\n" });
  const H = await template.commitOn("main", spec.after, { message: "handout v2\n", date: "1700000500 -0500" });
  const student = await fx.createRepo(R);
  let S = await student.commitOn("main", spec.before, { message: "Initial commit\n" });
  if (spec.student) S = await student.commitOn("main", spec.student({ ...spec.before }), { message: "student work\n" });
  return {
    fx,
    template,
    student,
    F,
    H,
    S,
    input: { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R }
  };
}

async function analyze(
  fx: GitFixture,
  input: SyncInput,
  overrides: Partial<SyncJobContext> = {}
): Promise<SyncAnalysis & { ctx: ReturnType<GitFixture["jobContext"]> }> {
  const ctx = fx.jobContext(overrides);
  const analysis = await withSyncJob(ctx, (job) => job.analyze(input));
  return { ...analysis, ctx };
}

/** `path -> "status reason action"`, the compact form the policy cases assert against. */
function verdicts(files: readonly ClassifiedFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.change.path, `${f.change.status} ${f.reason ?? "-"} ${f.action}`]));
}

function omit(snapshot: Snapshot, ...paths: string[]): Snapshot {
  const copy = { ...snapshot };
  for (const p of paths) delete copy[p];
  return copy;
}

/** Spawns whose argv names the given remote. */
function spawnsTo(ctx: { spawns: string[][] }, fx: GitFixture, fullName: string, op?: string): string[][] {
  const url = `file://${fx.remotePath(fullName)}`;
  return ctx.spawns.filter((argv) => argv.includes(url) && (op === undefined || argv.includes(op)));
}

// ---------------------------------------------------------------------------------------------
// §5.3: the handout diff
// ---------------------------------------------------------------------------------------------

gitTest("§5.3 table: A, M, D and T map onto the guard's file shape", async () => {
  await GitFixture.with(async (fx) => {
    const before: Snapshot = {
      "keep.txt": "same\n",
      "mod.txt": "one\n",
      "del.txt": "gone soon\n",
      "img.bin": binary(1),
      link: "target-as-file\n"
    };
    const after: Snapshot = {
      "keep.txt": "same\n",
      "mod.txt": "two\n",
      "add.txt": "new\n",
      "img.bin": binary(2),
      "addbin.bin": binary(3),
      link: { content: "target", mode: "120000" }
    };
    const w = await world(fx, { before, after });
    const a = await analyze(fx, w.input);
    const byPath = Object.fromEntries(a.files.map((f) => [f.change.path, f.change]));
    assertEquals(Object.keys(byPath).sort(), ["add.txt", "addbin.bin", "del.txt", "img.bin", "link", "mod.txt"]);
    const shape = (p: string) => {
      const c = byPath[p];
      return [c.gitStatus, c.status, c.isBinary, c.hasPatch, c.patchDeletesFile];
    };
    assertEquals(shape("add.txt"), ["A", "added", false, true, false]);
    assertEquals(shape("addbin.bin"), ["A", "added", true, false, false]);
    assertEquals(shape("mod.txt"), ["M", "modified", false, true, false]);
    assertEquals(shape("img.bin"), ["M", "modified", true, false, false]);
    assertEquals(shape("del.txt"), ["D", "removed", false, false, false]);
    // A type change is binary whatever numstat says, so it is never merged.
    assertEquals(shape("link"), ["T", "modified", true, false, false]);
    assertEquals([byPath["link"].oldMode, byPath["link"].newMode], ["100644", "120000"]);
    assertEquals([byPath["add.txt"].oldOid, byPath["del.txt"].newOid], [null, null]);
    // Untouched student repo: every change is written.
    for (const f of a.files) assertEquals([f.change.path, f.action], [f.change.path, "write"]);
    assertEquals(a.handoutCommitDate, "1700000500 -0500");
    assertEquals(a.handoutTree, await w.template.treeOf(w.H));
    assertEquals(a.handoutBeforeTree, await w.template.treeOf(w.F));
    // S is the head of main, so the student repo is fetched once.
    assertEquals(spawnsTo(a.ctx, fx, R, "fetch").length, 1);
  });
});

gitTest("§5.3: gitlinks are dropped; a type change across a gitlink keeps its blob side", async () => {
  await GitFixture.with(async (fx) => {
    const sub1 = "1".repeat(40);
    const sub2 = "2".repeat(40);
    const w = await world(fx, {
      before: { "a.txt": "a\n", vendor: { gitlink: sub1 }, "becomes-sub": "file\n", "was-sub": { gitlink: sub1 } },
      after: {
        "a.txt": "a2\n",
        vendor: { gitlink: sub2 },
        "becomes-sub": { gitlink: sub1 },
        "was-sub": "now a file\n",
        "new-sub": { gitlink: sub2 }
      }
    });
    const a = await analyze(fx, w.input);
    const byPath = Object.fromEntries(a.files.map((f) => [f.change.path, f.change]));
    assertEquals(Object.keys(byPath).sort(), ["a.txt", "becomes-sub", "was-sub"]);
    assertEquals([byPath["becomes-sub"].gitStatus, byPath["becomes-sub"].newOid], ["D", null]);
    assertEquals([byPath["was-sub"].gitStatus, byPath["was-sub"].oldOid], ["A", null]);
    assertEquals(a.tags.gitlinks_dropped, "4");
  });
});

gitTest("§5.3: a rename is a deletion plus an addition, each classified on its own", async () => {
  await GitFixture.with(async (fx) => {
    const body = "export const x = 1;\n".repeat(20);
    const before = { "src/old/name.ts": body, "README.md": "r\n" };
    const after = { "src/new/name.ts": body, "README.md": "r\n" };
    const pristine = await world(fx, { before, after });
    const a = await analyze(fx, pristine.input);
    assertEquals(verdicts(a.files), {
      "src/old/name.ts": "removed - write",
      "src/new/name.ts": "added - write"
    });

    // The student edited the old path: its removal is theirs to keep, the new path still lands.
    const fx2 = await GitFixture.create();
    try {
      const edited = await world(fx2, {
        before,
        after,
        student: (b) => ({ ...b, "src/old/name.ts": body + "// mine\n" })
      });
      const b = await analyze(fx2, edited.input);
      assertEquals(verdicts(b.files), {
        "src/old/name.ts": "removed content_differs skip",
        "src/new/name.ts": "added - write"
      });
    } finally {
      await Deno.remove(fx2.root, { recursive: true });
    }
  });
});

gitTest("§5.3: two revisions with the same tree are no changes", async () => {
  await GitFixture.with(async (fx) => {
    const snap = { "a.txt": "a\n" };
    const w = await world(fx, { before: snap, after: snap });
    const a = await analyze(fx, w.input);
    assertEquals(a.files, []);
    assertEquals(a.removedPaths.size, 0);
  });
});

gitTest("§5.3: a handout path that is not valid UTF-8 is terminal non_utf8_path", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const F = await template.commitOn("main", { "a.txt": "a\n" });
    const bad = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x2f, 0xff, 0xfe, 0x2e, 0x63, 0x73, 0x76]); // data/\xff\xfe.csv
    const H = await template.commit(
      { "a.txt": "a\n" },
      { parents: [F], rawPaths: [{ pathBytes: bad, content: "x\n" }] }
    );
    await template.setRef("refs/heads/main", H);
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", { "a.txt": "a\n" });
    const ctx = fx.jobContext();
    const e = await assertRejects(
      () =>
        withSyncJob(ctx, (job) =>
          job.analyze({ templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R })
        ),
      GitSyncTerminalError
    );
    assertEquals(e.reason, "non_utf8_path");
    assertEquals(e.retryable, false);
    assertEquals(e.path, '"data/\\377\\376.csv"');
  });
});

gitTest("§5.3: a student path that is not valid UTF-8 is ignored, not decoded lossily", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const F = await template.commitOn("main", { "a.txt": "a\n" });
    const H = await template.commitOn("main", { "a.txt": "b\n" });
    const student = await fx.createRepo(R);
    // `\xff.txt` would decode to U+FFFD, and so would a real file named `�.txt`. Neither may be
    // mistaken for the other.
    const S = await student.commitOn(
      "main",
      { "a.txt": "a\n" },
      { rawPaths: [{ pathBytes: new Uint8Array([0xff, 0x2e, 0x74, 0x78, 0x74]), content: "mine\n" }] }
    );
    const a = await analyze(fx, { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R });
    assertEquals(verdicts(a.files), { "a.txt": "modified - write" });
    assert(a.ctx.events.some((e) => e.msg === "ls-tree entries with non-UTF-8 paths ignored" && e.count === 1));
  });
});

// ---------------------------------------------------------------------------------------------
// §5.1: the template cache
// ---------------------------------------------------------------------------------------------

gitTest("§5.1: a second job finds the handout in the cache and does not fetch it again", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    const cache = new TemplateCache(fx.templatesDir);
    const first = await analyze(fx, w.input, { templateCache: cache });
    assertEquals(spawnsTo(first.ctx, fx, T, "fetch").length, 2, "first job fetches H and F");
    const second = await analyze(fx, w.input, { templateCache: cache });
    assertEquals(spawnsTo(second.ctx, fx, T).length, 0, "second job must not touch the template remote");
    assertEquals(verdicts(second.files), verdicts(first.files));
  });
});

gitTest("§5.1: template objects are read through alternates, never copied into the job", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n" },
      after: { "a.txt": "b\n", "big.bin": binary(9, 4096) },
      student: (b) => ({ ...b, "mine.txt": "student only\n" })
    });
    const cache = new TemplateCache(fx.templatesDir);
    const handoutTree = await w.template.treeOf(w.H);
    const studentTree = await w.student.treeOf(w.S);
    let checked = false;
    await analyze(fx, w.input, {
      templateCache: cache,
      testOnly: {
        afterPhase: async (phase, gitDir) => {
          if (phase !== "classify") return;
          const alternates = `${gitDir}/objects/info/alternates`;
          assertEquals(await Deno.readTextFile(alternates), `${cache.dirFor(T)}/objects\n`);
          // Without the alternates file the job repo has the student's objects and none of the
          // handout's.
          await Deno.rename(alternates, `${alternates}.off`);
          try {
            const own = async (oid: string) =>
              (await fixtureGit(["--git-dir", gitDir, "cat-file", "-e", oid], { cwd: fx.root, allowFail: true }))
                .code === 0;
            assert(await own(studentTree), "student tree should be in the job store");
            assert(!(await own(handoutTree)), "handout tree must not be copied into the job store");
          } finally {
            await Deno.rename(`${alternates}.off`, alternates);
          }
          checked = true;
        }
      }
    });
    assert(checked);
    // And nothing of the student's reaches the cache.
    const cacheObjects = new Set(
      text(
        await fixtureGit(
          ["--git-dir", cache.dirFor(T), "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
          {
            cwd: fx.root
          }
        )
      ).split("\n")
    );
    let studentOnly = 0;
    for (const oid of await w.student.allObjects()) {
      if (await w.template.hasObject(oid)) continue;
      studentOnly++;
      assert(!cacheObjects.has(oid), `student object ${oid} reached the cache`);
    }
    assert(studentOnly > 0, "fixture should have student-only objects");
  });
});

gitTest("§5.1: concurrent jobs on one template never fetch into its cache at the same time", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const revisions: string[] = [];
    // Large enough that a fetch takes measurable time.
    for (let i = 0; i < 4; i++) {
      revisions.push(await template.commitOn("main", { "a.txt": `v${i}\n`, "pad.bin": binary(i, 256 * 1024) }));
    }
    const students: FixtureRepo[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await fx.createRepo(`org/student-${i}`);
      await s.commitOn("main", { "a.txt": "v0\n", "pad.bin": binary(0, 256 * 1024) });
      students.push(s);
    }
    const cache = new TemplateCache(fx.templatesDir);
    const cacheDir = cache.dirFor(T);
    let inFlight = 0;
    let maxInFlight = 0;
    const isCacheFetch = (argv: readonly string[]) => argv.includes(`--git-dir=${cacheDir}`) && argv.includes("fetch");
    await Promise.all(
      students.map((s, i) =>
        analyze(
          fx,
          {
            templateRepo: T,
            fromSha: revisions[0],
            toSha: revisions[i + 1],
            syncedRepoSha: null,
            repoFullName: s.fullName
          },
          {
            templateCache: cache,
            gitLog: (entry) => {
              if (isCacheFetch(entry.argv)) inFlight--;
            },
            testOnly: {
              git: {
                onSpawn: (argv) => {
                  if (isCacheFetch(argv)) maxInFlight = Math.max(maxInFlight, ++inFlight);
                }
              }
            }
          }
        )
      )
    );
    assertEquals(maxInFlight, 1);
  });
});

gitTest("§5.1: a stale shallow.lock in the cache is removed before fetching", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    const cache = new TemplateCache(fx.templatesDir);
    await analyze(fx, w.input, { templateCache: cache });
    const H2 = await w.template.commitOn("main", { "a.txt": "c\n" });
    const cacheDir = cache.dirFor(T);
    await Deno.writeTextFile(`${cacheDir}/shallow.lock`, "");
    await Deno.mkdir(`${cacheDir}/refs/heads`, { recursive: true });
    await Deno.writeTextFile(`${cacheDir}/refs/heads/x.lock`, "");

    // Control: the planted lock really does block a fetch into the cache.
    const blocked = await runGit(
      { op: "fetch", gitDir: cacheDir, repo: T, target: { kind: "sha", sha: H2 }, depth: 1 },
      { home: fx.root, remote: fx.remote(), log: () => {} }
    );
    assert(
      blocked.code !== 0 && blocked.stderr.includes("shallow.lock"),
      `control fetch should fail: ${blocked.stderr}`
    );

    const a = await analyze(fx, { ...w.input, fromSha: w.H, toSha: H2 }, { templateCache: cache });
    // S still holds v1 of a.txt while the new F (old H) has v2, so the file reads as theirs.
    assertEquals(verdicts(a.files), { "a.txt": "modified content_differs attempt_patch" });
    assertEquals(a.tags.template_cache_stale_locks, "2");
    for (const lock of ["shallow.lock", "refs/heads/x.lock"]) {
      await assertRejects(() => Deno.stat(`${cacheDir}/${lock}`), Deno.errors.NotFound);
    }
  });
});

gitTest("§5.1: an unfetchable F degrades to the empty tree, so everything the student holds is theirs", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const before = { "keep.txt": "k\n", "edit.txt": "e\n" };
    const F = await template.commitOn("main", before);
    // The instructor rewrote history: H is a new root, F is unreachable and collected.
    const H = await template.commit({ "keep.txt": "k\n", "edit.txt": "e2\n", "new.txt": "n\n" });
    await template.setRef("refs/heads/main", H);
    await template.gc();
    assert(!(await template.hasObject(F)), "F should be collected");
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", before);
    const a = await analyze(fx, { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R });
    assertEquals(a.tags.sync_from_sha_unfetchable, "true");
    assertEquals(a.handoutBeforeTree, EMPTY_TREE_SHA);
    assertEquals(verdicts(a.files), {
      "edit.txt": "added only_in_your_repo skip",
      "keep.txt": "added only_in_your_repo skip",
      "new.txt": "added - write"
    });
  });
});

gitTest("§5.1: an unfetchable H is a retryable HandoutRevisionUnfetchableError", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    const missing = "f".repeat(40);
    const ctx = fx.jobContext();
    const e = await assertRejects(
      () => withSyncJob(ctx, (job) => job.analyze({ ...w.input, toSha: missing })),
      HandoutRevisionUnfetchableError
    );
    assertEquals([e.kind, e.retryable, e.sha], ["unfetchable", true, missing]);
    assertEquals(spawnsTo(ctx, fx, R).length, 0, "the student repo is not fetched when H is missing");
  });
});

gitTest("§5.1: a rewritten handout history is diffed tree to tree", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const before = { "a.txt": "a\n", "dropped.txt": "d\n", "reverted.txt": "changed\n" };
    const F = await template.commitOn("old-main", before);
    // Unrelated root: a force-push that dropped `dropped.txt` and restored `reverted.txt`.
    const H = await template.commit({ "a.txt": "a\n", "reverted.txt": "original\n" });
    await template.setRef("refs/heads/main", H);
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", before);
    const a = await analyze(fx, { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R });
    assertEquals(verdicts(a.files), {
      "dropped.txt": "removed - write",
      "reverted.txt": "modified - write"
    });
  });
});

// ---------------------------------------------------------------------------------------------
// §5.2: the student repo
// ---------------------------------------------------------------------------------------------

gitTest("§5.2: the baseline is S, not the current head, so later student commits are the PR merge's job", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n", "b.txt": "b\n" },
      after: { "a.txt": "A\n", "b.txt": "B\n" }
    });
    // After the last sync the student edits a.txt. At S it is still the handout's.
    const head = await w.student.commitOn("main", { "a.txt": "mine\n", "b.txt": "b\n" });
    const a = await analyze(fx, w.input);
    assertEquals([a.baselineSha, a.mainSha], [w.S, head]);
    assertEquals(verdicts(a.files), { "a.txt": "modified - write", "b.txt": "modified - write" });
    assertEquals(a.tags, {});
  });
});

gitTest("§5.2: a null S is resolved to the head of main, once, and tagged", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n", "b.txt": "b\n" },
      after: { "a.txt": "A\n", "b.txt": "B\n" },
      student: (b) => ({ ...b, "a.txt": "mine\n" })
    });
    const a = await analyze(fx, { ...w.input, syncedRepoSha: null });
    assertEquals([a.baselineSha, a.mainSha], [w.S, w.S]);
    assertEquals(a.tags.sync_baseline_from_head, "true");
    assertEquals(verdicts(a.files), { "a.txt": "modified content_differs attempt_patch", "b.txt": "modified - write" });
  });
});

gitTest("§5.2: an unfetchable S falls back to the head of main and is tagged", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "A\n" } });
    // A commit the student force-pushed away: present nowhere reachable on the remote.
    const lost = await w.student.commit({ "a.txt": "lost\n" }, { parents: [w.S] });
    // Protocol v2 serves any object the remote still has, so it must be collected, as GitHub
    // eventually does.
    await w.student.gc();
    assert(!(await w.student.hasObject(lost)));
    const a = await analyze(fx, { ...w.input, syncedRepoSha: lost });
    assertEquals(a.baselineSha, w.S);
    assertEquals(a.tags.sync_baseline_unreachable, "true");
    assertEquals(verdicts(a.files), { "a.txt": "modified - write" });
  });
});

gitTest("§5.2: a student repo with no main is terminal and never takes the head fallback", async () => {
  for (const variant of ["empty", "trunk"] as const) {
    await GitFixture.with(async (fx) => {
      const template = await fx.createRepo(T);
      const F = await template.commitOn("main", { "a.txt": "a\n" });
      const H = await template.commitOn("main", { "a.txt": "b\n" });
      const student = await fx.createRepo(R, { defaultBranch: "trunk" });
      let S = "e".repeat(40);
      if (variant === "trunk") S = await student.commitOn("trunk", { "a.txt": "a\n" });
      const ctx = fx.jobContext();
      const e = await assertRejects(
        () =>
          withSyncJob(ctx, (job) =>
            job.analyze({ templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R })
          ),
        GitSyncTerminalError
      );
      assertEquals([variant, e.reason], [variant, "student_repo_has_no_main"]);
      assertEquals(spawnsTo(ctx, fx, R, "fetch").length, 1, `${variant}: only the main fetch may run`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// §5.4: classification parity with findStudentModifiedFiles
// ---------------------------------------------------------------------------------------------

gitTest("parity: initial sync (F null) into a pristine repo writes everything", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const H = await template.commitOn("main", { "src/a.ts": "a\n", "img.png": binary(4) });
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", { "NOTES.md": "mine\n" });
    const a = await analyze(fx, { templateRepo: T, fromSha: null, toSha: H, syncedRepoSha: S, repoFullName: R });
    assertEquals(a.tags.sync_without_handout_history, "true");
    assertEquals(a.handoutBeforeTree, EMPTY_TREE_SHA);
    assertEquals(verdicts(a.files), { "img.png": "added - write", "src/a.ts": "added - write" });
  });
});

gitTest("parity: initial sync into a repo with colliding paths leaves every collision to the student", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const H = await template.commitOn("main", { "src/a.ts": "a\n", "same.txt": "same\n", "new.txt": "n\n" });
    const student = await fx.createRepo(R);
    // Even a byte-identical file is theirs: with no handout history nothing says where it came from.
    const S = await student.commitOn("main", { "src/a.ts": "mine\n", "same.txt": "same\n" });
    const a = await analyze(fx, { templateRepo: T, fromSha: null, toSha: H, syncedRepoSha: S, repoFullName: R });
    assertEquals(verdicts(a.files), {
      "new.txt": "added - write",
      "same.txt": "added only_in_your_repo skip",
      "src/a.ts": "added only_in_your_repo skip"
    });
  });
});

gitTest("parity: untouched files are modified, added and deleted by the handout", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "m.txt": "1\n", "d.txt": "d\n", "img.png": binary(5) },
      after: { "m.txt": "2\n", "a.txt": "a\n", "img.png": binary(6) }
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      "a.txt": "added - write",
      "d.txt": "removed - write",
      "img.png": "modified - write",
      "m.txt": "modified - write"
    });
  });
});

gitTest("parity: a student-edited text file is merged, a student-edited binary is left alone", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "src/user.service.ts": "line1\nline2\n", "img.png": binary(7) },
      after: { "src/user.service.ts": "line1\nline2\nline3\n", "img.png": binary(8) },
      student: (b) => ({ ...b, "src/user.service.ts": "mine\nline2\n", "img.png": binary(9) })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      "img.png": "modified content_differs skip",
      "src/user.service.ts": "modified content_differs attempt_patch"
    });
  });
});

gitTest("parity: a file the student deleted stays deleted; a deletion both sides made is a noop", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "changed.txt": "1\n", "both.txt": "b\n", "keep.txt": "k\n" },
      after: { "changed.txt": "2\n", "keep.txt": "k\n" },
      student: (b) => omit(b, "changed.txt", "both.txt")
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      "both.txt": "removed deleted_in_your_repo noop",
      "changed.txt": "modified deleted_in_your_repo skip"
    });
  });
});

gitTest("parity: directory to file, untouched and student-blocked", async () => {
  const before = { "foo/a.txt": "a\n", "foo/b.txt": "b\n", "x.txt": "x\n" };
  const after = { foo: "now a file\n", "x.txt": "x\n" };
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after });
    const a = await analyze(fx, w.input);
    // The student's `foo` is the handout's own tree, sha for sha, so the swap goes through.
    assertEquals(verdicts(a.files), {
      foo: "added - write",
      "foo/a.txt": "removed - write",
      "foo/b.txt": "removed - write"
    });
  });
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after, student: (b) => ({ ...b, "foo/mine.txt": "work\n" }) });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      foo: "added directory_in_your_repo skip",
      "foo/a.txt": "removed - write",
      "foo/b.txt": "removed - write"
    });
  });
});

gitTest("parity: file to directory, untouched and student-blocked", async () => {
  const before = { config: "old config\n", "x.txt": "x\n" };
  const after = { "config/settings.ts": "export {}\n", "x.txt": "x\n" };
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after });
    const a = await analyze(fx, w.input);
    // The `config` blob standing in the way is the handout's own, so it does not block.
    assertEquals(verdicts(a.files), { config: "removed - write", "config/settings.ts": "added - write" });
  });
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before, after, student: (b) => ({ ...b, config: "my config\n" }) });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      config: "removed content_differs skip",
      "config/settings.ts": "added path_blocked_in_your_repo skip"
    });
  });
});

gitTest("parity: a deletion under a file of the student's needs nothing and is not blocked", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "foo/bar.ts": "b\n", "x.txt": "x\n" },
      after: { "x.txt": "x\n" },
      student: (b) => ({ ...omit(b, "foo/bar.ts"), foo: "my file\n" })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), { "foo/bar.ts": "removed deleted_in_your_repo noop" });
  });
});

gitTest("parity: a submodule where a parent directory has to go blocks the path", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "x.txt": "x\n" },
      after: { "x.txt": "x\n", "vendor/config.ts": "c\n" },
      student: (b) => ({ ...b, vendor: { gitlink: "3".repeat(40) } })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), { "vendor/config.ts": "added path_blocked_in_your_repo skip" });
  });
});

gitTest("parity: a mode-only student change is theirs; a handout chmod on an untouched script is written", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "run.sh": "echo 1\n", "build.sh": "make\n" },
      after: { "run.sh": "echo 2\n", "build.sh": { content: "make\n", mode: "100755" } },
      student: (b) => ({ ...b, "run.sh": { content: "echo 1\n", mode: "100755" } })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), {
      "build.sh": "modified - write",
      "run.sh": "modified content_differs attempt_patch"
    });
    const build = a.files.find((f) => f.change.path === "build.sh")!.change;
    assertEquals([build.oldMode, build.newMode, build.oldOid === build.newOid], ["100644", "100755", true]);
  });
});

gitTest("parity: grade.yml is the handout's, added over a student file and removed despite an edit", async () => {
  const GRADE = ".github/workflows/grade.yml";
  await GitFixture.with(async (fx) => {
    // Grading turned ON: the handout adds the workflow where the student has their own.
    const w = await world(fx, {
      before: { "x.txt": "x\n" },
      after: { "x.txt": "x\n", [GRADE]: "on: push\n" },
      student: (b) => ({ ...b, [GRADE]: "mine\n", ".github/workflows/other.yml": "mine\n" })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), { [GRADE]: "added only_in_your_repo write" });
  });
  await GitFixture.with(async (fx) => {
    // Grading turned OFF: the handout removes it from a student who edited it.
    const w = await world(fx, {
      before: { "x.txt": "x\n", [GRADE]: "on: push\n" },
      after: { "x.txt": "x\n" },
      student: (b) => ({ ...b, [GRADE]: "on: push\n# mine\n" })
    });
    const a = await analyze(fx, w.input);
    assertEquals(verdicts(a.files), { [GRADE]: "removed content_differs write" });
  });
});

// ---------------------------------------------------------------------------------------------
// §6.3: the blocked recheck
// ---------------------------------------------------------------------------------------------

gitTest("§6.3: paths applied by hand on main since S no longer count as blocking", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "a\n", "b.txt": "b\n", "gone.txt": "g\n" },
      after: { "a.txt": "A\n", "b.txt": "B\n" },
      student: (b) => ({ ...b, "a.txt": "mine a\n", "b.txt": "mine b\n", "gone.txt": "mine g\n" })
    });
    // After S, the student copies the handout's a.txt in by hand and deletes gone.txt.
    const head = await w.student.commitOn("main", { "a.txt": "A\n", "b.txt": "mine b\n" });
    const ctx = fx.jobContext();
    const result = await withSyncJob(ctx, async (job) => {
      const a = await job.analyze(w.input);
      const paths = a.files.filter((f) => f.action !== "noop").map((f) => f.change.path);
      return await job.classifyPathsAgainstHead(a, paths);
    });
    assertEquals(result.headSha, head);
    assertEquals(Object.fromEntries(result.stillDiffering), { "b.txt": "content_differs" as UnresolvedReason });
  });
});

// ---------------------------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------------------------

/** Everything a bare job repo may contain. A working tree would show up as anything else. */
const BARE_LAYOUT_RE =
  /^(HEAD|config|description|shallow|packed-refs|sync\.index|objects\/.*|refs\/.*|info\/.*|hooks\/)$/;

gitTest("no working tree: the job dir holds only bare-repo layout, and is gone afterwards", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "src/a.ts": "a\n", "dir/b.txt": "b\n" },
      after: { "src/a.ts": "A\n", "dir/b.txt": "B\n", "new/c.txt": "c\n" }
    });
    let seen: string[] = [];
    let jobDir = "";
    await analyze(fx, w.input, {
      testOnly: {
        afterPhase: async (phase, gitDir) => {
          jobDir = gitDir;
          if (phase === "classify") seen = await listTree(gitDir);
        }
      }
    });
    assert(seen.length > 0);
    const stray = seen.filter((p) => !BARE_LAYOUT_RE.test(p) && p !== "objects/" && p !== "refs/" && p !== "info/");
    assertEquals(stray, []);
    for (const p of ["src", "dir", "new", "a.ts"]) assert(!seen.some((s) => s.startsWith(p)), `${p} in job dir`);
    await assertRejects(() => Deno.stat(jobDir), Deno.errors.NotFound);
  });
});

gitTest("the job dir is removed when the job throws", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    let jobDir = "";
    await assertRejects(
      () =>
        analyze(fx, w.input, {
          testOnly: {
            afterPhase: (phase, gitDir) => {
              jobDir = gitDir;
              if (phase === "fetch") throw new Error("crash after fetch");
            }
          }
        }),
      Error,
      "crash after fetch"
    );
    await assertRejects(() => Deno.stat(jobDir), Deno.errors.NotFound);
    assertEquals([...Deno.readDirSync(fx.jobsDir)], []);
  });
});

gitTest("invalid input is rejected before anything is fetched", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    for (const bad of [
      { ...w.input, toSha: "--upload-pack=touch /tmp/pwned" },
      { ...w.input, fromSha: "A".repeat(40) },
      { ...w.input, repoFullName: "ext::sh -c id" },
      { ...w.input, templateRepo: "../x" }
    ]) {
      const ctx = fx.jobContext();
      await assertRejects(() => withSyncJob(ctx, (job) => job.analyze(bad)), InvalidSyncInputError);
      assertEquals(
        ctx.spawns.filter((argv) => argv.includes("fetch")),
        []
      );
    }
    await assertRejects(
      () => withSyncJob(fx.jobContext({ jobId: "../escape" }), () => Promise.resolve()),
      InvalidSyncInputError
    );
  });
});

gitTest("sweepStaleJobDirs removes job repos a dead process left behind", async () => {
  await GitFixture.with(async (fx) => {
    await Deno.mkdir(`${fx.jobsDir}/123.abcdef01.git/objects`, { recursive: true });
    await Deno.writeTextFile(`${fx.jobsDir}/unrelated.txt`, "x");
    assertEquals(await sweepStaleJobDirs(fx.jobsDir), ["123.abcdef01.git"]);
    assertEquals(
      [...Deno.readDirSync(fx.jobsDir)].map((e) => e.name),
      ["unrelated.txt"]
    );
  });
});

gitTest("ENOSPC evicts idle template caches and still throws", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "a\n" }, after: { "a.txt": "b\n" } });
    const cache = new TemplateCache(fx.templatesDir);
    // A cache for another template, idle.
    const other = await fx.createRepo("org/other");
    const O = await other.commitOn("main", { "o.txt": "o\n" });
    await cache.ensureCommits("org/other", [O], { home: fx.root, remote: fx.remote(), log: () => {} });
    const ctx = fx.jobContext({ templateCache: cache });
    const e = await assertRejects(
      () =>
        withSyncJob(ctx, async (job) => {
          await job.analyze(w.input);
          throw new GitSyncError("git fetch: disk full: No space left on device", "disk_full", true);
        }),
      GitSyncError
    );
    assertEquals(e.kind, "disk_full");
    await assertRejects(() => Deno.stat(cache.dirFor("org/other")), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(cache.dirFor(T)), Deno.errors.NotFound);
  });
});

gitTest("evictToFit removes least recently used idle caches until under the high-water mark", async () => {
  await GitFixture.with(async (fx) => {
    const cache = new TemplateCache(fx.templatesDir);
    const names = ["org/t1", "org/t2", "org/t3"];
    for (const name of names) {
      const repo = await fx.createRepo(name);
      const sha = await repo.commitOn("main", { "pad.bin": binary(1, 64 * 1024) });
      await cache.ensureCommits(name, [sha], { home: fx.root, remote: fx.remote(), log: () => {} });
      // Distinct last-used times, so the LRU order is not a tie broken by directory order.
      await new Promise((r) => setTimeout(r, 5));
    }
    // t2 is in use; t1 is the oldest.
    const release = cache.acquire("org/t2");
    let usage = 3;
    const evicted = await cache.evictToFit({
      sizeLimitBytes: 2,
      highWaterFraction: 0.5,
      usageBytes: async () => usage--
    });
    assertEquals(evicted, [cache.dirFor("org/t1"), cache.dirFor("org/t3")]);
    await Deno.stat(cache.dirFor("org/t2"));
    release();
  });
});

Deno.test("withSyncJob rejects a job id that could escape the jobs dir, without touching disk", async () => {
  const cache = new TemplateCache("/nonexistent-root");
  await assertRejects(
    () =>
      withSyncJob(
        {
          jobId: "a/b",
          jobsDir: "/nonexistent-root/jobs",
          templateCache: cache,
          identity: { name: "x", email: "y" }
        },
        () => Promise.resolve()
      ),
    InvalidSyncInputError
  );
  assertInstanceOf(new HandoutRevisionUnfetchableError(T, "a".repeat(40)), GitSyncError);
});

// ---------------------------------------------------------------------------------------------
// Pure parsing and mapping (run everywhere, including where git is missing)
// ---------------------------------------------------------------------------------------------

const enc = (...parts: Array<string | number[]>) => {
  const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : new Uint8Array(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};
const OID1 = "1".repeat(40);
const OID2 = "2".repeat(40);
const ZERO = "0".repeat(40);

Deno.test("parseLsTree keeps trees and submodules, and drops non-UTF-8 paths instead of decoding them", () => {
  const out = parseLsTree(
    enc(
      `040000 tree ${OID1}\tsrc\0`,
      `100755 blob ${OID2}\tsrc/run sh.sh\0`,
      `160000 commit ${OID1}\tvendor\0`,
      `100644 blob ${OID2}\t`,
      [0xff, 0x2e, 0x74],
      "\0",
      `100644 blob ${OID1}\t\uFFFD.t\0`
    )
  );
  assertEquals(Object.fromEntries(out.entries), {
    src: { sha: OID1, type: "tree", mode: "040000" },
    "src/run sh.sh": { sha: OID2, type: "blob", mode: "100755" },
    vendor: { sha: OID1, type: "commit", mode: "160000" },
    "\uFFFD.t": { sha: OID1, type: "blob", mode: "100644" }
  });
  assertEquals(out.nonUtf8Paths, 1);
});

Deno.test("diff mapping: an unknown status is an error, a missing numstat row reads as binary", () => {
  let threw = false;
  try {
    parseDiffTreeRaw(enc(`:100644 100644 ${OID1} ${OID2} R100\0a\0b\0`));
  } catch {
    threw = true;
  }
  assert(threw, "a rename record must not be parsed under --no-renames");
  const records = parseDiffTreeRaw(
    enc(`:100644 100644 ${OID1} ${OID2} M\0a.txt\0`, `:000000 100644 ${ZERO} ${OID2} A\0b.txt\0`)
  );
  const numstat = parseNumstatBinary(enc("1\t1\ta.txt\0"));
  const { changes } = mapHandoutDiff(records, numstat);
  assertEquals(
    changes.map((c) => [c.path, c.status, c.isBinary, c.hasPatch, c.oldOid]),
    [
      ["a.txt", "modified", false, true, OID1],
      ["b.txt", "added", true, false, null]
    ]
  );
});

Deno.test("parseNumstatBinary reads '-\\t-' as binary and keeps tabs inside paths", () => {
  const m = parseNumstatBinary(enc("-\t-\timg.png\0", "3\t0\ta\tb.txt\0"));
  assertEquals([...m.values()], [true, false]);
  assertEquals([...m.keys()], ["img.png", "a\tb.txt"]);
});

Deno.test("parseCommitHeader reads the tree and the raw committer date, never the message", () => {
  const h = parseCommitHeader(
    enc(
      `tree ${OID1}\nparent ${OID2}\nauthor A B <a@b> 1 +0000\ncommitter Some One <x@y> 1700000500 -0500\n\ncommitter fake <z> 9 +0000\n`
    )
  );
  assertEquals(h, { tree: OID1, committerDate: "1700000500 -0500" });
});

Deno.test("escapePath octal-escapes everything outside printable ASCII", () => {
  assertEquals(escapePath(enc("a/", [0xff], '"\\')), '"a/\\377\\042\\134"');
});

Deno.test("classifyPaths exempts removals from the ancestor check, as findStudentModifiedFiles does", () => {
  // The §6.3 recheck shape: the handout at H no longer has foo/bar.ts, and the student's head has
  // a file at `foo`. The deletion is already satisfied; only a path the handout still wants there
  // is blocked.
  const student = new Map([["foo", { sha: OID1, type: "blob" as const, mode: "100644" }]]);
  const handout = new Map<string, { sha: string; type: "blob"; mode: string }>();
  assertEquals(Object.fromEntries(classifyPaths(["foo/bar.ts"], student, handout, new Set())), {
    "foo/bar.ts": "path_blocked_in_your_repo"
  });
  assertEquals(Object.fromEntries(classifyPaths(["foo/bar.ts"], student, handout, new Set(["foo/bar.ts"]))), {});
});
