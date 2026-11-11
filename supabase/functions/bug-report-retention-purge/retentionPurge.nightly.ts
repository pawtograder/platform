/**
 * H1–H3 against the real dev Sentry (nightly tier). Needs the delete-scoped SENTRY_PURGE_TOKEN
 * (human task HU3); without it every test here is skipped with that reason.
 *
 * What it does:
 *   1. Inserts two synthetic classes into the local database, with ids from a reserved high range so
 *      they can't collide with a real class id in the shared dev organization: one that ended 31 days
 *      ago (H1) and one that ended 29 days ago (H2).
 *   2. Sends a feedback item and a replay for each class, and one of each without a class_id (H3),
 *      to pawtograder-web through the DSN, all in the environment `bug-report-purge-test` and tagged
 *      with a per-run marker.
 *   3. Runs the purge through the real candidate RPC, limited to the two synthetic classes so it
 *      can't purge another deployment's reports that happen to share a class id, and with the
 *      environment filter set to the test environment.
 *   4. Checks through the Sentry API that only the H1 class's reports are gone, then deletes what's
 *      left by id.
 *
 * Known fault: the dev Sentry currently accepts replay envelopes but stores none (research report,
 * 2026-09-29), so the replay half of this test fails there until that's fixed. The failure message
 * says so.
 *
 * Env: SENTRY_PURGE_TOKEN, SENTRY_URL, SENTRY_ORG, SENTRY_PROJECT, NEXT_PUBLIC_SENTRY_DSN, and
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the local database.
 *
 * Run from supabase/functions:
 *   deno test --allow-env --allow-net --allow-read bug-report-retention-purge/retentionPurge.nightly.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { RETENTION_GRACE_DAYS, runPurge, SENTRY_LOOKBACK_DAYS, SentryPurgeApi } from "./purge.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const REQUIRED = [
  "SENTRY_PURGE_TOKEN",
  "SENTRY_URL",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];
const missing = REQUIRED.filter((k) => !env(k));
const skipReason = !env("SENTRY_PURGE_TOKEN")
  ? "SENTRY_PURGE_TOKEN is not set (human task HU3: create the delete-scoped purge-dev token)"
  : missing.length
    ? `missing env: ${missing.join(", ")}`
    : null;
if (skipReason) console.warn(`[retention purge nightly] skipped: ${skipReason}`);

const ENVIRONMENT = "bug-report-purge-test";
const DAY = 24 * 60 * 60 * 1000;
const RUN = crypto.randomUUID().replaceAll("-", "");
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const reservedId = () => 900_000_000 + Math.floor(Math.random() * 99_000_000);

async function sentryGet(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${env("SENTRY_URL").replace(/\/+$/, "")}/api/0${path}${sep}${qs}`, {
    headers: { Authorization: `Bearer ${env("SENTRY_PURGE_TOKEN")}` }
  });
  // 404 until Sentry has seen an event in the test environment.
  if (res.status === 404 && params.environment) return path.includes("/replays/") ? { data: [] } : [];
  if (!res.ok) throw new Error(`GET ${path.split("/")[3] ?? "?"} -> ${res.status}`);
  return await res.json();
}

/** Feedback issues from this run, keyed by the class_id tag the test gave them ("none" when absent). */
async function runFeedback(): Promise<Map<string, string>> {
  const issues = (await sentryGet(`/organizations/${env("SENTRY_ORG")}/issues/`, {
    project: "-1",
    environment: ENVIRONMENT,
    statsPeriod: "1d",
    query: `issue.category:feedback purge_test_run:${RUN}`,
    per_page: "100"
  })) as { id: string }[];
  const out = new Map<string, string>();
  for (const i of issues) {
    const tags = (await sentryGet(`/organizations/${env("SENTRY_ORG")}/issues/${i.id}/tags/purge_test_class/`, {})) as {
      topValues: { value: string }[];
    };
    out.set(tags.topValues[0]?.value ?? "?", i.id);
  }
  return out;
}

