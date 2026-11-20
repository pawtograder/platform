/**
 * @jest-environment node
 */

/**
 * #1325: `pawtograder exams scans upload`.
 *
 * The CLI uploads through the service role, so the checks the web gets from RLS and storage
 * policies have to hold in the handler: refuse a pages-per-exam the template doesn't match before
 * anything is uploaded, never add a page outside the batch, record the real image size, and number
 * pages the way exam_scan_pages expects (0-based). A mistake in any of them groups the wrong pages
 * into a student's exam, and nothing reports it.
 */

import {
  addPageError,
  pageIndexError,
  pagesPerExamError,
  parsePngDimensions,
  unevenPagesError
} from "@/supabase/functions/cli/utils/examScans";
import { rasterizePages, type PdfDocumentLike } from "@/cli/utils/pdfRasterize";

describe("pagesPerExamError", () => {
  it.each([
    [2, 2, false],
    [2, 1, true],
    [2, 4, true],
    [0, 3, false],
    [2, 0, true],
    [2, -1, true],
    [2, 1.5, true],
    [2, Number.NaN, true],
    [2, "2", true]
  ])("template %p, pages-per-exam %p: refused is %p", (template, perExam, refused) => {
    expect(pagesPerExamError(template, perExam) !== null).toBe(refused);
  });
});

describe("unevenPagesError", () => {
  // The worker refuses a batch whose pages don't divide into exams, but only after OCR.
  it.each([
    [4, 2, false],
    [2, 2, false],
    [3, 2, true],
    [1, 2, true]
  ])("%p pages at %p per exam: refused is %p", (total, perExam, refused) => {
    expect(unevenPagesError(total, perExam) !== null).toBe(refused);
  });
});

describe("pageIndexError", () => {
  it.each([[-1], [4], [1.5], ["0"], [undefined]])("refuses page_index %p in a 4-page batch", (pageIndex) => {
    expect(pageIndexError(pageIndex, 4)).not.toBeNull();
  });

  it.each([[0], [3]])("accepts page_index %p in a 4-page batch", (pageIndex) => {
    expect(pageIndexError(pageIndex, 4)).toBeNull();
  });
});

describe("addPageError", () => {
  it("allows a new page while the batch is 'uploaded'", () => {
    expect(addPageError("uploaded")).toBeNull();
  });

  it("refuses a new page once the batch has moved past 'uploaded'", () => {
    expect(addPageError("ocr")).toContain("ocr");
  });
});

describe("parsePngDimensions", () => {
  function png(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  }

  it("reads width and height from IHDR", () => {
    expect(parsePngDimensions(png(1224, 1584))).toEqual({ width: 1224, height: 1584 });
  });

  it.each([
    ["a JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(30).fill(0)])],
    ["a truncated PNG", png(1224, 1584).slice(0, 20)],
    ["a zero-width PNG", png(0, 1584)]
  ])("rejects %s", (_label, bytes) => {
    expect(parsePngDimensions(bytes)).toBeNull();
  });
});

describe("rasterizePages", () => {
  function fakeDoc(numPages: number): PdfDocumentLike {
    return {
      numPages,
      async getPage() {
        return {
          getViewport: ({ scale }: { scale: number }) => ({ width: 612.4 * scale, height: 792 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => {}
        };
      },
      async destroy() {},
      canvasFactory: {
        create: (width: number, height: number) => ({
          canvas: { width, height, toBuffer: () => Buffer.from([width, height]) },
          context: {}
        }),
        destroy: () => {}
      }
    };
  }

  it("yields 0-based page indexes in order, at the browser's rounded size", async () => {
    const pages = [];
    for await (const page of rasterizePages(fakeDoc(3))) pages.push(page);
    expect(pages.map((p) => [p.pageIndex, p.width, p.height])).toEqual([
      [0, 1225, 1584],
      [1, 1225, 1584],
      [2, 1225, 1584]
    ]);
  });
});
