/**
 * @jest-environment node
 *
 * ADR 6 governance: the files that decide what a recording keeps as text, and how it is redacted,
 * need an unmask owner's approval to change. CODEOWNERS lists them (its owner is a placeholder
 * until a human names the team), and report-unmask-review.yml requires the environment approval
 * when a PR touches them. This keeps the two lists in step.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "../..");
const GOVERNED = [
  "lib/bugReport/recorder.ts",
  "lib/bugReport/routePolicy.ts",
  "lib/bugReport/redaction/",
  "lib/bugReport/privacy.ts",
  "components/bugReport/ReportBlock.tsx",
  // Removing a static route from this list makes its sibling resolve to a listed [param] page.
  "lib/bugReport/generated/appRoutes.json",
  "scripts/bugReport/generateAppRoutes.ts"
];

function codeOwners(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of readFileSync(path.join(ROOT, ".github/CODEOWNERS"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    out.set(pattern.replace(/^\//, ""), owners);
  }
  return out;
}

function governedRe(): RegExp {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/report-unmask-review.yml"), "utf8");
  const m = /export GOVERNED_RE='([^']+)'/.exec(workflow);
  if (!m) throw new Error("GOVERNED_RE not found in report-unmask-review.yml");
  return new RegExp(m[1]);
}

describe("ADR 6: recording privacy files need an unmask owner", () => {
  it("CODEOWNERS lists each with the unmask owners", () => {
    const owners = codeOwners();
    const unmaskOwners = owners.get("lib/bugReport/privacy.ts");
    expect(unmaskOwners).toBeDefined();
    for (const p of GOVERNED) expect([p, owners.get(p)]).toEqual([p, unmaskOwners]);
  });

  it("report-unmask-review.yml requires approval when a PR touches any of them", () => {
    const re = governedRe();
    const touched = [...GOVERNED.filter((p) => !p.endsWith("/")), "lib/bugReport/redaction/walker.ts"];
    for (const p of touched) expect([p, re.test(p)]).toEqual([p, true]);
    for (const p of [
      "lib/bugReport/recorder.tsx",
      "lib/bugReport/recorderUtils.ts",
      "app/lib/bugReport/recorder.ts",
      "components/bugReport/ReportBugDialog.tsx"
    ]) {
      expect([p, re.test(p)]).toEqual([p, false]);
    }
  });
});
