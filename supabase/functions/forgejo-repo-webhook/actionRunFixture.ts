/**
 * An `action_run_*` webhook body in the shape Forgejo 15.0.9 sends (`api.ActionPayload`), trimmed. Shared
 * by webhook.test.ts and actionRun.test.ts.
 */
import type { ForgejoActionRunPayload } from "./actionRun.ts";

export const RUN_SHA = "d9eb975102fb245857b4b4f7165062854958d9bf";

export function actionRunPayload(
  forgejoUrl: string,
  overrides: { action?: string; status?: string; workflow_id?: string; id?: number } = {}
): ForgejoActionRunPayload {
  const repository = {
    id: 1,
    name: "hw1-alex",
    full_name: "cs101/hw1-alex",
    html_url: `${forgejoUrl}/cs101/hw1-alex`,
    default_branch: "main",
    private: true
  };
  const payload = {
    action: overrides.action ?? "failure",
    run: {
      id: overrides.id ?? 42,
      title: "Finish part 1 #submit",
      repository,
      workflow_id: overrides.workflow_id ?? "grade.yml",
      index_in_repo: 3,
      trigger_user: { id: 2, login: "alex", username: "alex" },
      ScheduleID: 0,
      prettyref: "main",
      is_ref_deleted: false,
      commit_sha: RUN_SHA,
      is_fork_pull_request: false,
      need_approval: false,
      approved_by: 0,
      event: "push",
      event_payload: "{}",
      trigger_event: "push",
      status: overrides.status ?? "failure",
      started: "2026-11-09T16:53:40Z",
      stopped: "2026-11-09T16:55:02Z",
      created: "2026-11-09T16:53:35Z",
      updated: "2026-11-09T16:55:02Z",
      duration: 82000000000,
      html_url: `${forgejoUrl}/cs101/hw1-alex/actions/runs/3`
    },
    prior_status: "running"
  };
  return payload;
}
