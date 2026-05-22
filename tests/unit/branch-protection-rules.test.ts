/**
 * @jest-environment node
 */

import {
  BRANCH_PROTECTION_RULESET_NAME,
  DEFAULT_BRANCH_PROTECTION,
  buildBranchProtectionRules,
  diffBranchProtectionRules,
  planBranchProtectionAction
} from "../../supabase/functions/_shared/branchProtection";

describe("buildBranchProtectionRules", () => {
  it("returns an empty list when no flags are set", () => {
    expect(
      buildBranchProtectionRules({
        blockForcePush: false,
        requirePullRequest: false,
        requiredReviewers: 0
      })
    ).toEqual([]);
  });

  it("emits only non_fast_forward for the default config", () => {
    expect(buildBranchProtectionRules(DEFAULT_BRANCH_PROTECTION)).toEqual([{ type: "non_fast_forward" }]);
  });

  it("emits pull_request with the configured review count", () => {
    const rules = buildBranchProtectionRules({
      blockForcePush: true,
      requirePullRequest: true,
      requiredReviewers: 2
    });
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ type: "non_fast_forward" });
    expect(rules[1]).toMatchObject({
      type: "pull_request",
      parameters: expect.objectContaining({ required_approving_review_count: 2 })
    });
  });

  it("clamps a negative reviewer count to zero", () => {
    const rules = buildBranchProtectionRules({
      blockForcePush: false,
      requirePullRequest: true,
      requiredReviewers: -3
    });
    expect(rules).toEqual([
      {
        type: "pull_request",
        parameters: expect.objectContaining({ required_approving_review_count: 0 })
      }
    ]);
  });

  it("ignores requiredReviewers when requirePullRequest is false", () => {
    expect(
      buildBranchProtectionRules({
        blockForcePush: true,
        requirePullRequest: false,
        requiredReviewers: 5
      })
    ).toEqual([{ type: "non_fast_forward" }]);
  });
});

describe("diffBranchProtectionRules", () => {
  it("reports equal when both sides match", () => {
    const result = diffBranchProtectionRules([{ type: "non_fast_forward" }], [{ type: "non_fast_forward" }]);
    expect(result).toEqual({ equal: true, toAdd: [], toRemove: [] });
  });

  it("is insensitive to rule ordering", () => {
    const pr = {
      type: "pull_request" as const,
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false
      }
    };
    const result = diffBranchProtectionRules([{ type: "non_fast_forward" }, pr], [pr, { type: "non_fast_forward" }]);
    expect(result.equal).toBe(true);
  });

  it("emits the missing additions and stale removals", () => {
    const result = diffBranchProtectionRules(
      [{ type: "non_fast_forward" }],
      [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false
          }
        }
      ]
    );
    expect(result.equal).toBe(false);
    expect(result.toAdd).toHaveLength(1);
    expect(result.toAdd[0].type).toBe("pull_request");
    expect(result.toRemove).toEqual([{ type: "non_fast_forward" }]);
  });
});

describe("planBranchProtectionAction", () => {
  it("plans noop when nothing exists and nothing desired", () => {
    expect(
      planBranchProtectionAction({ blockForcePush: false, requirePullRequest: false, requiredReviewers: 0 }, null)
    ).toEqual({ kind: "noop" });
  });

  it("plans delete when ruleset exists but nothing desired", () => {
    expect(
      planBranchProtectionAction({ blockForcePush: false, requirePullRequest: false, requiredReviewers: 0 }, [
        { type: "non_fast_forward" }
      ])
    ).toEqual({ kind: "delete" });
  });

  it("plans create when ruleset absent but rules desired", () => {
    const action = planBranchProtectionAction(DEFAULT_BRANCH_PROTECTION, null);
    expect(action.kind).toBe("create");
    if (action.kind === "create") {
      expect(action.rules).toEqual([{ type: "non_fast_forward" }]);
    }
  });

  it("plans noop when existing rules already match desired", () => {
    expect(planBranchProtectionAction(DEFAULT_BRANCH_PROTECTION, [{ type: "non_fast_forward" }])).toEqual({
      kind: "noop"
    });
  });

  it("plans update when existing rules differ from desired", () => {
    const action = planBranchProtectionAction(
      { blockForcePush: true, requirePullRequest: true, requiredReviewers: 1 },
      [{ type: "non_fast_forward" }]
    );
    expect(action.kind).toBe("update");
    if (action.kind === "update") {
      expect(action.rules.map((r) => r.type).sort()).toEqual(["non_fast_forward", "pull_request"]);
    }
  });
});

describe("BRANCH_PROTECTION_RULESET_NAME", () => {
  it("matches the name historically used by createBranchProtectionRuleset", () => {
    // Locking this so future renames are deliberate — existing repos in the
    // wild have rulesets with exactly this name and we look them up by name.
    expect(BRANCH_PROTECTION_RULESET_NAME).toBe("Protect main branch");
  });
});
