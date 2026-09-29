/**
 * Unit tests for the bug report retention purge against an in-memory Sentry API (tests H1–H3 in the
 * PR tier, plus pagination, the exact-tag guard and rate limiting). The real-Sentry version of H1–H3
 * is retentionPurge.nightly.ts.
 *
 * Run from supabase/functions:  deno test bug-report-retention-purge/
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FetchLike,
  isPastRetention,
  nextCursor,
  type PurgeCandidate,
  runPurge,
  SentryPurgeApi,
  type SentryPurgeConfig
} from "./purge.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

const CFG: SentryPurgeConfig = {
  baseUrl: "https://sentry.test/",
  org: "pawtograder-dev",
  replayProject: "pawtograder-web",
  token: "purge-token"
};

type Issue = { id: string; category: string; classIds: string[] };
type Replay = { id: string; classIds: string[] };

/**
 * A small Sentry: the list, tag, and delete endpoints the purge calls. Its search is deliberately
 * configurable, so the tests can make it sloppier than the real one and check that the guard holds.
 */
class FakeSentry {
  issues = new Map<string, Issue>();
  replays = new Map<string, Replay>();
  requests: { method: string; path: string; params: URLSearchParams; auth: string | null }[] = [];
  /** Answer the next N requests with 429. */
  throttleNext = 0;
  retryAfterSeconds = "1";
  /** Page size the fake uses, whatever per_page asks for. */
  pageSize = 100;
  /** How the fake matches `class_id:"N"`: exact like Sentry 26.5, or a prefix match to test the guard. */
  search: "exact" | "prefix" = "exact";

  addIssue(i: Issue) {
    this.issues.set(i.id, i);
  }
  addReplay(r: Replay) {
    this.replays.set(r.id, r);
  }

  private matches(values: string[], query: string): boolean {
    const m = query.match(/class_id:"?(\d+)"?/);
    if (!m) return false;
    return values.some((v) => (this.search === "exact" ? v === m[1] : v.startsWith(m[1])));
  }

  private page<T>(items: T[], params: URLSearchParams, url: URL) {
    const offset = Number(params.get("cursor")?.split(":")[1] ?? 0);
    const slice = items.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < items.length;
    const next = `0:${offset + this.pageSize}:0`;
    const link =
      `<${url.origin}${url.pathname}?cursor=0:${offset}:1>; rel="previous"; results="false"; cursor="0:${offset}:1", ` +
      `<${url.origin}${url.pathname}?cursor=${next}>; rel="next"; results="${more}"; cursor="${next}"`;
    return { slice, link };
  }

