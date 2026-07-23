/**
 * Wave-2 unit tests: agent runner pure helpers (prompt/arg builders,
 * stream-json folding) — live claude/browser spawns stay in the env-gated
 * Playwright gate, mirroring the CLI-backend test split.
 */
import {
  AGENT_CHARTER,
  AGENT_MODEL,
  buildAgentPrompt,
  buildClaudeArgs,
  parseStreamJson,
  salvageStructuredOutput
} from "../../tools/a11y-judge/agent/agentRunner";
import { SURVEY_COMPLETE_TASK } from "../../tools/a11y-judge/agent/tasks";

describe("buildAgentPrompt", () => {
  it("inlines the charter and the task statement", () => {
    const prompt = buildAgentPrompt(SURVEY_COMPLETE_TASK);
    expect(prompt).toContain(AGENT_CHARTER);
    expect(prompt).toContain("Complete the survey");
    expect(prompt).toContain("# Your task");
  });
});

describe("buildClaudeArgs", () => {
  const args = buildClaudeArgs("/tmp/cfg.json");

  it("locks the transport to the bridge MCP tools only", () => {
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__at__*");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/cfg.json");
  });

  it("uses stream-json (with --verbose) and the shared judge model", () => {
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--model") + 1]).toBe(AGENT_MODEL);
  });

  it("passes a $schema-free json schema", () => {
    const schema = args[args.indexOf("--json-schema") + 1];
    const parsed = JSON.parse(schema);
    expect(parsed.$schema).toBeUndefined();
    expect(parsed.properties.outcome.enum).toEqual(["completed", "completed_with_barriers", "blocked"]);
    expect(parsed.required).toContain("taskAnswer");
  });

  it("ships barriers as a flat JSON-string field (long-session encoding workaround)", () => {
    const parsed = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    expect(parsed.properties.barriersJson.type).toBe("string");
    expect(parsed.properties.barriers).toBeUndefined();
    expect(parsed.required).toContain("barriersJson");
  });
});

describe("parseStreamJson", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Orienting via headings." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__at__next" }] } }),
    "not json at all",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Submitting now." }] } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 12,
      total_cost_usd: 1.23,
      structured_output: { taskId: "survey-complete" }
    })
  ].join("\n");

  it("collects assistant text blocks and the final envelope, skipping garbage", () => {
    const parsed = parseStreamJson(lines);
    expect(parsed.assistantTexts).toEqual(["Orienting via headings.", "Submitting now."]);
    expect(parsed.resultEnvelope?.num_turns).toBe(12);
    expect(parsed.resultEnvelope?.total_cost_usd).toBe(1.23);
    expect((parsed.resultEnvelope?.structured_output as { taskId: string }).taskId).toBe("survey-complete");
  });

  it("returns null envelope when the stream never completed", () => {
    const parsed = parseStreamJson(lines.split("\n").slice(0, 3).join("\n"));
    expect(parsed.resultEnvelope).toBeNull();
    expect(parsed.assistantTexts).toEqual(["Orienting via headings."]);
  });

  it("captures StructuredOutput attempts for salvage", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { taskId: "x" } }] }
      })
    ].join("\n");
    expect(parseStreamJson(stream).structuredAttempts).toEqual([{ taskId: "x" }]);
  });
});

describe("salvageStructuredOutput", () => {
  const base = {
    taskId: "survey-complete",
    outcome: "completed",
    taskAnswer: "n/a",
    confidence: "high",
    evidenceGaps: ["x"],
    narrative: "short"
  };

  it("reconstructs a verdict whose barriersJson was dropped by the CLI", () => {
    const salvagedVerdict = salvageStructuredOutput([base]);
    expect(salvagedVerdict).toMatchObject({ ...base, barriersJson: "[]" });
  });

  it("prefers the LAST parseable attempt", () => {
    const first = { ...base, narrative: "first attempt" };
    const last = { ...base, narrative: "last attempt", barriersJson: '[{"summary":"s","severity":"2","evidenceRefs":["0"],"elementPointer":{},"suggestedFix":"f","wcagCriterion":"4.1.2"}]' };
    expect(salvageStructuredOutput([first, last])?.narrative).toBe("last attempt");
    expect(salvageStructuredOutput([first, last])?.barriersJson).toContain("4.1.2");
  });

  it("returns null when no attempt is reconstructible", () => {
    expect(salvageStructuredOutput([{ taskId: "only-this" }, "garbage", null])).toBeNull();
  });
});
