/**
 * @jest-environment node
 *
 * Drift guard for the chart migration runner's Phase 3.5 grant re-assertion
 * (charts/.../migrate.sh). That loop re-grants anon/authenticated DML on every
 * RLS-enabled public table — which would silently WIDEN the service-internal LTI
 * tables (notably lti_nonces, the OIDC replay-protection table) beyond their
 * migrations' intended ceiling. The fix excludes those four tables. This test
 * fails if that exclusion is ever dropped. (The effective RLS protection is
 * verified separately in tests/e2e/lti-grants-db.spec.ts.)
 */
import { readFileSync } from "fs";
import { join } from "path";

const script = readFileSync(join(process.cwd(), "charts/pawtograder/images/migrations/migrate.sh"), "utf8");

describe("migrate.sh Phase 3.5 — service-internal LTI tables excluded from blanket anon/authenticated DML", () => {
  test("the relrowsecurity grant loop excludes lti_nonces / lti_users / grade-sync tables", () => {
    const match = script.match(/relname <> ALL \(ARRAY\[([\s\S]*?)\]\)/);
    expect(match).not.toBeNull();
    const exclusion = match![1];
    for (const table of ["lti_nonces", "lti_users", "lti_grade_sync_state", "lti_grade_sync_queue"]) {
      expect(exclusion).toContain(`'${table}'`);
    }
  });
});
