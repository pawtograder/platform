/**
 * Wave-1 unit tests for the agentic AT harness (a11y-judge v2): pure helpers
 * only — live VSR injection/browser driving stays in the env-gated Playwright
 * gates, mirroring the a11y-judge CLI-backend test split.
 */
import {
  buildObservation,
  filterNoise,
  DEFAULT_NOISE_PATTERNS,
  READ_NEXT_MAX,
  STRUCTURAL_COMMANDS
} from "../../tools/a11y-judge/agent/atHarness";
import { vsrBuildOptions, exportGlobalSuffix, VSR_GLOBAL } from "../../tools/a11y-judge/agent/vsrBundle";

describe("filterNoise", () => {
  it("drops realtime-connection churn phrases by default", () => {
    const phrases = [
      "heading, Gradebook, level 1",
      "status, All realtime connections active",
      "Realtime connection status: connecting",
      "button, Submit"
    ];
    expect(filterNoise(phrases)).toEqual(["heading, Gradebook, level 1", "button, Submit"]);
  });

  it("keeps everything when given no matching patterns", () => {
    const phrases = ["a", "b"];
    expect(filterNoise(phrases, [/nope/])).toEqual(phrases);
  });
});

describe("buildObservation", () => {
  const raw = ["status, All realtime connections active", "textbox, What is your name?"];

  it("filters noise into spokenSinceLastAction but callers keep raw separately", () => {
    const obs = buildObservation(raw, "textbox, What is your name?", 'textbox "What is your name?"');
    expect(obs.spokenSinceLastAction).toEqual(["textbox, What is your name?"]);
    expect(obs.currentItem).toBe("textbox, What is your name?");
    expect(obs.domFocus).toBe('textbox "What is your name?"');
    expect(obs.error).toBeUndefined();
  });

  it("carries a command error through without dropping phrases", () => {
    const obs = buildObservation(raw, "", null, { error: "boom" });
    expect(obs.error).toBe("boom");
    expect(obs.spokenSinceLastAction).toEqual(["textbox, What is your name?"]);
  });

  it("honors custom noise patterns", () => {
    const obs = buildObservation(["secret 1", "hello"], "", null, { noisePatterns: [/secret/] });
    expect(obs.spokenSinceLastAction).toEqual(["hello"]);
  });
});

describe("vsrBundle config", () => {
  it("builds a browser IIFE with the harness global and no file writes", () => {
    const opts = vsrBuildOptions("/fake/entry.js");
    expect(opts).toMatchObject({
      bundle: true,
      format: "iife",
      globalName: VSR_GLOBAL,
      platform: "browser",
      write: false
    });
    expect(opts.entryPoints).toEqual(["/fake/entry.js"]);
  });

  it("exports the IIFE var as an explicit window global (addInitScript scoping)", () => {
    expect(exportGlobalSuffix("__X")).toBe("\n;window.__X = __X;");
  });
});

describe("harness constants", () => {
  it("bounds batch reads", () => {
    expect(READ_NEXT_MAX).toBe(25);
  });

  it("exposes heading/landmark structural navigation (turn-budget + realism)", () => {
    expect(STRUCTURAL_COMMANDS).toEqual(expect.arrayContaining(["moveToNextHeading", "moveToNextLandmark"]));
  });

  it("default noise patterns match the app's realtime status phrases", () => {
    const noisy = "Realtime connection status: All realtime connections active";
    expect(DEFAULT_NOISE_PATTERNS.some((re) => re.test(noisy))).toBe(true);
  });
});
