/**
 * The shadow backstop in `processEnvelope` (build plan WP5, "Carried over"): a message marked
 * `shadow` is refused, archived and never synced, whichever consumer hands it over. Run in-process
 * against the scratch stack, with the git path configured exactly as the worker configures it and
 * GitHub stubbed (`stubs.ts`), so that without the backstop the call would run a real sync into
 * the `file://` remote and this test would see it.
 *
 * Env: WP5_DB_URL, WP5_API_URL, WP5_SERVICE_ROLE_KEY (set by run.sh).
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { GitHubAsyncEnvelope } from "../../../supabase/functions/_shared/GitHubAsyncTypes.ts";
import type { Database } from "../../../supabase/functions/_shared/SupabaseTypes.d.ts";
import { GitFixture } from "../../../supabase/functions/_shared/gitSync/testFixtures.ts";
import { harnessGitDeps, harnessRemote } from "./stubs.ts";

const DB_URL = Deno.env.get("WP5_DB_URL")!;
const T = "org/handout";

async function sql(query: string): Promise<string> {
  const out = await new Deno.Command("psql", {
    args: ["-XAtq", "-v", "ON_ERROR_STOP=1", DB_URL, "-c", query],
    stdout: "piped",
    stderr: "piped"
  }).output();
  if (!out.success) throw new Error(`psql failed: ${new TextDecoder().decode(out.stderr)}\n${query}`);
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test(
  "processEnvelope refuses a shadow message: archived, row untouched, nothing pushed",
  {
    sanitizeOps: false,
    sanitizeResources: false
  },
  async () => {
    const fx = await GitFixture.create("wp5-backstop-");
    try {
      // GitHubWrapper builds its App at import time and needs a key; this one signs nothing.
      const keyPath = `${fx.root}/app.pem`;
      await new Deno.Command("openssl", { args: ["genrsa", "-out", keyPath, "2048"], stderr: "null" }).output();
      Deno.env.set("GITHUB_APP_ID", "1");
      Deno.env.set("GITHUB_PRIVATE_KEY_STRING", await Deno.readTextFile(keyPath));
      const { processEnvelope } = await import("../../../supabase/functions/github-async-worker/index.ts");
      const { configureHandoutSyncGit } = await import("../../../supabase/functions/_shared/gitSync/syncEntry.ts");
      const { TemplateCache } = await import("../../../supabase/functions/_shared/gitSync/templateCache.ts");

      const ctrl = `${fx.root}/ctrl`;
      await Deno.mkdir(ctrl, { recursive: true });
      await Deno.writeTextFile(`${ctrl}/git-wrapper.sh`, `#!/bin/sh\nexec /usr/bin/git "$@"\n`);
      await Deno.chmod(`${ctrl}/git-wrapper.sh`, 0o755);
      configureHandoutSyncGit(
        {
          jobsDir: `${fx.root}/work/jobs`,
          templateCache: new TemplateCache(`${fx.root}/work/templates`),
          remote: harnessRemote(fx.root),
          maxRepoKib: 2 * 1024 * 1024
        },
        { testOnly: { deps: harnessGitDeps(fx.root, ctrl) } }
      );

      const before = { "README.md": "v1\n" };
      const template = await fx.createRepo(T);
      await template.commitOn("main", before);
      const H = await template.commitOn("main", { ...before, "new.txt": "added\n" });
      const name = "org/student-backstop";
      const student = await fx.createRepo(name);
      const S = await student.commitOn("main", before);

      await sql(`select pgmq.purge_queue('handout_sync'); delete from pgmq.a_handout_sync;`);
      const classId = await sql(`select id from public.classes where slug = 'wp5-worker-test'`);
      if (!classId) throw new Error("run worker.scratch.test.ts first; it seeds the class this test reuses");
      await sql(`delete from public.repositories where repository = '${name}'`);
      const repoId = Number(
        await sql(`insert into public.repositories (assignment_id, class_id, repository, synced_repo_sha, desired_handout_sha)
        select id, class_id, '${name}', '${S}', '${H}' from public.assignments where class_id = ${classId} and slug = 'hw'
        returning id`)
      );
      const envelope = {
        method: "sync_repo_to_handout",
        args: {
          repository_id: repoId,
          repository_full_name: name,
          template_repo: T,
          from_sha: null,
          to_sha: H,
          assignment_title: "hw",
          synced_repo_sha: S
        },
        class_id: Number(classId),
        repo_id: repoId,
        shadow: true
      };
      const msgId = Number(await sql(`select pgmq.send('handout_sync', '${JSON.stringify(envelope)}'::jsonb)`));
      const rowBefore = await sql(`select row_to_json(r)::text from public.repositories r where id = ${repoId}`);
      const refsBefore = await student.refs();

      const admin = createClient<Database>(Deno.env.get("WP5_API_URL")!, Deno.env.get("WP5_SERVICE_ROLE_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const ok = await processEnvelope(
        admin,
        envelope as GitHubAsyncEnvelope,
        { msg_id: msgId, enqueued_at: new Date().toISOString(), read_ct: 1, queue_name: "handout_sync" },
        new Sentry.Scope()
      );

      assertEquals(ok, false, "refused, so the caller has nothing to archive");
      assertEquals(await sql(`select count(*) from pgmq.a_handout_sync where msg_id = ${msgId}`), "1", "archived");
      assertEquals(await sql(`select count(*) from pgmq.q_handout_sync`), "0", "nothing requeued");
      assertEquals(await sql(`select row_to_json(r)::text from public.repositories r where id = ${repoId}`), rowBefore);
      assertEquals(await student.refs(), refsBefore, "nothing pushed");
      let rest = "";
      try {
        rest = await Deno.readTextFile(`${ctrl}/rest.jsonl`);
      } catch {
        // No REST call at all.
      }
      assertEquals(rest, "", "no GitHub call");
    } finally {
      await Deno.remove(fx.root, { recursive: true }).catch(() => {});
    }
  }
);
