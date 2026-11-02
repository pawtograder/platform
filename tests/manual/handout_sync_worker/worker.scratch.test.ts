/**
 * WP5 acceptance tests for the handout-sync worker (docs/handout-sync-git-build-plan.md, WP5),
 * against an ISOLATED scratch Supabase stack. Run through `run.sh`, which refuses the shared
 * stacks. Each case builds `file://` remotes, seeds one repository row, puts a message on
 * `handout_sync`, and starts the real worker as a child process (`harness.ts`), so `kill -9`,
 * SIGTERM and the process tree are the real ones.
 *
 * Every git call the worker makes goes through `git-wrapper.sh` in the case's control dir. It
 * runs `/usr/bin/git` unchanged, except that a `push` waits while `slow-push` exists, which is how
 * a case holds a job mid-push. The wait is a `sleep` child in git's process group with the job
 * directory as HOME, so "no orphan git" is checked by scanning /proc for that HOME.
 *
 * Rows and messages carry a recorded handout revision (`from_sha` = F), as almost every real sync
 * does. That makes the handler ask GitHub which way the handout moved
 * (`classifyHandoutDirection`). The worker runs with `--allow-net` limited to loopback, so the
 * request fails before it leaves the machine, the answer is "undetermined", and the handler goes on
 * because the message carries the revision the row is waiting for.
 *
 * Env: WP5_DB_URL, WP5_API_URL, WP5_SERVICE_ROLE_KEY (set by run.sh).
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { FixtureRepo, GitFixture } from "../../../supabase/functions/_shared/gitSync/testFixtures.ts";
import { planHandoutSync } from "../../../supabase/functions/_shared/gitSync/engine.ts";

const DB_URL = Deno.env.get("WP5_DB_URL")!;
const API_URL = Deno.env.get("WP5_API_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("WP5_SERVICE_ROLE_KEY")!;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const HARNESS = new URL("./harness.ts", import.meta.url).pathname;
const T = "org/handout";

/** The identity the harness's stub resolves for the App's bot (`GET /users/...` returns id 4242). */
const BOT = { name: "pawtograder-test[bot]", email: "4242+pawtograder-test[bot]@users.noreply.github.com" };

// ---------------------------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------------------------

