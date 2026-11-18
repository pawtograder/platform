/**
 * Regression test for #1263.
 *
 * `RegionCrop` used to size a crop by fixing its rendered HEIGHT at 120px and letting the width
 * follow the aspect ratio. Rendered scale was therefore `120 / (region.height * page.height)`, a
 * function of the box the instructor drew rather than of anything a grader cares about. On the
 * seeded Midterm Exam 1 the short wide regions (numeric, true/false) filled the panel while the
 * tall free-text regions, the ones that actually need reading, came out as thumbnails.
 *
 * `cropDisplayWidth` has its own unit tests, but those cannot see the component going back to
 * height-driven sizing, which is the regression that matters. This drives the real renderer and
 * compares the two crops it produces.
 */
import { render, waitFor } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ExamSubmissionRenderer from "@/components/ui/exam-submission-renderer";
import type { SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: "https://example.test/page1.png" } })
      })
    }
  })
}));

const PAGE = { page_number: 1, storage_key: "class/1/page1.png", width: 1224, height: 1584 };
// The two shapes from the report, on one page so they share a scan resolution.
const WIDE_SHORT = { x: 0.1, y: 0.1, width: 0.8, height: 0.05 };
const TALL_NARROW = { x: 0.1, y: 0.3, width: 0.15, height: 0.4 };

function artifact(): SubmissionArtifact {
  return {
    data: {
      format: "exam_v1",
      pages: [PAGE],
      questions: [
        { exam_question_id: 1, page_number: 1, region: WIDE_SHORT, ocr_text: "3.4", structured_value: "3.4" },
        {
          exam_question_id: 2,
          page_number: 1,
          region: TALL_NARROW,
          ocr_text: "a paragraph",
          structured_value: "a paragraph"
        }
      ]
    }
  } as unknown as SubmissionArtifact;
}

async function renderedCrops() {
  const { container } = render(
    <ChakraProvider value={defaultSystem}>
      <ExamSubmissionRenderer artifact={artifact()} />
    </ChakraProvider>
  );
  // The crops are the only elements that paint the page image as a background.
  const crops = await waitFor(() => {
    const found = Array.from(container.querySelectorAll<HTMLElement>('div[style*="background-image"]'));
    expect(found).toHaveLength(2);
    return found;
  });
  return crops.map((el) => ({
    width: Number.parseFloat(el.style.width),
    aspectRatio: Number.parseFloat(el.style.aspectRatio)
  }));
}

describe("answer crops render at a consistent scale (#1263)", () => {
  it("gives both crops the same rendered pixels per scanned pixel", async () => {
    const [wide, tall] = await renderedCrops();
    const wideScale = wide.width / (WIDE_SHORT.width * PAGE.width);
    const tallScale = tall.width / (TALL_NARROW.width * PAGE.width);
    expect(wideScale).toBeCloseTo(tallScale, 3);
  });

  it("does not do it by flattening both crops to one shape (#1073 stays fixed)", async () => {
    const [wide, tall] = await renderedCrops();
    // Still each region's true shape: wide and short is still wide and short.
    expect(wide.aspectRatio).toBeCloseTo((WIDE_SHORT.width * PAGE.width) / (WIDE_SHORT.height * PAGE.height), 3);
    expect(tall.aspectRatio).toBeCloseTo((TALL_NARROW.width * PAGE.width) / (TALL_NARROW.height * PAGE.height), 3);
    expect(wide.aspectRatio).toBeGreaterThan(tall.aspectRatio);
  });

  it("would have failed before the fix", async () => {
    // The old sizing, for the record: width = round(120 * aspect). Reconstructed rather than
    // asserted against the component, so this test documents the defect the first test guards.
    const oldWidth = (r: typeof WIDE_SHORT) => Math.round(120 * ((r.width * PAGE.width) / (r.height * PAGE.height)));
    const oldWideScale = oldWidth(WIDE_SHORT) / (WIDE_SHORT.width * PAGE.width);
    const oldTallScale = oldWidth(TALL_NARROW) / (TALL_NARROW.width * PAGE.width);
    expect(oldWideScale / oldTallScale).toBeGreaterThan(5);
  });
});
