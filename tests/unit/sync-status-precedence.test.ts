import {
  computeSyncStatus,
  type RepositoryRow
} from "@/app/course/[course_id]/manage/assignments/[assignment_id]/repositories/sync-status-utils";

/**
 * The ORDER of the checks in computeSyncStatus, which is load-bearing and was wrong twice.
 *
 * A handout sync that cannot deliver a revision leaves the pull request an EARLIER revision
 * opened in `sync_data`, because that PR is still open on GitHub and is still the thing the
 * student has to merge. Carrying it is right; reading it first is not. Both times, the row
 * reported an outcome the instructor could not act on -- "Sync in Progress" for a sync that
 * had already stopped, then "PR Open" for a repository whose newer revision had failed -- and
 * in both cases the state that needed a person was in the object, just never reached.
 *
 * These are the orderings, stated as behavior rather than as line numbers.
 */
const row = (syncData: Record<string, unknown> | null, synced = "H1", desired = "H3"): RepositoryRow =>
  ({
    synced_handout_sha: synced,
    desired_handout_sha: desired,
    sync_data: syncData
  }) as unknown as RepositoryRow;

describe("computeSyncStatus precedence", () => {
  it("reports a blocked revision even while an older pull request is still open", () => {
    expect(
      computeSyncStatus(
        row({
          status: "blocked_by_student_changes",
          blocked_handout_sha: "H3",
          unresolved_paths: ["src/a.ts"],
          pr_number: 7,
          pr_url: "https://github.com/o/r/pull/7",
          pr_state: "open"
        })
      )
    ).toBe("Sync Blocked");
  });

  it("reports a terminal error even while an older pull request is still open", () => {
    expect(
      computeSyncStatus(
        row({
          status: "error",
          terminal_reason: "sync_branch_not_ours",
          last_sync_error: "a student pushed to the sync branch",
          blocked_handout_sha: "H3",
          pr_number: 7,
          pr_url: "https://github.com/o/r/pull/7",
          pr_state: "open"
        })
      )
    ).toBe("Sync Error");
  });

  it("still reports PR Open when nothing is blocked or failed", () => {
    expect(computeSyncStatus(row({ pr_state: "open", pr_number: 7 }))).toBe("PR Open");
  });

  it("still reports a merged PR as finalizing", () => {
    expect(computeSyncStatus(row({ pr_state: "merged", pr_number: 7 }))).toBe("Sync Finalizing");
  });

  // A repository whose shas agree is settled, whatever the last attempt recorded: the checks
  // above must not resurrect a blocker the next successful sync already cleared.
  it("reports a repository at the latest revision as synced, blocker or not", () => {
    expect(
      computeSyncStatus(row({ status: "blocked_by_student_changes", unresolved_paths: ["a.ts"] }, "H3", "H3"), "H3")
    ).toBe("Synced");
  });

  it("reports a repository behind the latest handout as out of date", () => {
    expect(computeSyncStatus(row({ status: "no_changes_needed" }, "H3", "H3"), "H4")).toBe("Not Up-to-date");
  });

  it("reports a repository that was never asked to sync", () => {
    expect(computeSyncStatus(row(null, null as unknown as string, null as unknown as string))).toBe(
      "No Sync Requested"
    );
  });

  // An attempt that died between the in_progress marker and any outcome. The spinner is the
  // honest answer here: something was queued and has not reported back.
  it("reports an in-flight attempt as in progress", () => {
    expect(computeSyncStatus(row({ status: "in_progress", started_at: "2026-09-15T00:00:00Z" }))).toBe(
      "Sync in Progress"
    );
  });
});