async function sql(query: string): Promise<string> {
  const out = await new Deno.Command("psql", {
    args: ["-XAtq", "-v", "ON_ERROR_STOP=1", DB_URL, "-c", query],
    stdout: "piped",
    stderr: "piped"
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`psql failed: ${stderr}\n${query}`);
  return new TextDecoder().decode(out.stdout).trim();
}

async function sqlJson<T>(query: string): Promise<T> {
  return JSON.parse((await sql(`select coalesce(json_agg(q), '[]'::json) from (${query}) q`)) || "[]") as T;
}

interface QueueRow {
  msg_id: number;
  read_ct: number;
  vt: string;
  message: Record<string, unknown>;
}

const queued = (queue: string, where = "true") =>
  sqlJson<QueueRow[]>(`select msg_id, read_ct, vt, message from pgmq.q_${queue} where ${where} order by msg_id`);
const archived = (queue: string, where = "true") =>
  sqlJson<QueueRow[]>(`select msg_id, read_ct, vt, message from pgmq.a_${queue} where ${where} order by msg_id`);

/** Empties every queue and table these cases write to, so each starts from the same state. */
async function resetDb(): Promise<void> {
  await sql(`
    select pgmq.purge_queue('handout_sync');
    select pgmq.purge_queue('handout_sync_dlq');
    select pgmq.purge_queue('async_calls_dlq');
    delete from pgmq.a_handout_sync;
    delete from pgmq.a_handout_sync_dlq;
    delete from public.handout_sync_shadow_results;
    delete from public.github_circuit_breakers;
    delete from public.github_async_errors;
  `);
}

let classId: number | undefined;

/** One class and assignment for every case; one repository row per student repo. */
async function seedRepository(
  fullName: string,
  fromSha: string,
  syncedRepoSha: string,
  toSha: string
): Promise<number> {
  if (classId === undefined) {
    const existing = await sql(`select id from public.classes where slug = 'wp5-worker-test'`);
    if (existing) classId = Number(existing);
    else {
      classId = Number(
        await sql(`
        with c as (insert into public.classes (name, slug, github_org) values ('wp5', 'wp5-worker-test', 'org') returning id),
             s as (insert into public.assignment_self_review_settings (class_id) select id from c returning id, class_id)
        insert into public.assignments (class_id, title, slug, total_points, due_date, group_config, self_review_setting_id, template_repo)
          select s.class_id, 'hw', 'hw', 10, now() + interval '7 days', 'individual', s.id, '${T}' from s
        returning class_id`)
      );
    }
  }
  await sql(`delete from public.repositories where repository = '${fullName}'`);
  return Number(
    await sql(`
    insert into public.repositories (assignment_id, class_id, repository, synced_handout_sha, synced_repo_sha, desired_handout_sha)
      select a.id, a.class_id, '${fullName}', '${fromSha}', '${syncedRepoSha}', '${toSha}'
      from public.assignments a where a.class_id = ${classId} and a.slug = 'hw'
    returning id`)
  );
}

function envelope(
  repositoryId: number,
  fullName: string,
  fromSha: string,
  toSha: string,
  extra: Record<string, unknown> = {}
) {
  return {
    method: "sync_repo_to_handout",
    args: {
      repository_id: repositoryId,
      repository_full_name: fullName,
      template_repo: T,
      from_sha: fromSha,
      to_sha: toSha,
      assignment_title: "hw"
    },
    class_id: classId,
    repo_id: repositoryId,
    ...extra
  };
}

async function send(queue: string, message: unknown): Promise<number> {
  const quoted = JSON.stringify(message).replaceAll("'", "''");
  return Number(await sql(`select pgmq.send('${queue}', '${quoted}'::jsonb)`));
}

const repoRow = (id: number) => sql(`select row_to_json(r)::text from public.repositories r where id = ${id}`);

// ---------------------------------------------------------------------------------------------
// Fixtures and the worker process
// ---------------------------------------------------------------------------------------------

interface Case {
  fx: GitFixture;
  ctrl: string;
  template: FixtureRepo;
  F: string;
  H: string;
  students: Map<string, { repo: FixtureRepo; S: string; id: number }>;
}

const BEFORE = { "README.md": "handout v1\n", "src/Main.java": "class Main {}\n" };
const AFTER = { "README.md": "handout v1\n", "src/Main.java": "class Main {}\n", "src/New.java": "class New {}\n" };

async function setUp(students: string[]): Promise<Case> {
  await resetDb();
  const fx = await GitFixture.create("wp5-");
  const ctrl = `${fx.root}/ctrl`;
  await Deno.mkdir(ctrl, { recursive: true });
  // Stalls a push while `slow-push` exists; records each push's start.
  await Deno.writeTextFile(
    `${ctrl}/git-wrapper.sh`,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = push ]; then
    echo "$$" >> "${ctrl}/push-started"
    while [ -f "${ctrl}/slow-push" ]; do sleep 1; done
    break
  fi
done
exec /usr/bin/git "$@"
`
  );
  await Deno.chmod(`${ctrl}/git-wrapper.sh`, 0o755);
  const template = await fx.createRepo(T);
  const F = await template.commitOn("main", BEFORE, { message: "handout v1\n" });
  const H = await template.commitOn("main", AFTER, { message: "handout v2\n", date: "1700000500 -0500" });
  const map = new Map<string, { repo: FixtureRepo; S: string; id: number }>();
  for (const name of students) {
    const repo = await fx.createRepo(name);
    const S = await repo.commitOn("main", BEFORE, { message: "Initial commit\n" });
    map.set(name, { repo, S, id: await seedRepository(name, F, S, H) });
  }
  return { fx, ctrl, template, F, H, students: map };
}

async function tearDown(c: Case): Promise<void> {
  await killProcessesUnder(c.fx.root);
  await Deno.remove(c.fx.root, { recursive: true }).catch(() => {});
}

/** The commit an uninterrupted sync of `name` builds, computed with the engine directly. */
async function expectedPlan(c: Case, name: string) {
  const s = c.students.get(name)!;
  const plan = await planHandoutSync(
    { templateRepo: T, fromSha: c.F, toSha: c.H, syncedRepoSha: s.S, repoFullName: name },
    c.fx.jobContext({ identity: BOT })
  );
  assertEquals(plan.kind, "commit");
  return plan as Extract<typeof plan, { kind: "commit" }>;
}

let nextPort = 55490;

interface Worker {
  child: Deno.ChildProcess;
  port: number;
  log: string[];
  status: Promise<Deno.CommandStatus>;
}

async function startWorker(c: Case, settings: Record<string, number>): Promise<Worker> {
  const port = nextPort++;
  const keyPath = `${c.fx.root}/app.pem`;
  if (!(await exists(keyPath))) {
    await new Deno.Command("openssl", { args: ["genrsa", "-out", keyPath, "2048"], stderr: "null" }).output();
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      `--config=${REPO_ROOT}supabase/functions/deno.json`,
      // Loopback only: nothing the worker does may reach GitHub or anything else off this host.
      `--allow-net=127.0.0.1,localhost,0.0.0.0:${port}`,
      "--allow-env",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-sys",
      HARNESS
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: Deno.env.get("HOME") ?? c.fx.root,
      SUPABASE_URL: API_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY_STRING: await Deno.readTextFile(keyPath),
      NODE_ENV: "production",
      WP5_FIXTURE_ROOT: c.fx.root,
      WP5_CTRL_DIR: c.ctrl,
      HANDOUT_SYNC_METRICS_PORT: String(port),
      ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)]))
    },
    stdout: "piped",
    stderr: "piped"
  }).spawn();
  const log: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      log.push(...lines);
      if (Deno.env.get("WP5_VERBOSE")) for (const l of lines) console.error(`[worker:${port}] ${l}`);
    }
    if (buf) log.push(buf);
  };
  void pump(child.stdout);
  void pump(child.stderr);
  const worker: Worker = { child, port, log, status: child.status };
  await waitFor(`worker on ${port} healthy`, 60_000, async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      await r.body?.cancel();
      return r.status === 200;
    } catch {
      return false;
    }
  });
  return worker;
}

async function stopWorker(w: Worker): Promise<Deno.CommandStatus> {
  try {
    w.child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  return await w.status;
}

function events(w: Worker, msg: string): Array<Record<string, unknown>> {
  return w.log
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    })
    .filter((e) => e.component === "handout-sync-worker" && e.msg === msg);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** Pids whose environment has HOME under `root`: git children of a job, and anything they started. */
async function processesUnder(root: string): Promise<number[]> {
  const pids: number[] = [];
  for await (const e of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      const environ = await Deno.readTextFile(`/proc/${e.name}/environ`);
      if (environ.split("\0").some((kv) => kv.startsWith(`HOME=${root}/`))) pids.push(Number(e.name));
    } catch {
      // Exited, or not ours.
    }
  }
  return pids;
}

async function killProcessesUnder(root: string): Promise<number[]> {
  const pids = await processesUnder(root);
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  return pids;
}

async function pushStarted(c: Case): Promise<boolean> {
  return await exists(`${c.ctrl}/push-started`);
}

async function tokens(
  c: Case
): Promise<Array<{ org: string; repositories: string[]; permissions: Record<string, string> }>> {
  try {
    return (await Deno.readTextFile(`${c.ctrl}/tokens.jsonl`))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const NO_SANITIZE = { sanitizeOps: false, sanitizeResources: false };

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

Deno.test("a message runs end to end through processEnvelope and is archived", NO_SANITIZE, async () => {
  const name = "org/student-e2e";
  const c = await setUp([name]);
  const s = c.students.get(name)!;
  const expected = await expectedPlan(c, name);
  const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
  const w = await startWorker(c, {});
  try {
    await waitFor("the message to be archived", 60_000, async () => (await archived("handout_sync")).length === 1);
    const [a] = await archived("handout_sync");
    assertEquals(a.msg_id, msgId);
    assertEquals(a.read_ct, 1);
    assertEquals((await queued("handout_sync")).length, 0, "nothing requeued");
    // The branch carries the deterministic commit, and the stub's merge moved main to it.
    assertEquals(await s.repo.ref(`refs/heads/sync-to-${c.H.slice(0, 7)}`), expected.commit);
    assertEquals(await s.repo.ref("refs/heads/main"), expected.commit);
    const row = JSON.parse(await repoRow(s.id));
    assertEquals(row.synced_handout_sha, c.H);
    assertEquals(row.synced_repo_sha, expected.commit);
    assertEquals(row.sync_data.pr_state, "merged");
    // The student token carries the write scopes, the template token reads only.
    const t = await tokens(c);
    assertEquals(
      t.map((x) => [x.repositories.join(","), JSON.stringify(x.permissions)]),
      [
        ["handout", JSON.stringify({ contents: "read" })],
        ["student-e2e", JSON.stringify({ contents: "write", pull_requests: "write", workflows: "write" })]
      ]
    );
  } finally {
    await stopWorker(w);
    await tearDown(c);
  }
});

Deno.test("the heartbeat keeps a long job's message invisible: read once, vt renewed", NO_SANITIZE, async () => {
  const name = "org/student-hb";
  const c = await setUp([name]);
  const s = c.students.get(name)!;
  await Deno.writeTextFile(`${c.ctrl}/slow-push`, "");
  const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
  // VT 6 s and a job held for 15 s: without renewals the message is visible again at 6 s, and
  // the second free slot reads it a second time.
  const w = await startWorker(c, {
    HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS: 6,
    HANDOUT_SYNC_HEARTBEAT_SECONDS: 2,
    HANDOUT_SYNC_CONCURRENCY: 2
  });
  try {
    await waitFor("the push to start", 60_000, () => pushStarted(c));
    const vts: number[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const [q] = await queued("handout_sync", `msg_id = ${msgId}`);
      assertEquals(q.read_ct, 1, "read exactly once while the job runs");
      assert(new Date(q.vt).getTime() > Date.now(), "never visible while its job runs");
      vts.push(new Date(q.vt).getTime());
    }
    assert(vts[vts.length - 1] > vts[0], "the vt moved forward");
    await Deno.remove(`${c.ctrl}/slow-push`);
    await waitFor("the message to be archived", 60_000, async () => (await archived("handout_sync")).length === 1);
    assertEquals((await archived("handout_sync"))[0].read_ct, 1);
    assertEquals(events(w, "job started").length, 1);
    assert(events(w, "heartbeat").length >= 3);
  } finally {
    await stopWorker(w);
    await tearDown(c);
  }
});

Deno.test(
  "kill -9 mid-push: the message is visible again within 120 s and the re-run converges",
  NO_SANITIZE,
  async () => {
    const name = "org/student-kill";
    const c = await setUp([name]);
    const s = c.students.get(name)!;
    const expected = await expectedPlan(c, name);
    await Deno.writeTextFile(`${c.ctrl}/slow-push`, "");
    const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
    // Production timing: VT 120 s, heartbeat 45 s.
    const first = await startWorker(c, {
      HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS: 120,
      HANDOUT_SYNC_HEARTBEAT_SECONDS: 45
    });
    await waitFor("the push to start", 60_000, () => pushStarted(c));
    first.child.kill("SIGKILL");
    const killedAt = Date.now();
    await first.status;
    // The container's death takes git with it; a SIGKILLed Deno does not, so do it here.
    const orphans = await killProcessesUnder(c.fx.root);
    assert(orphans.length > 0, "the stalled push was running when the worker died");
    await Deno.remove(`${c.ctrl}/slow-push`);
    try {
      const [q] = await queued("handout_sync", `msg_id = ${msgId}`);
      assertEquals(q.read_ct, 1);
      const visibleIn = new Date(q.vt).getTime() - killedAt;
      console.log(`visible again ${Math.round(visibleIn / 1000)} s after the kill`);
      assert(visibleIn <= 120_000 + 1000, `visible within 120 s of the kill (got ${visibleIn} ms)`);
      assertEquals((await archived("handout_sync")).length, 0);

      const second = await startWorker(c, {
        HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS: 120,
        HANDOUT_SYNC_HEARTBEAT_SECONDS: 45
      });
      try {
        await waitFor("the redelivered message to be archived", 150_000, async () => {
          return (await archived("handout_sync")).length === 1;
        });
        const rerunAt = Date.now();
        console.log(`re-run archived ${Math.round((rerunAt - killedAt) / 1000)} s after the kill`);
        assertEquals((await archived("handout_sync"))[0].read_ct, 2);
        assertEquals(await s.repo.ref(`refs/heads/sync-to-${c.H.slice(0, 7)}`), expected.commit);
        assertEquals(await s.repo.ref("refs/heads/main"), expected.commit);
        const row = JSON.parse(await repoRow(s.id));
        assertEquals([row.synced_handout_sha, row.synced_repo_sha], [c.H, expected.commit]);
      } finally {
        await stopWorker(second);
      }
    } finally {
      await tearDown(c);
    }
  }
);

Deno.test(
  "SIGTERM: a job that finishes inside the grace is archived, and nothing new is read",
  NO_SANITIZE,
  async () => {
    const [a, b] = ["org/student-term-a", "org/student-term-b"];
    const c = await setUp([a, b]);
    const sa = c.students.get(a)!;
    const sb = c.students.get(b)!;
    await Deno.writeTextFile(`${c.ctrl}/slow-push`, "");
    const first = await send("handout_sync", envelope(sa.id, a, c.F, c.H));
    const w = await startWorker(c, { HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS: 60, HANDOUT_SYNC_CONCURRENCY: 2 });
    try {
      await waitFor("the push to start", 60_000, () => pushStarted(c));
      w.child.kill("SIGTERM");
      await waitFor(
        "the worker to stop reading",
        10_000,
        async () => events(w, "stop requested; no further reads").length === 1
      );
      // Sent after SIGTERM, with a slot free: it must not be read.
      const second = await send("handout_sync", envelope(sb.id, b, c.F, c.H));
      await new Promise((r) => setTimeout(r, 3000));
      await Deno.remove(`${c.ctrl}/slow-push`);
      const status = await w.status;
      assertEquals(status.code, 0);
      assertEquals(
        (await archived("handout_sync")).map((m) => m.msg_id),
        [first],
        "the in-flight job finished and was archived"
      );
      const [q] = await queued("handout_sync", `msg_id = ${second}`);
      assertEquals(q.read_ct, 0, "the message sent after SIGTERM was never read");
      assertEquals(JSON.parse(await repoRow(sa.id)).synced_handout_sha, c.H);
    } finally {
      await stopWorker(w);
      await tearDown(c);
    }
  }
);

Deno.test(
  "SIGTERM: past the grace, the job is aborted, its git killed, and its message left unarchived",
  NO_SANITIZE,
  async () => {
    const name = "org/student-term-abort";
    const c = await setUp([name]);
    const s = c.students.get(name)!;
    await Deno.writeTextFile(`${c.ctrl}/slow-push`, "");
    const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
    const w = await startWorker(c, { HANDOUT_SYNC_SHUTDOWN_GRACE_SECONDS: 3 });
    try {
      await waitFor("the push to start", 60_000, () => pushStarted(c));
      const before = JSON.parse(await repoRow(s.id));
      const signalledAt = Date.now();
      w.child.kill("SIGTERM");
      const status = await w.status;
      console.log(`exited ${Math.round((Date.now() - signalledAt) / 1000)} s after SIGTERM`);
      assertEquals(status.code, 0);
      assertEquals(await processesUnder(c.fx.root), [], "no git child outlives the worker");
      assertEquals((await archived("handout_sync")).length, 0, "the aborted job's message is not archived");
      const q = await queued("handout_sync");
      assertEquals(
        q.map((m) => [m.msg_id, m.read_ct]),
        [[msgId, 1]],
        "and not requeued as a new message"
      );
      // The fenced job wrote nothing after the abort: the row still holds the job's in_progress marker.
      const after = JSON.parse(await repoRow(s.id));
      assertEquals(after.sync_data.status, "in_progress");
      assertEquals(after.sync_data, before.sync_data);
      assertEquals(events(w, "shutdown grace over; aborting job without archiving it").length, 1);
    } finally {
      await stopWorker(w);
      await tearDown(c);
    }
  }
);

Deno.test("a job past its deadline has its git children killed and is retried", NO_SANITIZE, async () => {
  const name = "org/student-deadline";
  const c = await setUp([name]);
  const s = c.students.get(name)!;
  await Deno.writeTextFile(`${c.ctrl}/slow-push`, "");
  const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
  const w = await startWorker(c, {
    // Long enough to reach the push: the handler's direction check spends ~14 s in octokit's
    // retries before its (loopback-only) request to GitHub is reported as failed.
    HANDOUT_SYNC_JOB_DEADLINE_SECONDS: 25,
    HANDOUT_SYNC_VISIBILITY_TIMEOUT_SECONDS: 30,
    HANDOUT_SYNC_HEARTBEAT_SECONDS: 5
  });
  try {
    await waitFor("the push to start", 60_000, () => pushStarted(c));
    assert((await processesUnder(c.fx.root)).length > 0, "the stalled push is running");
    // processEnvelope's ordinary retry: the original is archived and a delayed copy is queued.
    await waitFor("the job to fail and be requeued", 60_000, async () => (await archived("handout_sync")).length === 1);
    assertEquals(await processesUnder(c.fx.root), [], "no orphan git, and no sleeping push, remains");
    assertEquals((await archived("handout_sync"))[0].msg_id, msgId);
    const q = await queued("handout_sync");
    assertEquals(q.length, 1);
    assertEquals(q[0].message.retry_count, 1);
    // processEnvelope's generic path: a 30 s delay behind the org/method circuit it just opened.
    assert(new Date(q[0].vt).getTime() > Date.now() + 15_000, "the retry is delayed");
    const row = JSON.parse(await repoRow(s.id));
    assertEquals(row.sync_data.status, "error");
    assert(String(row.sync_data.last_sync_error).includes("deadline"), row.sync_data.last_sync_error);
    assertEquals(await s.repo.ref(`refs/heads/sync-to-${c.H.slice(0, 7)}`), null, "nothing was pushed");
  } finally {
    await stopWorker(w);
    await tearDown(c);
  }
});

Deno.test("read_ct > 5 moves the message to handout_sync_dlq with the error on the row", NO_SANITIZE, async () => {
  const name = "org/student-poison";
  const c = await setUp([name]);
  const s = c.students.get(name)!;
  const msgId = await send("handout_sync", envelope(s.id, name, c.F, c.H));
  // Five earlier deliveries that each died without a trace.
  await sql(`update pgmq.q_handout_sync set read_ct = 5 where msg_id = ${msgId}`);
  const asyncDlqBefore = Number(await sql(`select count(*) from pgmq.q_async_calls_dlq`));
  const w = await startWorker(c, {});
  try {
    await waitFor("the message to leave handout_sync", 60_000, async () => (await queued("handout_sync")).length === 0);
    const dlq = await queued("handout_sync_dlq");
    assertEquals(dlq.length, 1);
    assertEquals((dlq[0].message.args as { repository_id: number }).repository_id, s.id);
    assertEquals(
      (await archived("handout_sync")).map((m) => [m.msg_id, m.read_ct]),
      [[msgId, 6]]
    );
    assertEquals(Number(await sql(`select count(*) from pgmq.q_async_calls_dlq`)), asyncDlqBefore);
    const row = JSON.parse(await repoRow(s.id));
    assertEquals(row.sync_data.status, "error");
    assert(String(row.sync_data.last_sync_error).includes("handout_sync_dlq"), row.sync_data.last_sync_error);
    assertEquals(await pushStarted(c), false, "the poison message ran no sync");
  } finally {
    await stopWorker(w);
    await tearDown(c);
  }
});

Deno.test(
  "a shadow message plans only: row untouched, nothing pushed, one prediction, none on redelivery",
  NO_SANITIZE,
  async () => {
    const name = "org/student-shadow";
    const c = await setUp([name]);
    const s = c.students.get(name)!;
    const expected = await expectedPlan(c, name);
    const rowBefore = await repoRow(s.id);
    const refsBefore = await s.repo.refs();
    const shadow = envelope(s.id, name, c.F, c.H, { shadow: true });
    (shadow.args as Record<string, unknown>).synced_repo_sha = s.S;
    const msgId = await send("handout_sync", shadow);
    const w = await startWorker(c, {});
    try {
      await waitFor(
        "the shadow message to be archived",
        60_000,
        async () => (await archived("handout_sync")).length === 1
      );
      const results = await sqlJson<Array<Record<string, unknown>>>(
        `select msg_id, repository_id, to_sha, from_sha, synced_repo_sha, predicted_tree, predicted_commit_parent, unresolved, error from public.handout_sync_shadow_results`
      );
      assertEquals(results, [
        {
          msg_id: msgId,
          repository_id: s.id,
          to_sha: c.H,
          from_sha: c.F,
          synced_repo_sha: s.S,
          predicted_tree: expected.tree,
          predicted_commit_parent: s.S,
          unresolved: [],
          error: null
        }
      ]);
      assertEquals(await repoRow(s.id), rowBefore, "the repositories row is byte-identical");
      assertEquals(await s.repo.refs(), refsBefore, "nothing was pushed");
      assertEquals(await pushStarted(c), false, "no push was even attempted");
      // Both tokens are read-only.
      for (const t of await tokens(c)) assertEquals(t.permissions, { contents: "read" });
      assertEquals((await tokens(c)).length, 2);

      // Redelivery of the same message (its pod died after the insert, before the archive).
      await sql(`
      insert into pgmq.q_handout_sync (msg_id, read_ct, enqueued_at, vt, message) overriding system value
        select msg_id, read_ct, enqueued_at, now(), message from pgmq.a_handout_sync where msg_id = ${msgId};
      delete from pgmq.a_handout_sync where msg_id = ${msgId};`);
      await waitFor("the redelivery to be archived", 60_000, async () => (await archived("handout_sync")).length === 1);
      assertEquals((await archived("handout_sync"))[0].read_ct, 2);
      assertEquals(Number(await sql(`select count(*) from public.handout_sync_shadow_results`)), 1);
      assertEquals(await repoRow(s.id), rowBefore);
      assertEquals(events(w, "shadow recorded").length, 2);
    } finally {
      await stopWorker(w);
      await tearDown(c);
    }
  }
);