  fetch: FetchLike = (input, init) => {
    const url = new URL(String(input));
    const method = init.method;
    const path = url.pathname.replace(/^\/api\/0/, "");
    const params = url.searchParams;
    this.requests.push({
      method,
      path,
      params,
      auth: init.headers.Authorization ?? null
    });
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": this.retryAfterSeconds } }));
    }
    const ok = (body: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve(Response.json(body, { headers }));

    if (method === "GET" && path === "/projects/pawtograder-dev/pawtograder-web/") return ok({ id: "7" });

    if (method === "GET" && path === "/organizations/pawtograder-dev/issues/") {
      const q = params.get("query") ?? "";
      const all = [...this.issues.values()].filter(
        (i) => (!q.includes("issue.category:feedback") || i.category === "feedback") && this.matches(i.classIds, q)
      );
      const { slice, link } = this.page(all, params, url);
      return ok(
        slice.map((i) => ({ id: i.id, issueCategory: i.category })),
        { Link: link }
      );
    }
    const tagPath = path.match(/^\/organizations\/pawtograder-dev\/issues\/([^/]+)\/tags\/class_id\/$/);
    if (method === "GET" && tagPath) {
      const issue = this.issues.get(tagPath[1]);
      if (!issue || issue.classIds.length === 0) return Promise.resolve(Response.json({}, { status: 404 }));
      const unique = [...new Set(issue.classIds)];
      return ok({ key: "class_id", uniqueValues: unique.length, topValues: unique.map((value) => ({ value })) });
    }
    if (method === "DELETE" && path === "/organizations/pawtograder-dev/issues/") {
      const ids = params.getAll("id");
      if (ids.length === 0 || ids.length > 1000) return Promise.resolve(new Response(null, { status: 400 }));
      for (const id of ids) this.issues.delete(id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (method === "GET" && path === "/organizations/pawtograder-dev/replays/") {
      const q = params.get("query") ?? "";
      const all = [...this.replays.values()].filter((r) => this.matches(r.classIds, q));
      const { slice, link } = this.page(all, params, url);
      return ok(
        { data: slice.map((r) => ({ id: r.id, tags: r.classIds.length ? { class_id: r.classIds } : {} })) },
        {
          Link: link
        }
      );
    }
    const replayPath = path.match(/^\/projects\/pawtograder-dev\/pawtograder-web\/replays\/([0-9a-f]+)\/$/);
    if (method === "DELETE" && replayPath) {
      this.replays.delete(replayPath[1]);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

const replayId = (n: number) => n.toString(16).padStart(32, "0");

function setup(sentry: FakeSentry, sleeps: number[] = []) {
  const recorded: { classId: number; feedback: number; replays: number }[] = [];
  const api = new SentryPurgeApi(CFG, sentry.fetch, async (ms) => {
    sleeps.push(ms);
  });
  const run = (candidates: PurgeCandidate[]) =>
    runPurge({
      api,
      candidates,
      now: () => NOW,
      recordPurged: async (classId, r) => {
        recorded.push({ classId, feedback: r.feedbackDeleted, replays: r.replaysDeleted });
      }
    });
  return { api, run, recorded };
}

Deno.test("H1: a class that ended 31 days ago loses its feedback and replays", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "101", category: "feedback", classIds: ["11"] });
  sentry.addReplay({ id: replayId(1), classIds: ["11"] });
  const { run, recorded } = setup(sentry);

  const summary = await run([{ class_id: 11, end_date: daysAgo(31) }]);

  assertEquals(sentry.issues.size, 0);
  assertEquals(sentry.replays.size, 0);
  assertEquals(summary.feedback_deleted, 1);
  assertEquals(summary.replays_deleted, 1);
  assertEquals(summary.classes_purged, 1);
  assertEquals(recorded, [{ classId: 11, feedback: 1, replays: 1 }]);
  assert(sentry.requests.every((r) => r.auth === "Bearer purge-token"));
});

Deno.test("H2: a class that ended 29 days ago is not touched, even if the candidate query returns it", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "201", category: "feedback", classIds: ["22"] });
  sentry.addReplay({ id: replayId(2), classIds: ["22"] });
  const { run, recorded } = setup(sentry);

  const summary = await run([{ class_id: 22, end_date: daysAgo(29) }]);

  assertEquals(sentry.issues.size, 1);
  assertEquals(sentry.replays.size, 1);
  assertEquals(summary.classes_not_due, 1);
  assertEquals(summary.feedback_deleted + summary.replays_deleted, 0);
  assertEquals(recorded, []);
  assertEquals(sentry.requests.length, 0, "no Sentry request at all for a class that isn't due");
});

Deno.test("H3: reports without a class_id survive a purge that finds them in its search", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "301", category: "feedback", classIds: ["33"] });
  sentry.addIssue({ id: "302", category: "feedback", classIds: [] });
  sentry.addReplay({ id: replayId(3), classIds: [] });
  // Make the search return everything, so only the guard stands between these and a delete.
  const permissive = new FakeSentry();
  permissive.issues = sentry.issues;
  permissive.replays = sentry.replays;
  (permissive as unknown as { matches: () => boolean }).matches = () => true;
  const { run } = setup(permissive);

  const summary = await run([{ class_id: 33, end_date: daysAgo(31) }]);

  assertEquals([...sentry.issues.keys()], ["302"]);
  assertEquals(sentry.replays.size, 1);
  assertEquals(summary.feedback_deleted, 1);
  assertEquals(summary.skipped_tag_mismatch, 2);
});

