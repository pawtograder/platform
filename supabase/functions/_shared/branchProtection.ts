// Pure helpers for translating Pawtograder's per-assignment branch-protection
// settings into the shape GitHub's repository-rulesets API expects. Extracted
// so the dispatch logic can be exercised in Jest without touching Octokit.

export type BranchProtectionConfig = {
  blockForcePush: boolean;
  requirePullRequest: boolean;
  /** 0 means "PR required but no minimum review count enforced". */
  requiredReviewers: number;
};

export const DEFAULT_BRANCH_PROTECTION: BranchProtectionConfig = {
  blockForcePush: true,
  requirePullRequest: false,
  requiredReviewers: 0
};

export const BRANCH_PROTECTION_RULESET_NAME = "Protect main branch";

export type RulesetRule =
  | { type: "non_fast_forward" }
  | {
      type: "pull_request";
      parameters: {
        required_approving_review_count: number;
        dismiss_stale_reviews_on_push: boolean;
        require_code_owner_review: boolean;
        require_last_push_approval: boolean;
        required_review_thread_resolution: boolean;
      };
    };

/**
 * Build the GitHub ruleset `rules` array for an assignment's protection config.
 *
 * Empty array means "no protection desired" — callers should DELETE any
 * existing ruleset with this name rather than POST an empty one (the API
 * rejects rulesets with zero rules).
 */
export function buildBranchProtectionRules(cfg: BranchProtectionConfig): RulesetRule[] {
  const rules: RulesetRule[] = [];
  if (cfg.blockForcePush) {
    rules.push({ type: "non_fast_forward" });
  }
  if (cfg.requirePullRequest) {
    rules.push({
      type: "pull_request",
      parameters: {
        required_approving_review_count: Math.max(0, Math.floor(cfg.requiredReviewers)),
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false
      }
    });
  }
  return rules;
}

/**
 * True when a config requests no protection at all (every flag off), i.e.
 * `buildBranchProtectionRules` would be empty. Callers should skip ALL of
 * GitHub's repository-rulesets endpoints in this case: there is no rule to
 * enforce, and hitting those endpoints requires the repository-administration
 * permission — which some installations (e.g. staging) do not grant — so an
 * unconditional rulesets round-trip would needlessly fail repo/handout creation.
 */
export function requestsNoBranchProtection(cfg: BranchProtectionConfig): boolean {
  return buildBranchProtectionRules(cfg).length === 0;
}

/**
 * Normalised form used for ordering-insensitive equality. Sorting by `type`
 * gives a stable canonical form; parameter objects are stringified after sort.
 */
function canonical(rules: RulesetRule[]): string {
  return JSON.stringify(
    [...rules]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((rule) => {
        if (rule.type === "pull_request") {
          return { type: rule.type, parameters: rule.parameters };
        }
        return { type: rule.type };
      })
  );
}

export type RulesetDiff = {
  equal: boolean;
  toAdd: RulesetRule[];
  toRemove: RulesetRule[];
};

export function diffBranchProtectionRules(existing: RulesetRule[], desired: RulesetRule[]): RulesetDiff {
  if (canonical(existing) === canonical(desired)) {
    return { equal: true, toAdd: [], toRemove: [] };
  }
  const existingTypes = new Set(existing.map((r) => r.type));
  const desiredTypes = new Set(desired.map((r) => r.type));
  const toAdd = desired.filter((r) => !existingTypes.has(r.type));
  const toRemove = existing.filter((r) => !desiredTypes.has(r.type));
  return { equal: false, toAdd, toRemove };
}

export type BranchProtectionAction =
  | { kind: "noop" }
  | { kind: "create"; rules: RulesetRule[] }
  | { kind: "update"; rules: RulesetRule[] }
  | { kind: "delete" };

/**
 * Decide what API call to make against an existing GitHub ruleset (or absent
 * one) to bring it in line with the desired config.
 *
 * The return value is consumed by `applyBranchProtectionRuleset` in
 * GitHubWrapper which performs the actual HTTP calls. Keeping this as a pure
 * function lets the test suite enumerate every transition without mocking
 * Octokit.
 */
export function planBranchProtectionAction(
  desired: BranchProtectionConfig,
  existingRules: RulesetRule[] | null
): BranchProtectionAction {
  const desiredRules = buildBranchProtectionRules(desired);
  if (desiredRules.length === 0 && existingRules === null) {
    return { kind: "noop" };
  }
  if (desiredRules.length === 0 && existingRules !== null) {
    return { kind: "delete" };
  }
  if (existingRules === null) {
    return { kind: "create", rules: desiredRules };
  }
  const diff = diffBranchProtectionRules(existingRules, desiredRules);
  if (diff.equal) {
    return { kind: "noop" };
  }
  return { kind: "update", rules: desiredRules };
}
