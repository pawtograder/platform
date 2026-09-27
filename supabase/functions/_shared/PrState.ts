/**
 * Shared PR-state normalization.
 *
 * GitHub exposes a pull request's lifecycle across a few fields; we collapse them
 * into the small vocabulary stored on submissions / submission_pr_links:
 *   open | draft | closed | merged
 *
 * A PR reopened from "closed" arrives with state "open" again, so "reopened" maps
 * to "open" here.
 *
 * The two callers pass different shapes that nonetheless share these fields:
 *   - the webhook's `PullRequestEvent["pull_request"]`, where merge is signalled by
 *     `merged_at` (and sometimes a `merged` boolean), and
 *   - `getPullRequest`'s REST result, which carries an explicit `merged` boolean.
 * Accepting the common fields structurally keeps one implementation for both.
 */
export type PrStateInput = {
  merged_at?: string | null;
  merged?: boolean | null;
  state?: string | null;
  draft?: boolean | null;
};

export function prStateFromPullRequest(pr: PrStateInput): string {
  if (pr.merged_at || pr.merged) {
    return "merged";
  }
  if (pr.state === "closed") {
    return "closed";
  }
  if (pr.draft) {
    return "draft";
  }
  return "open";
}
