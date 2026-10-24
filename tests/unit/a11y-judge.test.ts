/**
 * Unit tests for the a11y-judge LLM judge. No network: the Anthropic client is a
 * hand-mocked stand-in (`messages.parse` is a jest.fn), so the judge path runs
 * end-to-end against the committed micro fixture without an API key.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { EvidenceBundleSchema, type EvidenceBundle } from "@/tools/a11y-judge/schema/evidence";
import type { Verdict } from "@/tools/a11y-judge/schema/verdict";
import { judgeBundle, mergeChunkVerdicts, postValidateVerdict, worseVerdict } from "@/tools/a11y-judge/judge/client";
import { computeCacheKey, getCached, putCached } from "@/tools/a11y-judge/judge/cache";
import { majorityVerdict } from "@/tools/a11y-judge/judge/run";

const MICRO_DIR = path.resolve("tools/a11y-judge/judge/__fixtures__/micro/micro/2.4.7");

function loadMicroBundle(): EvidenceBundle {
  return EvidenceBundleSchema.parse(JSON.parse(fs.readFileSync(path.join(MICRO_DIR, "manifest.json"), "utf-8")));
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    criterion: "2.4.7",
    verdict: "fail",
    confidence: "high",
    rationale: "outline:none with no compensating indicator (F78).",
    findings: [],
    evidenceGaps: [],
    requestedProbes: [],
    ...overrides
  };
}

describe("postValidateVerdict", () => {
  it("keeps well-cited findings and rejects hallucinated evidenceRefs", () => {
    const bundle = loadMicroBundle();
    const verdict = makeVerdict({
      findings: [
        {
          summary: "Submit button has no visible focus indicator.",
          severity: "4",
          evidenceRefs: ["focus-2.4.7-micro", "att-000-micro-focused.png"],
          elementPointer: { testId: "submit-btn" },
          suggestedFix: "Add a 2px focus outline."
        },
        {
          summary: "A fabricated finding.",
          severity: "3",
          evidenceRefs: ["ghost-probe-999"],
          elementPointer: { selector: ".does-not-exist" },
          suggestedFix: "n/a"
        }
      ]
    });

    const { verdict: cleaned, rejectedFindings } = postValidateVerdict(verdict, bundle);
    expect(cleaned.findings).toHaveLength(1);
    expect(cleaned.findings[0].evidenceRefs).toContain("focus-2.4.7-micro");
    expect(rejectedFindings).toHaveLength(1);
    expect(rejectedFindings[0].reason).toMatch(/evidenceRefs not in manifest/);
    expect(rejectedFindings[0].reason).toMatch(/selector/);
  });

  it("rejects a finding whose testId is absent from the probe JSON", () => {
    const bundle = loadMicroBundle();
    const verdict = makeVerdict({
      findings: [
        {
          summary: "Points at a control that isn't in the probes.",
          severity: "2",
          evidenceRefs: ["focus-2.4.7-micro"],
          elementPointer: { testId: "not-a-real-test-id" },
          suggestedFix: "n/a"
        }
      ]
    });
    const { verdict: cleaned, rejectedFindings } = postValidateVerdict(verdict, bundle);
    expect(cleaned.findings).toHaveLength(0);
    expect(rejectedFindings[0].reason).toMatch(/testId "not-a-real-test-id" not found/);
  });
});

describe("verdict cache round-trip", () => {
  it("stores and reloads a value; misses on a different sample index", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-cache-"));
    const parts = {
      evidenceContentHash: "abc",
      rubricFileSha256: "def",
      promptVersion: "r1.0",
      model: "claude-opus-4-8",
      sampleIndex: 0
    };
    const key = computeCacheKey(parts);
    // deterministic
    expect(computeCacheKey(parts)).toBe(key);
    // a different sample index yields a different key
    expect(computeCacheKey({ ...parts, sampleIndex: 1 })).not.toBe(key);

    expect(getCached(key, cacheDir)).toBeNull();
    const value = { verdict: makeVerdict(), rejectedFindings: [], usage: { inputTokens: 1 } };
    putCached(key, value, cacheDir);
    expect(getCached(key, cacheDir)).toEqual(value);
    // unrelated key still misses
    expect(getCached(computeCacheKey({ ...parts, sampleIndex: 1 }), cacheDir)).toBeNull();

    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe("verdict merges", () => {
  it("worseVerdict orders fail > needs_human > pass", () => {
    expect(worseVerdict("pass", "needs_human")).toBe("needs_human");
    expect(worseVerdict("needs_human", "fail")).toBe("fail");
    expect(worseVerdict("pass", "pass")).toBe("pass");
  });

  it("mergeChunkVerdicts takes the worst verdict and unions findings", () => {
    const a = makeVerdict({ verdict: "pass", findings: [] });
    const b = makeVerdict({
      verdict: "fail",
      findings: [
        {
          summary: "x",
          severity: "4",
          evidenceRefs: ["focus-2.4.7-micro"],
          elementPointer: {},
          suggestedFix: "y"
        }
      ]
    });
    const merged = mergeChunkVerdicts([a, b], "2.4.7");
    expect(merged.verdict).toBe("fail");
    expect(merged.findings).toHaveLength(1);
  });

  it("majorityVerdict resolves a tie to the worse verdict", () => {
    expect(majorityVerdict(["pass", "pass", "fail"])).toBe("pass");
    expect(majorityVerdict(["pass", "fail"])).toBe("fail"); // 1-1 tie -> worse
    expect(majorityVerdict(["fail", "needs_human", "needs_human"])).toBe("needs_human");
    expect(majorityVerdict(["fail", "needs_human", "pass"])).toBe("fail"); // 3-way tie -> worst
  });
});

describe("judgeBundle (mocked client)", () => {
  it("returns fail for the micro fixture and strips a hallucinated citation", async () => {
    const bundle = loadMicroBundle();
    const modelVerdict = makeVerdict({
      findings: [
        {
          summary: "No visible focus indicator on Submit.",
          severity: "4",
          evidenceRefs: ["focus-2.4.7-micro"],
          elementPointer: { testId: "submit-btn" },
          suggestedFix: "Add a focus ring."
        },
        {
          summary: "Fabricated.",
          severity: "2",
          evidenceRefs: ["made-up-ref"],
          elementPointer: {},
          suggestedFix: "n/a"
        }
      ]
    });

    const parse = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(modelVerdict) }],
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      parsed_output: modelVerdict
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    const result = await judgeBundle({ client, bundle, evidenceDir: MICRO_DIR, rubricText: "RUBRIC 2.4.7" });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.verdict.verdict).toBe("fail");
    expect(result.verdict.findings).toHaveLength(1);
    expect(result.rejectedFindings).toHaveLength(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
    // the single call embedded the fixture's one screenshot as a base64 image block
    const sentContent = parse.mock.calls[0][0].messages[0].content;
    expect(sentContent.some((b: { type: string }) => b.type === "image")).toBe(true);
  });

  it("falls back to parsing response text when parsed_output is null", async () => {
    const bundle = loadMicroBundle();
    const modelVerdict = makeVerdict({ verdict: "needs_human", confidence: "low" });
    const parse = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(modelVerdict) }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      parsed_output: null
    });
    const client = { messages: { parse } } as unknown as Anthropic;
    const result = await judgeBundle({ client, bundle, evidenceDir: MICRO_DIR, rubricText: "RUBRIC" });
    expect(result.verdict.verdict).toBe("needs_human");
  });
});
