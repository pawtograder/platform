/**
 * The What's New suggestion script (scripts/whats-new/): the pre-filter, the entry renderer, and
 * the `claude -p` arguments and output parsing. Nothing here calls Claude. Rules from
 * docs/prd-whats-new-bot.md.
 */
import ts from "typescript";
import { claudeArgs, DECISION_JSON_SCHEMA, parseEnvelope, type Decision } from "@/scripts/whats-new/model";
import { diffForFiles, prefilter } from "@/scripts/whats-new/prefilter";
import { addDays, idKey, renderEntryFile, slugify, type SuggestedEntry } from "@/scripts/whats-new/render";

const ui = ["components/help-queue/help-request-chat.tsx"];

describe("prefilter", () => {
  it("sends a feature PR that changes UI files", () => {
    expect(prefilter({ title: "feat(office-hours): queue health cards", labels: [], files: ui })).toEqual({
      send: true,
      matchedFiles: ui
    });
  });

  it.each(["chore", "test", "docs", "ci", "refactor", "build", "perf"])("skips a %s title", (type) => {
    for (const title of [`${type}: x`, `${type}(scope): x`, `${type.toUpperCase()}!: x`]) {
      expect(prefilter({ title, labels: [], files: ui })).toMatchObject({ send: false });
    }
  });

  it("sends a fix that changes UI files, since it can show users something new (#1166)", () => {
    const files = ["app/course/[course_id]/office-hours/[queue_id]/new/newRequestForm.tsx"];
    const title = "fix(office-hours): load the roster for a new request and show resolved requests";
    expect(prefilter({ title, labels: [], files }).send).toBe(true);
  });

  it("still skips a fix that changes no UI files (#1275)", () => {
    const files = ["supabase/migrations/1_x.sql"];
    expect(prefilter({ title: "fix(office-hours): send roster changes", labels: [], files })).toMatchObject({
      send: false
    });
  });

  it("doesn't skip a title that only starts with a skipped word", () => {
    expect(prefilter({ title: "chores page for staff", labels: [], files: ui }).send).toBe(true);
    expect(prefilter({ title: "Show the queues when realtime can't connect", labels: [], files: ui }).send).toBe(true);
  });

  it("skips a PR with no UI files, and doesn't count test files", () => {
    const files = ["supabase/migrations/1_x.sql", "tests/unit/foo.test.tsx", "components/x.test.tsx", "app/y.spec.ts"];
    expect(prefilter({ title: "feat: x", labels: [], files })).toMatchObject({ send: false, matchedFiles: [] });
  });

  it("sends a PR that only adds a course feature flag (#1351)", () => {
    expect(prefilter({ title: "feat: a toggle", labels: [], files: ["lib/courseFeatures.ts"] })).toEqual({
      send: true,
      matchedFiles: ["lib/courseFeatures.ts"]
    });
  });

  it("counts app/ and hooks/ but not other lib/ files", () => {
    const files = ["app/course/page.tsx", "hooks/useX.ts", "lib/other.ts"];
    expect(prefilter({ title: "feat: x", labels: [], files }).matchedFiles).toEqual(files.slice(0, 2));
  });

  it("skips a PR labeled no-whats-new", () => {
    expect(prefilter({ title: "feat: x", labels: ["no-whats-new"], files: ui })).toMatchObject({ send: false });
  });

  it("skips a PR that already adds a walkthrough", () => {
    const files = [...ui, "lib/whatsNew/entries/queue-health.tsx"];
    expect(prefilter({ title: "feat: x", labels: [], files })).toMatchObject({ send: false });
  });
});

describe("diffForFiles", () => {
  const diff = [
    "diff --git a/app/a.tsx b/app/a.tsx\n--- a/app/a.tsx\n+++ b/app/a.tsx\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git a/tests/a.test.ts b/tests/a.test.ts\n@@ -1 +1 @@\n-c\n+d\n",
    "diff --git a/hooks/b.ts b/hooks/b.ts\n@@ -1 +1 @@\n-e\n+f\n"
  ].join("");

  it("keeps only the sections for the given files", () => {
    const kept = diffForFiles(diff, ["app/a.tsx", "hooks/b.ts"]);
    expect(kept).toContain("+b");
    expect(kept).toContain("+f");
    expect(kept).not.toContain("tests/a.test.ts");
  });
});

