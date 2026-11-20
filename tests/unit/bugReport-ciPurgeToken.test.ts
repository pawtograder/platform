/**
 * @jest-environment node
 *
 * The SENTRY_PURGE_TOKEN secret can delete feedback and replays from the dev Sentry (HU3), so it
 * must never reach code from a PR head. The nightly tier also runs on labeled PRs, checking out
 * the PR's head; only its schedule and workflow_dispatch runs may run H1-H3 or hold the token.
 *
 * Checks every workflow file: each use of `secrets.SENTRY_PURGE_TOKEN` is gated on the event, and
 * the nightly's `suites` and the H step's `if` evaluate to "no H" for pull_request_target.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const WORKFLOWS = path.join(__dirname, "../../.github/workflows");
const TRUSTED_EVENTS = ["schedule", "workflow_dispatch"];
const EVENTS = [...TRUSTED_EVENTS, "pull_request_target", "pull_request", "push"];

/**
 * Evaluates the small subset of GitHub expression syntax these workflows use: string literals,
 * `github.event_name`, `==`, `&&`, `||`, parentheses, and `secrets.X` / `contains(env.SUITES, ' h ')`
 * as opaque truthy values.
 */
function evaluate(expression: string, event: string, suites = ""): unknown {
  const js = expression
    .replace(/\$\{\{\s*|\s*\}\}/g, "")
    .replace(/contains\(env\.SUITES,\s*'([^']*)'\)/g, (_m, s: string) => JSON.stringify(` ${suites} `.includes(s)))
    .replace(/github\.event_name/g, JSON.stringify(event))
    .replace(/secrets\.([A-Z_]+)/g, (_m, name: string) => JSON.stringify(`<secret ${name}>`))
    .replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))
    .replace(/==/g, "===");
  if (!/^[\s"<>A-Za-z0-9_ ()|&=!-]*$/.test(js)) throw new Error(`unsupported expression: ${expression}`);
  return new Function(`return (${js});`)();
}

function workflowFiles(): [string, string][] {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, readFileSync(path.join(WORKFLOWS, f), "utf8")]);
}

/** Every string value in the parsed workflow that mentions the purge token, with its YAML path. */
function purgeTokenUses(node: unknown, at: string[] = []): { at: string; value: string }[] {
  if (typeof node === "string")
    return node.includes("secrets.SENTRY_PURGE_TOKEN") ? [{ at: at.join("."), value: node }] : [];
  if (Array.isArray(node)) return node.flatMap((v, i) => purgeTokenUses(v, [...at, String(i)]));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => purgeTokenUses(v, [...at, k]));
  }
  return [];
}

describe("SENTRY_PURGE_TOKEN never reaches PR-head code", () => {
  it("every use evaluates to the token only on schedule and workflow_dispatch", () => {
    const uses = workflowFiles().flatMap(([file, text]) =>
      purgeTokenUses(YAML.parse(text)).map((u) => ({ ...u, file }))
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      for (const event of EVENTS) {
        const value = evaluate(use.value, event);
        const expected = TRUSTED_EVENTS.includes(event) ? "<secret SENTRY_PURGE_TOKEN>" : "";
        expect([use.file, use.at, event, value]).toEqual([use.file, use.at, event, expected]);
      }
    }
  });

  it("the nightly asks for the h suite only on schedule and workflow_dispatch", () => {
    const nightly = YAML.parse(readFileSync(path.join(WORKFLOWS, "bug-reporter-nightly.yml"), "utf8"));
    const suites: string = nightly.jobs.sentry.with.suites;
    for (const event of EVENTS) {
      const value = String(evaluate(suites, event)).split(/\s+/);
      expect([event, value.includes("h")]).toEqual([event, TRUSTED_EVENTS.includes(event)]);
      expect([event, value.includes("f8")]).toEqual([event, true]);
    }
  });

  it("the H step itself runs only on schedule and workflow_dispatch, whatever suites say", () => {
    const e2e = YAML.parse(readFileSync(path.join(WORKFLOWS, "_bug-reporter-e2e.yml"), "utf8"));
    const step = (e2e.jobs.e2e.steps as { id?: string; if?: string }[]).find((s) => s.id === "h");
    expect(step?.if).toBeDefined();
    for (const event of EVENTS) {
      expect([event, evaluate(step!.if!, event, "f8 f7 h")]).toEqual([event, TRUSTED_EVENTS.includes(event)]);
    }
  });
});
