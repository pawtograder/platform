// Client-side PDF rasterization (browser canvas) using pdfjs-dist.
// Used by the instructor template/scan upload flows to turn a PDF into page PNGs
// that are uploaded to storage. Server code never touches PDFs.

export type RasterPage = {
  pageNumber: number;
  blob: Blob;
  width: number;
  height: number;
};

let workerConfigured = false;

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    // Resolve the worker as a bundled asset URL (works under the Next.js/webpack build).
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    workerConfigured = true;
  }
  return pdfjs;
}

/**
 * Render every page of a PDF to a PNG blob. `scale` controls resolution
 * (2 ≈ 144dpi for a US-letter page) — higher means better OCR at higher cost.
 */
export async function rasterizePdf(source: File | ArrayBuffer | Uint8Array, scale = 2): Promise<RasterPage[]> {
  if (typeof window === "undefined") {
    throw new Error("rasterizePdf must run in the browser");
  }
  const pdfjs = await loadPdfjs();
  const data =
    source instanceof File ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source as ArrayBuffer);

  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: RasterPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
      );
      pages.push({ pageNumber: n, blob, width: canvas.width, height: canvas.height });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