Deno.test("exact-tag guard: purging class 1 never deletes class 10's reports", async () => {
  const sentry = new FakeSentry();
  sentry.search = "prefix";
  sentry.addIssue({ id: "1", category: "feedback", classIds: ["1"] });
  sentry.addIssue({ id: "10", category: "feedback", classIds: ["10"] });
  sentry.addIssue({ id: "11", category: "feedback", classIds: ["1", "10"] });
  sentry.addReplay({ id: replayId(1), classIds: ["1"] });
  sentry.addReplay({ id: replayId(10), classIds: ["10"] });
  sentry.addReplay({ id: replayId(11), classIds: ["1", "10"] });
  const { run } = setup(sentry);

  const summary = await run([{ class_id: 1, end_date: daysAgo(31) }]);

  assertEquals([...sentry.issues.keys()].sort(), ["10", "11"]);
  assertEquals([...sentry.replays.keys()].sort(), [replayId(10), replayId(11)]);
  assertEquals(summary.feedback_deleted, 1);
  assertEquals(summary.replays_deleted, 1);
  assertEquals(summary.skipped_tag_mismatch, 4);
  const q = sentry.requests.find((r) => r.path.endsWith("/issues/") && r.method === "GET")!.params.get("query");
  assertEquals(q, 'issue.category:feedback class_id:"1"');
});

Deno.test("an error issue tagged with the class is left alone; only feedback is purged", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "401", category: "error", classIds: ["44"] });
  sentry.addIssue({ id: "402", category: "feedback", classIds: ["44"] });
  const { run } = setup(sentry);
  await run([{ class_id: 44, end_date: daysAgo(40) }]);
  assertEquals([...sentry.issues.keys()], ["401"]);
});

Deno.test("pagination: follows Link cursors and deletes feedback in batches of at most 100", async () => {
  const sentry = new FakeSentry();
  sentry.pageSize = 100;
  for (let i = 0; i < 250; i++) sentry.addIssue({ id: String(1000 + i), category: "feedback", classIds: ["55"] });
  for (let i = 0; i < 130; i++) sentry.addReplay({ id: replayId(5000 + i), classIds: ["55"] });
  const { run } = setup(sentry);

  const summary = await run([{ class_id: 55, end_date: daysAgo(31) }]);

  assertEquals(sentry.issues.size, 0);
  assertEquals(sentry.replays.size, 0);
  assertEquals(summary.feedback_deleted, 250);
  assertEquals(summary.replays_deleted, 130);
  const lists = sentry.requests.filter((r) => r.method === "GET" && r.path.endsWith("/issues/"));
  assertEquals(
    lists.map((r) => r.params.get("cursor")),
    [null, "0:100:0", "0:200:0"]
  );
  const deletes = sentry.requests.filter((r) => r.method === "DELETE" && r.path.endsWith("/issues/"));
  assertEquals(
    deletes.map((r) => r.params.getAll("id").length),
    [100, 100, 50]
  );
  const replayLists = sentry.requests.filter((r) => r.path.endsWith("/replays/") && r.method === "GET");
  assertEquals(replayLists.length, 2);
  assertEquals(replayLists[0].params.get("project"), "7");
});

Deno.test("429: waits Retry-After and carries on", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "601", category: "feedback", classIds: ["66"] });
  sentry.throttleNext = 2;
  sentry.retryAfterSeconds = "3";
  const sleeps: number[] = [];
  const { run } = setup(sentry, sleeps);

  const summary = await run([{ class_id: 66, end_date: daysAgo(31) }]);

  assertEquals(sleeps, [3000, 3000]);
  assertEquals(summary.classes_purged, 1);
  assertEquals(sentry.issues.size, 0);
});

Deno.test("429 that keeps coming stops the run and records nothing", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "701", category: "feedback", classIds: ["77"] });
  sentry.addIssue({ id: "702", category: "feedback", classIds: ["78"] });
  sentry.throttleNext = 1000;
  const { run, recorded } = setup(sentry);

  const summary = await run([
    { class_id: 77, end_date: daysAgo(31) },
    { class_id: 78, end_date: daysAgo(31) }
  ]);

  assertEquals(summary.stopped_by, "resolve_project:429");
  assertEquals(summary.classes_deferred, 2);
  assertEquals(recorded, []);
  assertEquals(sentry.issues.size, 2);
  assertEquals(sentry.requests.length, 5, "five attempts, then give up");
});

Deno.test("a Retry-After longer than the cap gives up instead of sleeping through the run", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "801", category: "feedback", classIds: ["88"] });
  sentry.throttleNext = 1;
  sentry.retryAfterSeconds = "3600";
  const sleeps: number[] = [];
  const { run } = setup(sentry, sleeps);
  const summary = await run([{ class_id: 88, end_date: daysAgo(31) }]);
  assertEquals(sleeps, []);
  assertEquals(summary.stopped_by, "resolve_project:429");
});

