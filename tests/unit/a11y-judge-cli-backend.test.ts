/**
 * Unit tests for the `claude -p` judging backend's pure helpers
 * (tools/a11y-judge/judge/cliBackend.ts). The spawn path is exercised live by
 * the micro-fixture gate; here we cover prompt construction and envelope
 * parsing, which are the parts that can silently drift.
 */
import { buildCliPrompt, parseCliEnvelope, CLI_PROMPT_SUFFIX } from "../../tools/a11y-judge/judge/cliBackend";
import { JUDGE_CHARTER } from "../../tools/a11y-judge/judge/client";
import type { EvidenceBundle } from "../../tools/a11y-judge/schema/evidence";

const BUNDLE: EvidenceBundle = {
  schemaVersion: 1,
  page: {
    id: "micro",
    route: "/micro",
    title: "Micro",
    viewport: { width: 1280, height: 720 },
    browser: "chromium"
  },
  criterion: "2.4.7",
  collector: { name: "test", version: "1" },
  collectedAt: "2026-07-14T00:00:00.000Z",
  probes: [{ type: "raw-json", id: "probe-1", label: "test probe", data: { hello: "world" } }],
  attachments: [
    { file: "att-000-crop.png", sha256: "ab".repeat(32), mime: "image/png", role: "focused-crop", probeId: "probe-1" }
  ],
  contentHash: "cd".repeat(32)
};

const VERDICT = {
  criterion: "2.4.7",
  verdict: "fail",
  confidence: "high",
  rationale: "No focus indicator.",
  findings: [
    {
      summary: "Focused control shows no visible indicator",
      severity: "4",
      evidenceRefs: ["probe-1"],
      elementPointer: {},
      suggestedFix: "Restore the outline."
    }
  ],
  evidenceGaps: [],
  requestedProbes: []
};

describe("cliBackend", () => {
  test("buildCliPrompt inlines charter, rubric, probes, and the attachment legend", () => {
    const prompt = buildCliPrompt(BUNDLE, "RUBRIC BODY");
    expect(prompt).toContain(JUDGE_CHARTER.slice(0, 60));
    expect(prompt).toContain("RUBRIC BODY");
    expect(prompt).toContain("att-000-crop.png");
    expect(prompt).toContain('"hello": "world"');
    expect(prompt).toContain("criterion under test: 2.4.7");
  });

  test("parseCliEnvelope prefers structured_output and maps usage", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: "ignored when structured_output parses",
      structured_output: VERDICT,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }
    });
    const { verdict, usage } = parseCliEnvelope(stdout);
    expect(verdict.verdict).toBe("fail");
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40
    });
  });

  test("parseCliEnvelope falls back to the result text when structured_output is absent", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "```json\n" + JSON.stringify(VERDICT) + "\n```"
    });
    expect(parseCliEnvelope(stdout).verdict.confidence).toBe("high");
  });

  test("parseCliEnvelope throws on is_error envelopes and on garbage", () => {
    expect(() => parseCliEnvelope(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toThrow(/boom/);
    expect(() => parseCliEnvelope("not json")).toThrow();
  });

  test("CLI cache namespace suffix is stable", () => {
    expect(CLI_PROMPT_SUFFIX).toBe("+cli");
  });
});
