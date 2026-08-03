/**
 * Unit tests for the a11y-judge report renderer (tools/a11y-judge/report/render.ts)
 * and the mutation env dispatcher (tools/a11y-judge/mutations/index.ts).
 *
 * LOCATION NOTE: the Wave-2E prompt scopes these to tools/a11y-judge, but this
 * repo's jest config only discovers tests under tests/unit, so the test lives
 * here and imports from tools/ (matches the sibling a11y-judge-evidence test).
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "@playwright/test";
import { renderReport } from "../../tools/a11y-judge/report/render";
import { applyMutationFromEnv, getMutation, MUTATIONS } from "../../tools/a11y-judge/mutations/index";

// A real 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("renderReport", () => {
  let tmpDir: string;
  let verdictsDir: string;
  let evidenceDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-report-"));
    verdictsDir = path.join(tmpDir, "verdicts");
    evidenceDir = path.join(tmpDir, "evidence");
    const majorityDir = path.join(verdictsDir, "majority");
    const samplesDir = path.join(verdictsDir, "samples");
    const bundleDir = path.join(evidenceDir, "survey-taking__2.4.7");
    fs.mkdirSync(majorityDir, { recursive: true });
    fs.mkdirSync(samplesDir, { recursive: true });
    fs.mkdirSync(bundleDir, { recursive: true });

    // Fake evidence bundle: manifest.json + one 1x1 PNG attachment.
    const pngPath = path.join(bundleDir, "att-000-focused.png");
    fs.writeFileSync(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
    const manifestPath = path.join(bundleDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        criterion: "2.4.7",
        attachments: [
          {
            file: "att-000-focused.png",
            sha256: "deadbeef",
            mime: "image/png",
            role: "focused-crop",
            probeId: "focus-indicator-1"
          }
        ]
      })
    );

    // run.json with cost totals.
    fs.writeFileSync(
      path.join(verdictsDir, "run.json"),
      JSON.stringify({
        runId: "run-123",
        model: "claude-opus-4-8",
        promptVersion: "v1",
        evidenceDir,
        startedAt: "2026-07-13T00:00:00.000Z",
        finishedAt: "2026-07-13T00:05:00.000Z",
        totals: {
          calls: 6,
          cacheHits: 2,
          inputTokens: 12345,
          outputTokens: 678,
          estimatedCostUsd: 1.2345
        },
        errors: []
      })
    );

    // majority verdict (non-unanimous fail). NOTE: the judge writes `verdict`
    // as the FULL merged Verdict object (this exact shape shipped the
    // "[object Object]" matrix bug when the fixture used a bare string).
    fs.writeFileSync(
      path.join(majorityDir, "survey-taking__2.4.7.json"),
      JSON.stringify({
        pageId: "survey-taking",
        criterion: "2.4.7",
        samples: 2,
        unanimous: false,
        verdict: {
          criterion: "2.4.7",
          verdict: "fail",
          confidence: "high",
          rationale: "Merged rationale.",
          findings: [],
          evidenceGaps: [],
          requestedProbes: []
        },
        perSampleVerdicts: ["fail", "needs_human"]
      })
    );

    // Two sample files; sample 0 carries an XSS-y rationale + a cited screenshot.
    fs.writeFileSync(
      path.join(samplesDir, "survey-taking__2.4.7__s0.json"),
      JSON.stringify({
        pageId: "survey-taking",
        criterion: "2.4.7",
        sampleIndex: 0,
        cached: false,
        evidenceManifestPath: manifestPath,
        rejectedFindings: [{ ref: "made-up.png" }],
        verdict: {
          criterion: "2.4.7",
          verdict: "fail",
          confidence: "high",
          rationale: "No visible focus ring. <script>alert('xss')</script> injected to test escaping.",
          findings: [
            {
              summary: "Focused input shows no outline <b>at all</b>",
              severity: 4,
              evidenceRefs: ["att-000-focused.png"],
              // Real judge shape: an object, not a string.
              elementPointer: { selector: "input#q1", testId: "q1-input" },
              suggestedFix: "Add a visible :focus-visible outline"
            }
          ],
          evidenceGaps: [],
          requestedProbes: ["hover-state"]
        }
      })
    );
    fs.writeFileSync(
      path.join(samplesDir, "survey-taking__2.4.7__s1.json"),
      JSON.stringify({
        pageId: "survey-taking",
        criterion: "2.4.7",
        sampleIndex: 1,
        cached: true,
        evidenceManifestPath: manifestPath,
        rejectedFindings: [],
        verdict: {
          criterion: "2.4.7",
          verdict: "needs_human",
          confidence: "low",
          rationale: "Ambiguous.",
          findings: [],
          evidenceGaps: ["Need a higher-resolution focus crop"],
          requestedProbes: []
        }
      })
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the verdict matrix cell", () => {
    const html = renderReport({ verdictsDir, evidenceDir });
    expect(html).toContain("survey-taking");
    expect(html).toContain("2.4.7");
    expect(html).toContain('class="cell v-fail"');
    expect(html).toContain("FAIL");
    // non-unanimous marker
    expect(html).toContain("○");
  });

  it("never stringifies objects into the markup", () => {
    const html = renderReport({ verdictsDir, evidenceDir });
    expect(html).not.toContain("[object Object]");
    // elementPointer objects render as compact text
    expect(html).toContain("testId=q1-input");
    expect(html).toContain("input#q1");
  });

  it("inlines cited screenshots as base64 data URIs", () => {
    const html = renderReport({ verdictsDir, evidenceDir });
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain(PNG_1X1_BASE64);
    // alt text = attachment role + probeId
    expect(html).toContain("focused-crop (focus-indicator-1)");
  });

  it("HTML-escapes untrusted model text", () => {
    const html = renderReport({ verdictsDir, evidenceDir });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;b&gt;at all&lt;/b&gt;");
  });

  it("renders the cost/usage footer", () => {
    const html = renderReport({ verdictsDir, evidenceDir });
    expect(html).toContain("Usage &amp; cost");
    expect(html).toContain("6 calls");
    expect(html).toContain("2 cache hits");
    expect(html).toContain("estimated cost $1.2345");
  });

  it("writes to outFile when provided", () => {
    const outFile = path.join(verdictsDir, "report.html");
    renderReport({ verdictsDir, evidenceDir, outFile });
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf8")).toContain("<!DOCTYPE html>");
  });

  it("tolerates a missing verdict directory", () => {
    const html = renderReport({ verdictsDir: path.join(tmpDir, "nope"), evidenceDir });
    expect(html).toContain("No verdicts found.");
  });
});

describe("applyMutationFromEnv", () => {
  const ORIGINAL = process.env.A11Y_MUTATION;

  function makeMockPage(): { page: Page; scripts: unknown[] } {
    const scripts: unknown[] = [];
    const page = {
      addInitScript: async (script: unknown) => {
        scripts.push(script);
      }
    } as unknown as Page;
    return { page, scripts };
  }

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.A11Y_MUTATION;
    else process.env.A11Y_MUTATION = ORIGINAL;
  });

  it("returns null and applies nothing when the env var is unset", async () => {
    delete process.env.A11Y_MUTATION;
    const { page, scripts } = makeMockPage();
    const result = await applyMutationFromEnv(page);
    expect(result).toBeNull();
    expect(scripts).toHaveLength(0);
  });

  it("applies and returns the matching mutation when the env var is set", async () => {
    process.env.A11Y_MUTATION = "247-outline-none";
    const { page, scripts } = makeMockPage();
    const result = await applyMutationFromEnv(page);
    expect(result?.id).toBe("247-outline-none");
    expect(result?.criterion).toBe("2.4.7");
    expect(result?.expected).toBe("fail");
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("throws on an unknown mutation id", async () => {
    process.env.A11Y_MUTATION = "does-not-exist";
    const { page } = makeMockPage();
    await expect(applyMutationFromEnv(page)).rejects.toThrow(/Unknown/);
  });

  it("registers at least the 8 required mutations with unique ids", () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(8);
    const ids = MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "247-outline-none",
      "132-survey-options-first",
      "412-strip-labels",
      "413-silent-toast",
      "243-tabindex-shuffle",
      "111-alt-degrade",
      "246-headings-generic",
      "331-hide-error-text"
    ]) {
      expect(getMutation(id)?.id).toBe(id);
    }
  });
});