Deno.test("a 403 (token without delete scope) stops the run; the class stays unrecorded", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "901", category: "feedback", classIds: ["99"] });
  const base = sentry.fetch;
  sentry.fetch = (input, init) =>
    init.method === "DELETE" ? Promise.resolve(new Response("{}", { status: 403 })) : base(input, init);
  const { run, recorded } = setup(sentry);

  const summary = await run([
    { class_id: 99, end_date: daysAgo(31) },
    { class_id: 98, end_date: daysAgo(31) }
  ]);

  assertEquals(summary.stopped_by, "delete_feedback:403");
  assertEquals(summary.classes_failed, 1);
  assertEquals(summary.classes_deferred, 1);
  assertEquals(recorded, []);
});

Deno.test("a 5xx is retried with backoff, then one class fails and the next still runs", async () => {
  const sentry = new FakeSentry();
  sentry.addIssue({ id: "1101", category: "feedback", classIds: ["12"] });
  const base = sentry.fetch;
  sentry.fetch = (input, init) =>
    String(input).includes("class_id%3A%2213%22")
      ? Promise.resolve(new Response("boom", { status: 502 }))
      : base(input, init);
  const sleeps: number[] = [];
  const { run, recorded } = setup(sentry, sleeps);

  const summary = await run([
    { class_id: 13, end_date: daysAgo(31) },
    { class_id: 12, end_date: daysAgo(31) }
  ]);

  assertEquals(sleeps, [1000, 2000, 4000, 8000]);
  assertEquals(summary.classes_failed, 1);
  assertEquals(summary.classes_purged, 1);
  assertEquals(
    recorded.map((r) => r.classId),
    [12]
  );
});

Deno.test("SENTRY_PURGE_ENVIRONMENT narrows both searches to one environment", async () => {
  const sentry = new FakeSentry();
  const api = new SentryPurgeApi({ ...CFG, environment: "staging" }, sentry.fetch, async () => {});
  await runPurge({
    api,
    candidates: [{ class_id: 5, end_date: daysAgo(31) }],
    now: () => NOW,
    recordPurged: async () => {}
  });
  const lists = sentry.requests.filter((r) => r.method === "GET" && /\/(issues|replays)\/$/.test(r.path));
  assertEquals(lists.length, 2);
  assert(lists.every((r) => r.params.get("environment") === "staging" && r.params.get("statsPeriod") === "365d"));
});

Deno.test("an environment Sentry has never seen (404 on the list) counts as nothing to delete", async () => {
  const sentry = new FakeSentry();
  const base = sentry.fetch;
  sentry.fetch = (input, init) =>
    /\/(issues|replays)\/\?/.test(input) ? Promise.resolve(new Response("{}", { status: 404 })) : base(input, init);
  const api = new SentryPurgeApi({ ...CFG, environment: "never-used" }, sentry.fetch, async () => {});
  const summary = await runPurge({
    api,
    candidates: [{ class_id: 5, end_date: daysAgo(31) }],
    now: () => NOW,
    recordPurged: async () => {}
  });
  assertEquals(summary.classes_purged, 1);
  assertEquals(summary.stopped_by, null);
});

Deno.test("isPastRetention: strictly more than 30 days after end_date", () => {
  assertEquals(isPastRetention(daysAgo(31), NOW), true);
  assertEquals(isPastRetention(daysAgo(29), NOW), false);
  assertEquals(isPastRetention("2026-08-30", new Date("2026-09-29T00:00:00Z")), false);
  assertEquals(isPastRetention("2026-08-30", new Date("2026-09-29T00:00:01Z")), true);
  assertEquals(isPastRetention("not a date", NOW), false);
});

Deno.test("nextCursor: only a next link that says it has results", () => {
  const link = (results: string) =>
    `<https://s/x?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://s/x?cursor=0:100:0>; rel="next"; results="${results}"; cursor="0:100:0"`;
  assertEquals(nextCursor(link("true")), "0:100:0");
  assertEquals(nextCursor(link("false")), null);
  assertEquals(nextCursor(null), null);
});