async function runReplays(projectId: string): Promise<Map<string, string>> {
  const qs = new URLSearchParams([
    ["field", "id"],
    ["field", "tags"]
  ]);
  const body = (await sentryGet(`/organizations/${env("SENTRY_ORG")}/replays/?${qs}`, {
    project: projectId,
    environment: ENVIRONMENT,
    statsPeriod: "1d",
    query: `purge_test_run:${RUN}`,
    per_page: "100"
  })) as { data: { id: string; tags?: Record<string, string[]> }[] };
  const out = new Map<string, string>();
  for (const r of body.data) out.set(r.tags?.purge_test_class?.[0] ?? "?", r.id);
  return out;
}

async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- envelopes, sent the way the browser SDK sends them ----

function envelopeUrl() {
  const dsn = new URL(env("NEXT_PUBLIC_SENTRY_DSN"));
  const projectId = dsn.pathname.replace(/^\/+/, "");
  return `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/?sentry_key=${dsn.username}&sentry_version=7`;
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sendEnvelope(parts: Uint8Array[]) {
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    body.set(p, o);
    o += p.length;
  }
  const res = await fetch(envelopeUrl(), {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-sentry-envelope" }
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`envelope -> ${res.status}`);
}

const enc = new TextEncoder();
const line = (v: unknown) => enc.encode(JSON.stringify(v) + "\n");

function tagsFor(label: string, classId: number | null) {
  const tags: Record<string, string> = { purge_test_run: RUN, purge_test_class: label, role: "student" };
  if (classId !== null) tags.class_id = String(classId);
  return tags;
}

async function sendFeedback(label: string, classId: number | null) {
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const event = {
    event_id: eventId,
    type: "feedback",
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "info",
    environment: ENVIRONMENT,
    tags: tagsFor(label, classId),
    user: { id: "retention-purge-test" },
    contexts: {
      feedback: { message: `retention purge test ${label}`, url: "http://localhost/course/[course_id]", source: "api" }
    }
  };
  await sendEnvelope([
    line({ event_id: eventId, sent_at: new Date().toISOString() }),
    line({ type: "feedback" }),
    line(event)
  ]);
}

async function sendReplay(label: string, classId: number | null) {
  const replayId = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  const events = [
    { type: 4, timestamp: now - 1000, data: { href: "http://localhost/course/1", width: 800, height: 600 } },
    {
      type: 2,
      timestamp: now - 999,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [{ type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [] }]
        }
      }
    }
  ];
  const recording = new Uint8Array([
    ...enc.encode(JSON.stringify({ segment_id: 0 }) + "\n"),
    ...(await deflate(enc.encode(JSON.stringify(events))))
  ]);
  const replayEvent = {
    type: "replay_event",
    event_id: replayId,
    replay_id: replayId,
    segment_id: 0,
    replay_type: "buffer",
    replay_start_timestamp: (now - 1000) / 1000,
    timestamp: now / 1000,
    urls: ["http://localhost/course/[course_id]"],
    error_ids: [],
    trace_ids: [],
    platform: "javascript",
    environment: ENVIRONMENT,
    tags: tagsFor(label, classId),
    user: { id: "retention-purge-test" }
  };
  await sendEnvelope([
    line({ event_id: replayId, sent_at: new Date().toISOString() }),
    line({ type: "replay_event" }),
    line(replayEvent),
    line({ type: "replay_recording", length: recording.length }),
    recording,
    enc.encode("\n")
  ]);
}

