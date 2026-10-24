/**
 * EvidenceBundleWriter: accumulates probes + attachments for a single
 * (page, criterion) evidence bundle, then finalizes to `manifest.json` with a
 * canonical content hash.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` (types), the local schema,
 * and node builtins. No image library is pulled in — PNG downscaling (needed to
 * keep vision costs bounded) is performed IN-BROWSER via `downscalePngInPage`
 * using OffscreenCanvas, so the core stays dependency-free.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import {
  computeContentHash,
  EvidenceBundleSchema,
  type Attachment,
  type CollectorInfo,
  type EvidenceBundle,
  type PageMeta,
  type Probe
} from "../schema/evidence";

/** Long-edge pixel cap for stored PNG attachments. */
const MAX_LONG_EDGE = 1000;

export interface AddAttachmentInput {
  buffer: Buffer;
  mime: string;
  role: string;
  probeId: string | null;
  suggestedName: string;
}

export interface AddAttachmentResult {
  /** Stable id, equal to the relative `file` path recorded in the manifest. */
  id: string;
  file: string;
  sha256: string;
  /** Whether the PNG was downscaled on write (false when no page was supplied). */
  downscaled: boolean;
}

export interface EvidenceBundleWriterOptions {
  /**
   * Optional Playwright page used solely for in-browser PNG downscaling. When
   * omitted, oversized images are stored as-is with `downscaled: false`.
   */
  page?: Page;
}

/** Read the width/height from a PNG IHDR chunk without any image library. */
function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4); width/height are the
  // next two big-endian uint32s at byte offsets 16 and 20.
  if (buffer.length < 24) return null;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (!isPng) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Downscale a PNG so its long edge is <= maxLongEdge, re-encoding in-browser via
 * OffscreenCanvas + createImageBitmap on a base64 data URL. Returns the original
 * buffer unchanged if it is already small enough. Keeps the core free of
 * sharp/jimp by borrowing the browser's codec.
 */
export async function downscalePngInPage(page: Page, buffer: Buffer, maxLongEdge: number): Promise<Buffer> {
  const outputBase64 = await page.evaluate(
    async ({ data, maxEdge }) => {
      const response = await fetch(`data:image/png;base64,${data}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const longEdge = Math.max(bitmap.width, bitmap.height);
      if (longEdge <= maxEdge) {
        bitmap.close();
        return null;
      }
      const scale = maxEdge / longEdge;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const outBlob = await canvas.convertToBlob({ type: "image/png" });
      const arrayBuffer = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },
    { data: buffer.toString("base64"), maxEdge: maxLongEdge }
  );
  if (outputBase64 === null) return buffer;
  return Buffer.from(outputBase64, "base64");
}

export class EvidenceBundleWriter {
  private readonly outDir: string;
  private readonly pageMeta: PageMeta;
  private readonly page?: Page;
  private readonly probes: Probe[] = [];
  private readonly attachments: Attachment[] = [];
  private attachmentCounter = 0;

  constructor(outDir: string, pageMeta: PageMeta, options: EvidenceBundleWriterOptions = {}) {
    this.outDir = outDir;
    this.pageMeta = pageMeta;
    this.page = options.page;
  }

  addProbe(probe: Probe): void {
    this.probes.push(probe);
  }

  async addAttachment(input: AddAttachmentInput): Promise<AddAttachmentResult> {
    fs.mkdirSync(this.outDir, { recursive: true });

    let buffer = input.buffer;
    let downscaled = false;
    if (this.page && input.mime === "image/png") {
      const size = readPngSize(buffer);
      if (size && Math.max(size.width, size.height) > MAX_LONG_EDGE) {
        const scaled = await downscalePngInPage(this.page, buffer, MAX_LONG_EDGE);
        if (scaled !== buffer) {
          buffer = scaled;
          downscaled = true;
        }
      }
    }

    const index = this.attachmentCounter++;
    const safeName = input.suggestedName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = `att-${String(index).padStart(3, "0")}-${safeName}`;
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    fs.writeFileSync(path.join(this.outDir, file), buffer);

    this.attachments.push({
      file,
      sha256,
      mime: input.mime,
      role: input.role,
      probeId: input.probeId
    });
    return { id: file, file, sha256, downscaled };
  }

  async finalize(criterion: string, collectorInfo: CollectorInfo): Promise<EvidenceBundle> {
    const bundleWithoutHash = {
      schemaVersion: 1 as const,
      page: this.pageMeta,
      criterion,
      collector: collectorInfo,
      collectedAt: new Date().toISOString(),
      probes: this.probes,
      attachments: this.attachments,
      contentHash: ""
    };
    const contentHash = computeContentHash(
      bundleWithoutHash,
      this.attachments.map((attachment) => attachment.sha256)
    );
    const bundle = EvidenceBundleSchema.parse({ ...bundleWithoutHash, contentHash });

    fs.mkdirSync(this.outDir, { recursive: true });
    fs.writeFileSync(path.join(this.outDir, "manifest.json"), JSON.stringify(bundle, null, 2));
    return bundle;
  }
}
