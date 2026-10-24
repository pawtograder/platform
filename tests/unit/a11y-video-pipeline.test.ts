/**
 * Unit tests for the keyboard-nav video pipeline's pure pieces: caption
 * formatting (videoOverlay) and sidecar dedupe + gallery rendering (collect).
 */
import { formatCaption } from "../../tools/a11y-judge/agent/videoOverlay";
import { pickBestPerTask, renderGalleryHtml, taskKey, type VideoMeta } from "../../tools/a11y-judge/videos/collect";

function meta(overrides: Partial<VideoMeta>): VideoMeta {
  return {
    pageId: "survey-taking",
    taskId: "survey-complete",
    prompt: "Complete the survey.",
    status: "passed",
    expectedStatus: "passed",
    stepCount: 20,
    durationMs: 45_000,
    retry: 0,
    videoPath: "/tmp/video.webm",
    ...overrides
  };
}

describe("formatCaption", () => {
  it("labels the step and command, quoting the arg when present", () => {
    expect(formatCaption(3, "type", "Ada Lovelace")).toBe("step 3 — type “Ada Lovelace”");
    expect(formatCaption(0, "next")).toBe("step 0 — next");
    expect(formatCaption(1, "act", "")).toBe("step 1 — act");
  });
});

describe("pickBestPerTask", () => {
  it("prefers a passed attempt over a failed one regardless of retry order", () => {
    const failedRetry = meta({ status: "failed", retry: 2 });
    const passedFirst = meta({ retry: 0 });
    expect(pickBestPerTask([failedRetry, passedFirst])).toEqual([passedFirst]);
    expect(pickBestPerTask([passedFirst, failedRetry])).toEqual([passedFirst]);
  });

  it("keeps the latest retry when outcomes tie, and sorts by task key", () => {
    const older = meta({ status: "failed", retry: 0 });
    const newer = meta({ status: "failed", retry: 1 });
    const other = meta({ pageId: "discussion", taskId: "discussion-reply" });
    const best = pickBestPerTask([older, other, newer]);
    expect(best.map(taskKey)).toEqual(["discussion__discussion-reply", "survey-taking__survey-complete"]);
    expect(best[1].retry).toBe(1);
  });
});

describe("renderGalleryHtml", () => {
  it("renders a card per entry with badge, prompt, and video (or a missing note)", () => {
    const html = renderGalleryHtml(
      [
        { ...meta({}), videoFile: "survey-taking__survey-complete.webm" },
        { ...meta({ pageId: "discussion", taskId: "discussion-reply", status: "failed" }), videoFile: null }
      ],
      "run-1"
    );
    expect(html).toContain('src="survey-taking__survey-complete.webm"');
    expect(html).toContain('class="badge pass"');
    expect(html).toContain("FAILED");
    expect(html).toContain("video missing");
    expect(html).toContain("Complete the survey.");
  });

  it("escapes HTML in prompts", () => {
    const html = renderGalleryHtml([{ ...meta({ prompt: 'say "<hi>"' }), videoFile: null }], "run-1");
    expect(html).toContain("say &quot;&lt;hi&gt;&quot;");
    expect(html).not.toContain("<hi>");
  });
});
