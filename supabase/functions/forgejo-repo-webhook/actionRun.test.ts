/**
 * Unit tests for recording finished Forgejo Actions runs.
 *
 * Run from supabase/functions:  deno test --no-check --allow-read --allow-env --allow-net forgejo-repo-webhook/
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { fakeSupabase, repositoryRow } from "../_shared/RepoPushFakeClient.ts";
import { forgejoTime, handleForgejoActionRun } from "./actionRun.ts";
import { actionRunPayload, RUN_SHA } from "./actionRunFixture.ts";

const FORGEJO_URL = "http://127.0.0.1:3100";
const RUN_URL = `${FORGEJO_URL}/cs101/hw1-alex/actions/runs/3`;

function tables(
  opts: {
    gitProvider?: string;
    submissions?: Record<string, unknown>[];
    graderResults?: Record<string, unknown>[];
    checkRunStatus?: Record<string, unknown>;
  } = {}
) {
  return {
    repositories: [repositoryRow({ id: 7, repository: "cs101/hw1-alex", git_provider: opts.gitProvider ?? "forgejo" })],
    repository_check_runs: [
      {
        id: 55,
        repository_id: 7,
        sha: RUN_SHA,
        status: opts.checkRunStatus ?? { created_at: "2026-11-09T16:53:34.000Z", created_by: "forgejo push by alex" }
      }
    ] as Record<string, unknown>[],
    submissions: opts.submissions ?? [],
    grader_results: opts.graderResults ?? [],
    workflow_run_error: [] as Record<string, unknown>[],
    workflow_events: [] as Record<string, unknown>[]
  };
}

const submission = (overrides: Record<string, unknown> = {}) => ({
  id: 900,
  repository_id: 7,
  sha: RUN_SHA,
  run_number: 42,
  run_attempt: 1,
  profile_id: "student-profile",
  assignment_group_id: null,
  // While the fixture's run was going (it started 16:53:40 and stopped 16:55:02).
  created_at: "2026-11-09T16:54:00.000Z",
  ...overrides
});

Deno.test("forgejoTime: Go's zero time and junk are null", () => {
  assertEquals(forgejoTime("2026-11-09T16:55:02Z"), "2026-11-09T16:55:02.000Z");
  assertEquals(forgejoTime("0001-01-01T00:00:00Z"), null);
  assertEquals(forgejoTime("not a time"), null);
  assertEquals(forgejoTime(undefined), null);
});

Deno.test("a failed grading run is logged, and the commit's check run is finished with its link", async () => {
  const { client, inserts, updates } = fakeSupabase(tables());
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());

  const event = inserts.find((i) => i.table === "workflow_events")?.row;
  assert(event);
  assertEquals(
    {
      workflow_run_id: event.workflow_run_id,
      repository_id: event.repository_id,
      class_id: event.class_id,
      github_repository_id: event.github_repository_id,
      event_type: event.event_type,
      status: event.status,
      conclusion: event.conclusion,
      head_sha: event.head_sha,
      head_branch: event.head_branch,
      run_number: event.run_number,
      run_attempt: event.run_attempt,
      workflow_path: event.workflow_path,
      actor_login: event.actor_login,
      run_started_at: event.run_started_at,
      run_updated_at: event.run_updated_at,
      provider: (event.payload as { provider: string }).provider
    },
    {
      workflow_run_id: 42,
      repository_id: 7,
      class_id: 10,
      github_repository_id: null,
      event_type: "completed",
      status: "completed",
      conclusion: "failure",
      head_sha: RUN_SHA,
      head_branch: "main",
      run_number: 3,
      run_attempt: 1,
      workflow_path: "grade.yml",
      actor_login: "alex",
      run_started_at: "2026-11-09T16:53:40.000Z",
      run_updated_at: "2026-11-09T16:55:02.000Z",
      provider: "forgejo"
    }
  );

  assertEquals(updates.length, 1);
  assertEquals(updates[0].table, "repository_check_runs");
  // Conditional on the status it was decided from, so a concurrent write is never overwritten.
  assertEquals(updates[0].filters, [
    ["id", 55],
    ["status", JSON.stringify({ created_at: "2026-11-09T16:53:34.000Z", created_by: "forgejo push by alex" })]
  ]);
  assertEquals(updates[0].values.status, {
    created_at: "2026-11-09T16:53:34.000Z",
    created_by: "forgejo push by alex",
    completed_at: "2026-11-09T16:55:02.000Z",
    conclusion: "failure",
    workflow_run_id: 42,
    workflow_run_url: RUN_URL,
    workflow_run_stopped_at: "2026-11-09T16:55:02.000Z"
  });
  // No submission came from the run, so there is nothing to give an error result.
  assertEquals(
    inserts.filter((i) => i.table === "grader_results"),
    []
  );
});

Deno.test("a successful run keeps the completed_at feedback wrote, and adds its outcome and link", async () => {
  const { client, updates } = fakeSupabase(
    tables({ checkRunStatus: { created_at: "2026-11-09T16:53:34.000Z", completed_at: "2026-11-09T16:54:59.000Z" } })
  );
  const run = actionRunPayload(FORGEJO_URL, { action: "success", status: "success" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  assertEquals(updates[0].values.status, {
    created_at: "2026-11-09T16:53:34.000Z",
    completed_at: "2026-11-09T16:54:59.000Z",
    conclusion: "success",
    workflow_run_id: 42,
    workflow_run_url: RUN_URL,
    workflow_run_stopped_at: "2026-11-09T16:55:02.000Z"
  });
});

Deno.test("a cancelled run's submission without a grader result gets an error result, like GitHub", async () => {
  const { client, inserts, upserts } = fakeSupabase(tables({ submissions: [submission()] }));
  const run = actionRunPayload(FORGEJO_URL, { status: "cancelled" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());

  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].table, "workflow_run_error");
  const errorRow = upserts[0].row as {
    submission_id: number;
    run_number: number;
    run_attempt: number;
    data: Record<string, unknown>;
  };
  assertEquals([errorRow.submission_id, errorRow.run_number, errorRow.run_attempt], [900, 42, 1]);
  assertEquals(errorRow.data.workflow_run_url, RUN_URL);
  assertEquals(errorRow.data.workflow_conclusion, "cancelled");
  assertEquals(errorRow.data.error_type, "missing_grader_result");

  const result = inserts.find((i) => i.table === "grader_results")?.row;
  assertEquals(
    [result?.submission_id, result?.score, result?.ret_code, result?.class_id, result?.profile_id],
    [900, 0, 137, 10, "student-profile"]
  );
});

Deno.test("a submission that already has a grader result is left alone", async () => {
  const { client, inserts, upserts } = fakeSupabase(
    tables({ submissions: [submission()], graderResults: [{ id: 1, submission_id: 900 }] })
  );
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(upserts, []);
  assertEquals(
    inserts.filter((i) => i.table === "grader_results"),
    []
  );
});

Deno.test("a re-run is matched to its latest attempt's submission, not the earlier one", async () => {
  const { client, inserts, upserts } = fakeSupabase(
    tables({
      submissions: [
        submission({ id: 900, run_attempt: 1, created_at: "2026-11-09T16:40:00.000Z" }),
        submission({ id: 901, run_attempt: 2 })
      ],
      graderResults: [{ id: 1, submission_id: 900 }]
    })
  );
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(inserts.find((i) => i.table === "workflow_events")?.row.run_attempt, 2);
  assertEquals(
    upserts.map((u) => (u.row as { submission_id: number }).submission_id),
    [901]
  );
});

Deno.test("attempt 1's completion delivered after attempt 2 started is not taken for attempt 2's", async () => {
  // A re-run keeps the run id and the payload has no attempt number. Attempt 2's submission was made
  // after attempt 1 stopped (16:55:02), so this completion is attempt 1's: attempt 2 must not get a
  // zero-score result before its own grader reports.
  const { client, inserts, upserts } = fakeSupabase(
    tables({
      submissions: [
        submission({ id: 900, run_attempt: 1 }),
        submission({ id: 901, run_attempt: 2, created_at: "2026-11-09T16:57:30.000Z" })
      ]
    })
  );
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(inserts.find((i) => i.table === "workflow_events")?.row.run_attempt, 1);
  assertEquals(
    upserts.map((u) => (u.row as { submission_id: number }).submission_id),
    [900]
  );
  assertEquals(
    inserts.filter((i) => i.table === "grader_results").map((i) => i.row.submission_id),
    [900]
  );
});

Deno.test("a completion from an attempt that made no submission reports on none of the later ones", async () => {
  const { client, inserts, upserts } = fakeSupabase(
    tables({ submissions: [submission({ id: 901, run_attempt: 2, created_at: "2026-11-09T16:57:30.000Z" })] })
  );
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(inserts.find((i) => i.table === "workflow_events")?.row.run_attempt, 1);
  assertEquals(upserts, []);
  assertEquals(
    inserts.filter((i) => i.table === "grader_results"),
    []
  );
});

Deno.test("a redelivered completion is logged once, so the Checks tab doesn't list it twice", async () => {
  const data = tables({ submissions: [submission()], graderResults: [{ id: 1, submission_id: 900 }] });
  const { client, inserts } = fakeSupabase(data);
  const run = actionRunPayload(FORGEJO_URL).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  assertEquals(inserts.filter((i) => i.table === "workflow_events").length, 1);
  // A re-run of the same run id stops at another time, so it is logged as its own row.
  const rerun = actionRunPayload(FORGEJO_URL).run;
  rerun.stopped = "2026-11-09T17:10:00Z";
  rerun.updated = "2026-11-09T17:10:00Z";
  await handleForgejoActionRun(client, rerun, new Sentry.Scope());
  assertEquals(inserts.filter((i) => i.table === "workflow_events").length, 2);
});

Deno.test("a run the grader already explained with a user-visible error gets no second, vaguer one", async () => {
  const data = tables({ submissions: [submission()] });
  data.workflow_run_error.push({
    id: 3,
    repository_id: 7,
    run_number: 42,
    run_attempt: 1,
    data: { type: "user_visible_error" }
  });
  const { client, inserts, upserts } = fakeSupabase(data);
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(upserts, []);
  assertEquals(
    inserts.filter((i) => i.table === "grader_results"),
    []
  );
});

Deno.test("an earlier attempt of the same run, delivered late, leaves the later attempt's outcome", async () => {
  const { client, updates } = fakeSupabase(
    tables({
      checkRunStatus: {
        created_at: "2026-11-09T16:53:34.000Z",
        completed_at: "2026-11-09T17:10:00.000Z",
        conclusion: "success",
        workflow_run_id: 42,
        workflow_run_url: RUN_URL,
        workflow_run_stopped_at: "2026-11-09T17:10:00.000Z"
      }
    })
  );
  // Attempt 1 stopped at 16:55:02 with a failure; attempt 2's success is already recorded.
  const run = actionRunPayload(FORGEJO_URL, { action: "failure", status: "failure" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  assertEquals(
    updates.filter((u) => u.table === "repository_check_runs"),
    []
  );
});

Deno.test("a status that changes between the read and the write is read again, not overwritten", async () => {
  // Another delivery records run 99 after this one read the row but before it wrote. The write is
  // conditional on the status it read, so it matches nothing; the reread sees run 99 and stops.
  const data = tables();
  const { client: base, updates } = fakeSupabase(data);
  let raced = false;
  const client = {
    from(table: string) {
      const chain = base.from(table as never) as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (table !== "repository_check_runs" || raced) return chain;
      const update = chain.update.bind(chain);
      chain.update = (values: unknown) => {
        raced = true;
        data.repository_check_runs[0].status = {
          created_at: "2026-11-09T16:53:34.000Z",
          completed_at: "2026-11-09T16:58:00.000Z",
          conclusion: "success",
          workflow_run_id: 99,
          workflow_run_url: `${FORGEJO_URL}/cs101/hw1-alex/actions/runs/9`
        };
        return update(values);
      };
      return chain;
    }
  } as unknown as typeof base;
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  assertEquals(updates.filter((u) => u.table === "repository_check_runs").length, 1);
  assertEquals((data.repository_check_runs[0].status as { workflow_run_id: number }).workflow_run_id, 99);
});

Deno.test("a workflow the student added is logged but doesn't touch the commit's check run", async () => {
  const { client, inserts, updates } = fakeSupabase(tables());
  await handleForgejoActionRun(
    client,
    actionRunPayload(FORGEJO_URL, { workflow_id: "lint.yml" }).run,
    new Sentry.Scope()
  );
  assertEquals(inserts.filter((i) => i.table === "workflow_events").length, 1);
  assertEquals(updates, []);
});

Deno.test("a run in a repository that isn't a Forgejo student repo is logged without a class", async () => {
  const { client, inserts, updates, upserts } = fakeSupabase(
    tables({ gitProvider: "github", submissions: [submission()] })
  );
  await handleForgejoActionRun(client, actionRunPayload(FORGEJO_URL).run, new Sentry.Scope());
  const event = inserts.find((i) => i.table === "workflow_events")?.row;
  assertEquals([event?.repository_id, event?.class_id, event?.run_attempt], [null, null, 1]);
  assertEquals(updates, []);
  assertEquals(upserts, []);
});

Deno.test("a superseded run's late completion never overwrites the newer run's outcome", async () => {
  // Re-running grading makes a second run for the same commit, and deliveries are not ordered:
  // Forgejo retries a delivery the receiver was slow to answer, so the first run's failure can
  // arrive after the second's success. Applying it would show the student a failing check for a
  // run that is no longer the current one.
  const { client, updates } = fakeSupabase(
    tables({
      checkRunStatus: {
        created_at: "2026-11-09T16:53:34.000Z",
        completed_at: "2026-11-09T16:55:00.000Z",
        conclusion: "success",
        workflow_run_id: 99,
        workflow_run_url: `${FORGEJO_URL}/cs101/hw1-alex/actions/runs/9`
      }
    })
  );
  const run = actionRunPayload(FORGEJO_URL, { action: "failure", status: "failure" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  assertEquals(
    updates.filter((u) => u.table === "repository_check_runs"),
    []
  );
});

Deno.test("the same run delivered twice changes nothing", async () => {
  // action_run_recover carries the success a second time, and a hook retry can too.
  const { client, updates } = fakeSupabase(
    tables({
      checkRunStatus: {
        created_at: "2026-11-09T16:53:34.000Z",
        completed_at: "2026-11-09T16:55:00.000Z",
        conclusion: "success",
        workflow_run_id: 42,
        workflow_run_url: RUN_URL
      }
    })
  );
  const run = actionRunPayload(FORGEJO_URL, { action: "success", status: "success" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  assertEquals(
    updates.filter((u) => u.table === "repository_check_runs"),
    []
  );
});

Deno.test("a re-run's outcome does replace the earlier run's", async () => {
  const { client, updates } = fakeSupabase(
    tables({
      checkRunStatus: {
        created_at: "2026-11-09T16:53:34.000Z",
        completed_at: "2026-11-09T16:55:00.000Z",
        conclusion: "failure",
        workflow_run_id: 7,
        workflow_run_url: `${FORGEJO_URL}/cs101/hw1-alex/actions/runs/1`
      }
    })
  );
  const run = actionRunPayload(FORGEJO_URL, { action: "success", status: "success" }).run;
  await handleForgejoActionRun(client, run, new Sentry.Scope());
  const checkRun = updates.find((u) => u.table === "repository_check_runs");
  assertEquals((checkRun?.values.status as Record<string, unknown>).conclusion, "success");
  assertEquals((checkRun?.values.status as Record<string, unknown>).workflow_run_id, 42);
});
