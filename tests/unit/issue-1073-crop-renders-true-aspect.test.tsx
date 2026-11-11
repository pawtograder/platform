/**
 * Regression test for #1073, at the render level.
 *
 * `lib/exam/regionMath.ts` has unit tests for `cropAspect` itself, but those only prove the
 * function is right. Nothing asserted that `RegionCrop` actually calls it, so the component
 * could drift back to `region.width / region.height` with CI still green -- which is exactly
 * the bug: on the 1224x1584 pages finalize writes, that ratio is 1.294x too wide and every
 * answer crop in the grader view renders stretched sideways.
 *
 * `RegionCrop` is internal to the renderer, so these drive `ExamSubmissionRenderer` and read
 * the crop box out of the DOM. It is the only element the renderer gives an inline
 * background-image; the original-page views use <img src>.
 *
 * The first two tests fail if the fix is reverted. The third is the counterweight: artifacts
 * written before finalize recorded pages[].width/height must keep rendering as they do today.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ExamSubmissionRenderer from "@/components/ui/exam-submission-renderer";
import type { SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";

const createSignedUrl = jest.fn();

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({ createSignedUrl })
    }
  })
}));

// The page size finalize writes (exam-async-worker/index.ts:661).
const PAGE_W = 1224;
const PAGE_H = 1584;

// A region 80% of the page wide and 20% tall: 979.2 x 316.8 real pixels.
const REGION = { x: 0.1, y: 0.1, width: 0.8, height: 0.2 };
const TRUE_ASPECT = (REGION.width * PAGE_W) / (REGION.height * PAGE_H); // 3.0909...
const UNCORRECTED = REGION.width / REGION.height; // 4

function artifact(page: { width?: number; height?: number }): SubmissionArtifact {
  return {
    id: 7,
    submission_id: 42,
    name: "Exam",
    data: {
      format: "exam_v1",
      pages: [{ page_number: 1, storage_key: "class/1/page-1.png", ...page }],
      questions: [{ exam_question_id: 1, page_number: 1, region: REGION, ocr_text: "42", structured_value: null }]
    }
  } as unknown as SubmissionArtifact;
}

async function renderCrop(page: { width?: number; height?: number }): Promise<HTMLElement> {
  const { container } = render(
    <ChakraProvider value={defaultSystem}>
      <ExamSubmissionRenderer artifact={artifact(page)} />
    </ChakraProvider>
  );
  // The renderer signs page URLs in an effect and shows a spinner until they resolve.
  await screen.findByText("OCR text");
  const crop = container.querySelector<HTMLElement>('[style*="background-image"]');
  if (!crop) throw new Error("no crop box rendered");
  return crop;
}

describe("issue #1073: the rendered crop uses the page's pixel size", () => {
  beforeEach(() => {
    createSignedUrl.mockReset();
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://example.test/page-1.png" }, error: null });
  });

  it("renders the crop at the region's true pixel aspect, not the ratio of the two fractions", async () => {
    const crop = await renderCrop({ width: PAGE_W, height: PAGE_H });

    expect(parseFloat(crop.style.aspectRatio)).toBeCloseTo(TRUE_ASPECT, 3);
    // The whole point: the stretched value must not be what reaches the DOM.
    expect(parseFloat(crop.style.aspectRatio)).not.toBeCloseTo(UNCORRECTED, 2);
  });

  it("drives the box with width plus aspectRatio rather than an independent height", async () => {
    const crop = await renderCrop({ width: PAGE_W, height: PAGE_H });

    // height * aspect, with the component's default 120px height.
    expect(crop.style.width).toBe(`${Math.round(120 * TRUE_ASPECT)}px`);
    expect(crop.style.aspectRatio).not.toBe("");
    // An explicit height is what let a clamped crop distort again once the flex row shrank it.
    expect(crop.style.height).toBe("");
  });

  it("still falls back to the uncorrected ratio when the page records no pixel size", async () => {
    const crop = await renderCrop({});

    expect(parseFloat(crop.style.aspectRatio)).toBeCloseTo(UNCORRECTED, 3);
  });
});
