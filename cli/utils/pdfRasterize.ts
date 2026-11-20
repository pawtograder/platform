/**
 * Node rasterization of a scanned-exam PDF, the CLI's counterpart of lib/exam/pdfRasterize.ts.
 * It renders at the same scale with the same rounding, so pages come out the size the Scans
 * page uploads.
 *
 * pdfjs-dist is imported on first use, so only `exams scans upload` loads it. In Node it renders
 * through @napi-rs/canvas, an optional dependency of pdfjs-dist.
 */

import * as path from "path";
import { CLIError } from "@/cli/utils/logger";

interface RasterPage {
  /** 0-based, as exam_scan_pages.page_index. */
  pageIndex: number;
  png: Buffer;
  width: number;
  height: number;
}

interface PdfCanvas {
  width: number;
  height: number;
  toBuffer(mime: "image/png"): Buffer;
}

interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
  canvasFactory: {
    create(width: number, height: number): { canvas: PdfCanvas; context: unknown };
    destroy(canvasAndContext: { canvas: PdfCanvas; context: unknown }): void;
  };
}

export async function openPdf(bytes: Uint8Array): Promise<PdfDocumentLike> {
  // pdfjs sets up its Node canvas through process.getBuiltinModule (Node 20.16+). Without it, the
  // canvas check below fails and blames @napi-rs/canvas.
  if (typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule !== "function") {
    throw new CLIError(`Rasterizing a PDF needs Node.js 20.16 or later; this is ${process.version}.`);
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs polyfills Path2D from @napi-rs/canvas when it loads, and only warns when it can't.
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
    throw new CLIError(
      "Rasterizing a PDF needs the @napi-rs/canvas package, which did not install on this machine.\n" +
        "   Install it next to the CLI (npm install @napi-rs/canvas) and try again."
    );
  }
  // The browser draws non-embedded standard fonts (Helvetica, Times) with system fonts. Node has
  // none, so without pdfjs's own font data that text is dropped from the page.
  const standardFontDataUrl = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/");
  return (await pdfjs.getDocument({ data: bytes, standardFontDataUrl }).promise) as unknown as PdfDocumentLike;
}

/** Renders each page in order. The caller owns `doc` and destroys it. */
export async function* rasterizePages(doc: PdfDocumentLike, scale = 2): AsyncGenerator<RasterPage> {
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale });
    const target = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: target.context, viewport }).promise;
    const { width, height } = target.canvas;
    const png = target.canvas.toBuffer("image/png");
    // The canvas's pixels are native memory the GC doesn't count, so free them now.
    doc.canvasFactory.destroy(target);
    page.cleanup();
    yield { pageIndex: n - 1, png, width, height };
  }
}