describe("renderEntryFile", () => {
  const entry: SuggestedEntry = {
    audience: "staff",
    page: "office-hours",
    feature: "office-hours-queue-health",
    title: 'New in Office Hours: "queue health" {cards}',
    intro: "Queues now show </Text> and `backticks` and ${template} text. Want a quick tour?",
    steps: [
      { title: "Cards", points: ["It's red when {waiting} > 5", "Second"], previewOf: "QueueHealthStats" },
      { title: "Alerts", points: ["One"], previewOf: null }
    ]
  };
  const file = renderEntryFile(entry, {
    slug: "queue-health",
    prNumber: 1287,
    mergedAt: new Date("2026-11-18T15:10:11Z")
  });

  it("parses as TSX whatever the model's text contains", () => {
    const { diagnostics } = ts.transpileModule(file, {
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020 }
    });
    expect(diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  it("keeps the model's text as string literals", () => {
    expect(file).toContain(JSON.stringify(entry.intro));
    expect(file).toContain(JSON.stringify("It's red when {waiting} > 5"));
  });

  it("fills in the id, feature, show-until date and preview TODOs", () => {
    expect(file).toContain("id: WHATS_NEW_IDS.QUEUE_HEALTH,");
    expect(file).toContain('feature: "office-hours-queue-health",');
    expect(file).toContain('showUntil: "2027-01-17",');
    expect(file).toContain("TODO: a static preview of QueueHealthStats.");
    expect(file).toContain("#1287");
  });

  it("keeps a digit-leading slug a valid identifier, and the rendered file still parses", () => {
    expect(idKey("10-minute-check-in")).toBe("_10_MINUTE_CHECK_IN");
    const file = renderEntryFile(
      { ...entry, title: "New in Office Hours: 10-minute check-in" },
      { slug: "10-minute-check-in", prNumber: 1, mergedAt: new Date("2026-11-23T00:00:00Z") }
    );
    expect(file).toContain("id: WHATS_NEW_IDS._10_MINUTE_CHECK_IN,");
    const { diagnostics } = ts.transpileModule(file, {
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020 }
    });
    expect(diagnostics).toEqual([]);
  });

  it("leaves out feature when there is none", () => {
    const plain = renderEntryFile({ ...entry, feature: null }, { slug: "x", prNumber: 1, mergedAt: new Date() });
    expect(plain).not.toContain("feature:");
  });
});

describe("render helpers", () => {
  it("slugify makes a short kebab-case slug", () => {
    expect(slugify("Ticket escalation & End ticket!")).toBe("ticket-escalation-end-ticket");
    expect(slugify("***")).toBe("walkthrough");
    expect(slugify("a".repeat(60)).length).toBeLessThanOrEqual(48);
  });

  it("addDays counts in UTC", () => {
    expect(addDays(new Date("2026-11-22T23:30:00Z"), 60)).toBe("2027-01-21");
  });

  it("idKey turns a slug into a WHATS_NEW_IDS key", () => {
    expect(idKey("queue-health")).toBe("QUEUE_HEALTH");
  });
});

describe("claude CLI call", () => {
  const decision: Decision = {
    significant: true,
    reason: "Staff get a new button.",
    audience: "staff",
    page: "office-hours",
    feature: null,
    title: "New in Office Hours: x",
    intro: "Want a quick tour?",
    steps: [{ title: "Step", points: ["One"], previewOf: null }]
  };

  it("runs with no tools, no MCP servers and no saved session", () => {
    const args = claudeArgs("SYSTEM");
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYSTEM");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("sends a JSON schema the CLI accepts, without the $schema key", () => {
    const schema = JSON.parse(DECISION_JSON_SCHEMA);
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(expect.arrayContaining(["significant", "reason", "steps"]));
  });

  it("reads the decision from structured_output", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "", structured_output: decision });
    expect(parseEnvelope(stdout)).toEqual(decision);
  });

  it("throws on an error result or a missing decision", () => {
    expect(() => parseEnvelope(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }))).toThrow(
      /Not logged in/
    );
    expect(() => parseEnvelope(JSON.stringify({ type: "result", result: "no JSON here" }))).toThrow(
      /no usable decision/
    );
  });
});