Deno.test({
  name: skipReason ? `H1–H3 retention purge (skipped: ${skipReason})` : "H1–H3 retention purge against the dev Sentry",
  ignore: skipReason !== null,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const supabase = createClient<Database>(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const h1 = reservedId();
    const h2 = h1 + 1;
    const { error: insertError } = await supabase.from("classes").insert([
      {
        id: h1,
        name: "E2E retention purge H1",
        slug: `e2e-ignore-purge-${h1}`,
        start_date: daysAgo(150),
        end_date: daysAgo(31)
      },
      {
        id: h2,
        name: "E2E retention purge H2",
        slug: `e2e-ignore-purge-${h2}`,
        start_date: daysAgo(150),
        end_date: daysAgo(29)
      }
    ]);
    assertEquals(insertError, null);

    const api = new SentryPurgeApi({
      baseUrl: env("SENTRY_URL"),
      org: env("SENTRY_ORG"),
      replayProject: env("SENTRY_PROJECT"),
      token: env("SENTRY_PURGE_TOKEN"),
      environment: ENVIRONMENT
    });
    const projectId = await api.replayProjectId();

    try {
      for (const [label, classId] of [
        ["h1", h1],
        ["h2", h2],
        ["none", null]
      ] as const) {
        await sendFeedback(label, classId);
        await sendReplay(label, classId);
      }

      const feedback = await poll(runFeedback, (m) => m.size === 3, 60_000);
      assertEquals(feedback.size, 3, "feedback not visible within 60 s: treat as a Sentry infrastructure fault");
      const replays = await poll(
        () => runReplays(projectId),
        (m) => m.size === 3,
        60_000
      );
      assertEquals(
        replays.size,
        3,
        "replays not visible within 60 s. Known dev Sentry fault as of 2026-09-29: replay envelopes are accepted but not stored"
      );

      // The real candidate query decides which class is due; only the two synthetic classes are purged.
      const { data: candidates, error } = await supabase.rpc("get_bug_report_retention_purge_candidates", {
        p_grace_days: RETENTION_GRACE_DAYS,
        p_lookback_days: SENTRY_LOOKBACK_DAYS,
        p_resweep_after_hours: 20,
        p_limit: 10_000
      });
      assertEquals(error, null);
      const ours = (candidates ?? []).filter((c) => c.class_id === h1 || c.class_id === h2);
      assertEquals(
        ours.map((c) => c.class_id),
        [h1],
        "H2: a class that ended 29 days ago is not a candidate"
      );

      const summary = await runPurge({
        api,
        candidates: ours,
        recordPurged: async (classId, r) => {
          const { error } = await supabase.rpc("record_bug_report_retention_purge", {
            p_class_id: classId,
            p_feedback_deleted: r.feedbackDeleted,
            p_replays_deleted: r.replaysDeleted
          });
          if (error) throw error;
        }
      });
      assertEquals(summary.stopped_by, null);
      assertEquals(summary.feedback_deleted, 1);
      assertEquals(summary.replays_deleted, 1);

      // Sentry deletes asynchronously.
      const after = await poll(runFeedback, (m) => !m.has("h1"), 120_000);
      assert(!after.has("h1"), "H1: feedback for the class that ended 31 days ago is gone");
      assert(after.has("h2"), "H2: feedback for the class that ended 29 days ago is still there");
      assert(after.has("none"), "H3: feedback without a class_id is still there");
      const afterReplays = await poll(
        () => runReplays(projectId),
        (m) => !m.has("h1"),
        120_000
      );
      assert(!afterReplays.has("h1"), "H1: replay gone");
      assert(afterReplays.has("h2"), "H2: replay still there");
      assert(afterReplays.has("none"), "H3: replay without a class_id still there");
    } finally {
      // Remove what this run left, by id, matched through the run marker.
      const leftFeedback = await runFeedback().catch(() => new Map<string, string>());
      if (leftFeedback.size) await api.deleteIssues([...leftFeedback.values()]).catch(() => {});
      const leftReplays = await runReplays(projectId).catch(() => new Map<string, string>());
      for (const id of leftReplays.values()) await api.deleteReplay(id).catch(() => {});
      await supabase.from("classes").delete().in("id", [h1, h2]);
    }
  }
});
