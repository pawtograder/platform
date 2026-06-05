/**
 * Unified submission-file ingestion core.
 *
 * This is the single mechanical "writer" that takes a student's code (either an
 * already-downloaded zipball buffer, or a repo+sha to clone) and writes its
 * files into `submission_files` for a given submission:
 *   - text files     → inline in `submission_files.contents`
 *   - binary files   → uploaded to the `submission-files` storage bucket at the
 *                      submission-scoped key
 *                      `classes/{class}/profiles/{profileOrGroup}/submissions/{submission}/files/{path}`
 *                      then a `submission_files` row referencing the storage key.
 *
 * It is deliberately ONLY the writer: it does NOT make autograder decisions
 * (workflow-sha validation, submissionFiles glob requirements, due-date checks,
 * rate-limits, grade.yml dispatch). Those stay in the callers. The two existing
 * callers — `autograder-create-submission` and `_shared/PrSubmissionFiles.ts` —
 * both used to carry byte-for-byte copies of this logic; this module unifies
 * them so there is exactly one place where files get written.
 *
 * Behavior is preserved exactly from the autograder path:
 *   - identical path sanitization (getSafeRelativePath / normalizeFilenameWhitespace
 *     / sanitizeSegmentForSupabaseStorage / sanitizePathForSupabaseStorageObjectKey),
 *   - identical BINARY_EXTENSIONS / MIME_TYPES sets,
 *   - identical per-file 50 MB cap and the two pre-unzip guards
 *     (MAX_SUBMISSION_ZIP_* / MAX_SUBMISSION_UNZIPPED_*),
 *   - identical binary storage-key shape and de-dup suffixing,
 *   - identical combined empty-submission hash (sorted "name\0hex\n").
 *
 * `fileFilter` (optional) lets the autograder restrict ingestion to the files
 * that match its `submissionFiles` glob set; PR/push-direct callers pass none
 * (ingest the whole head tree). `detectEmptyForAssignmentId` (optional) enables
 * the handout-hash empty-submission check and returns `isEmpty`.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Open as openZip } from "npm:unzipper";
import * as Sentry from "npm:@sentry/deno";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { cloneRepository, getRepoToCloneConsideringE2E } from "./GitHubWrapper.ts";
import type { Database } from "./SupabaseTypes.d.ts";

// Safety guards for the in-memory repo unzip. create-submission downloads the
// student repo as a zipball and unzips it inside the edge isolate, whose heap is
// capped (256MB, matching supabase.com). A repo with committed build
// artifacts/caches can blow that cap and get the worker killed mid-request.
// These limits reject the pathological case early. Both are env-tunable.
const MAX_SUBMISSION_ZIP_MB = Number(Deno.env.get("MAX_SUBMISSION_ZIP_MB")) || 120;
const MAX_SUBMISSION_UNZIPPED_MB = Number(Deno.env.get("MAX_SUBMISSION_UNZIPPED_MB")) || 300;
const MAX_SUBMISSION_ZIP_BYTES = MAX_SUBMISSION_ZIP_MB * 1024 * 1024;
const MAX_SUBMISSION_UNZIPPED_BYTES = MAX_SUBMISSION_UNZIPPED_MB * 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file

// Binary file detection by extension. (SVG excluded — text-based XML, stored
// inline for markdown image resolution.)
const BINARY_EXTENSIONS = new Set([
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".tif",
  // Documents
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  // Archives
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  // Media
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".webm",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Other binary
  ".class",
  ".jar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".pyc",
  ".sqlite",
  ".db",
  ".bin",
  ".dat"
]);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.substring(lastDot).toLowerCase() : "";
}

function isBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(getFileExtension(name));
}

function sha256Hex(buf: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(buf);
  return hash.digest("hex");
}

/** Combined empty-submission hash from per-file SHA-256 hex strings (sorted by path). */
function combinedHashFromPerFileHexHashes(file_hashes: Record<string, string>): string {
  const combinedInput = Object.keys(file_hashes)
    .sort()
    .map((name) => `${name}\0${file_hashes[name]}\n`)
    .join("");
  return sha256Hex(Buffer.from(combinedInput, "utf-8"));
}

/**
 * Returns a sanitized relative path: no ".." or "." segments, no backslashes,
 * no leading/trailing slashes. Preserves safe subpaths for display names.
 */
function getSafeRelativePath(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (resolved.length > 0) resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  const result = resolved.join("/");
  if (result === "") return "unnamed";
  return result;
}

/** Map Unicode whitespace (e.g. U+202F in macOS screenshot names) to ASCII space per segment. */
function normalizeFilenameWhitespace(resolvedRelativePath: string): string {
  return resolvedRelativePath
    .split("/")
    .map((seg) => {
      let out = "";
      for (const ch of seg.normalize("NFC")) {
        out += /\p{White_Space}/u.test(ch) ? " " : ch;
      }
      return out.replace(/ +/g, " ").trim();
    })
    .join("/");
}

/**
 * Per-segment sanitization for Supabase Storage object keys (file name restrictions in docs).
 * Replaces any character outside the allowed set with underscore.
 */
function sanitizeSegmentForSupabaseStorage(seg: string): string {
  const normalized = seg.normalize("NFC");
  const allowed = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-',!*$&@=;:+?() ");
  let out = "";
  for (const ch of normalized) {
    if (allowed.has(ch)) out += ch;
    else if (/\p{White_Space}/u.test(ch)) out += " ";
    else out += "_";
  }
  const trimmed = out.replace(/ +/g, " ").trim();
  const collapsed = trimmed.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return collapsed.length > 0 ? collapsed : "unnamed";
}

function sanitizePathForSupabaseStorageObjectKey(resolvedRelativePath: string): string {
  if (resolvedRelativePath === "") return "unnamed";
  return resolvedRelativePath.split("/").map(sanitizeSegmentForSupabaseStorage).join("/");
}

/** Raised when the submission zip/extracted contents exceed the safety guards. */
export class SubmissionTooLargeError extends Error {
  readonly kind: "download" | "extracted";
  readonly observedMb: number;
  readonly limitMb: number;
  constructor(kind: "download" | "extracted", observedMb: number, limitMb: number) {
    super(`Submission too large: ${observedMb} MB ${kind} > ${limitMb} MB`);
    this.name = "SubmissionTooLargeError";
    this.kind = kind;
    this.observedMb = observedMb;
    this.limitMb = limitMb;
  }
}

/** Raised when a single file exceeds the per-file 50 MB cap. */
export class SubmissionFileTooLargeError extends Error {
  readonly fileName: string;
  readonly fileSize: number;
  constructor(fileName: string, fileSize: number) {
    super(`File "${fileName}" exceeds the 50 MB per-file limit`);
    this.name = "SubmissionFileTooLargeError";
    this.fileName = fileName;
    this.fileSize = fileSize;
  }
}

export type IngestScope = {
  adminSupabase: SupabaseClient<Database>;
  submissionId: number;
  classId: number;
  profileId: string | null;
  groupId: number | null;
  /**
   * Optional path filter (relative to repo root, top dir stripped). Return true
   * to ingest the file. The autograder passes its submissionFiles glob matcher;
   * PR/push-direct callers pass nothing (ingest everything).
   */
  fileFilter?: (relativePath: string) => boolean;
  /**
   * When set, after writing files the combined per-file hash is compared to the
   * recorded `assignment_handout_file_hashes` for this assignment; the result is
   * returned as `isEmpty` (the caller decides whether to reject). When omitted,
   * `isEmpty` is null.
   */
  detectEmptyForAssignmentId?: number;
  scope?: Sentry.Scope;
};

export type IngestFromZipParams = IngestScope & {
  zipBuffer: Buffer;
};

export type IngestFromRepoParams = IngestScope & {
  repo: string; // "owner/name"
  sha: string;
};

export type IngestResult = {
  combinedHash: string;
  isEmpty: boolean | null;
};

/**
 * Write the files from an already-downloaded zipball into submission_files.
 *
 * The two size guards throw `SubmissionTooLargeError`; the per-file cap throws
 * `SubmissionFileTooLargeError`. Callers map these to their own user-facing
 * errors and cleanup as needed.
 */
export async function ingestSubmissionFilesFromZip(params: IngestFromZipParams): Promise<IngestResult> {
  const {
    adminSupabase,
    zipBuffer,
    submissionId,
    classId,
    profileId,
    groupId,
    fileFilter,
    detectEmptyForAssignmentId,
    scope
  } = params;

  if (zipBuffer.length > MAX_SUBMISSION_ZIP_BYTES) {
    throw new SubmissionTooLargeError("download", Math.ceil(zipBuffer.length / (1024 * 1024)), MAX_SUBMISSION_ZIP_MB);
  }

  const zip = await openZip.buffer(zipBuffer);

  const totalUncompressedBytes = zip.files.reduce(
    (sum: number, f: { uncompressedSize?: number }) => sum + (f.uncompressedSize ?? 0),
    0
  );
  if (totalUncompressedBytes > MAX_SUBMISSION_UNZIPPED_BYTES) {
    throw new SubmissionTooLargeError(
      "extracted",
      Math.ceil(totalUncompressedBytes / (1024 * 1024)),
      MAX_SUBMISSION_UNZIPPED_MB
    );
  }

  const stripTopDir = (str: string) => str.split("/").slice(1).join("/");
  const files = zip.files.filter((f: { path: string; type: string }) => {
    if (f.type !== "File") return false;
    const rel = stripTopDir(f.path);
    if (rel === "") return false;
    if (fileFilter && !fileFilter(rel)) return false;
    return true;
  });

  const storageProfileKey = profileId || groupId;
  const file_hashes: Record<string, string> = {};
  const usedBinaryStorageRelPaths = new Set<string>();

  // One in-flight file buffer at a time (zipball is already fully buffered).
  for (const zipEntry of files) {
    const name = stripTopDir(zipEntry.path);
    const contents: Buffer = await zipEntry.buffer();

    if (contents.length > MAX_FILE_SIZE) {
      throw new SubmissionFileTooLargeError(name, contents.length);
    }

    file_hashes[name] = sha256Hex(contents);

    if (isBinaryFile(name)) {
      const logicalPath = normalizeFilenameWhitespace(getSafeRelativePath(name));
      let storageRelPath = sanitizePathForSupabaseStorageObjectKey(logicalPath);
      if (usedBinaryStorageRelPaths.has(storageRelPath)) {
        const extDup = getFileExtension(storageRelPath);
        const base = extDup.length > 0 ? storageRelPath.slice(0, -extDup.length) : storageRelPath;
        let n = 2;
        while (usedBinaryStorageRelPaths.has(`${base}__${n}${extDup}`)) n++;
        storageRelPath = `${base}__${n}${extDup}`;
      }
      usedBinaryStorageRelPaths.add(storageRelPath);

      const ext = getFileExtension(logicalPath);
      const mimeType = MIME_TYPES[ext] || "application/octet-stream";
      const storageKey = `classes/${classId}/profiles/${storageProfileKey}/submissions/${submissionId}/files/${storageRelPath}`;

      const { error: storageError } = await adminSupabase.storage
        .from("submission-files")
        .upload(storageKey, contents, { contentType: mimeType, upsert: true });
      if (storageError) {
        Sentry.captureException(storageError, scope);
        throw new Error(`Failed to upload binary file "${logicalPath}" to storage: ${storageError.message}`);
      }

      const { error: dbError } = await adminSupabase.from("submission_files").insert({
        submission_id: submissionId,
        name: logicalPath,
        profile_id: profileId,
        assignment_group_id: groupId,
        contents: null,
        class_id: classId,
        is_binary: true,
        file_size: contents.length,
        mime_type: mimeType,
        storage_key: storageKey
      });
      if (dbError) {
        const removeErr = await adminSupabase.storage.from("submission-files").remove([storageKey]);
        if (removeErr.error) {
          Sentry.captureException(removeErr.error, scope);
        }
        Sentry.captureException(dbError, scope);
        throw new Error(`Failed to insert binary file record for "${logicalPath}": ${dbError.message}`);
      }
    } else {
      const { error: textFileError } = await adminSupabase.from("submission_files").insert({
        submission_id: submissionId,
        name,
        profile_id: profileId,
        assignment_group_id: groupId,
        contents: contents.toString("utf-8"),
        class_id: classId,
        is_binary: false,
        file_size: contents.length
      });
      if (textFileError) {
        Sentry.captureException(textFileError, scope);
        throw new Error(`Failed to insert text submission file "${name}": ${textFileError.message}`);
      }
    }
  }

  const combinedHash = combinedHashFromPerFileHexHashes(file_hashes);

  let isEmpty: boolean | null = null;
  if (detectEmptyForAssignmentId !== undefined) {
    // Empty submission detection: if the submitted files match ANY recorded
    // handout version for the assignment, mark the submission as empty.
    const { data: match, error: matchError } = await adminSupabase
      .from("assignment_handout_file_hashes")
      .select("id")
      .eq("assignment_id", detectEmptyForAssignmentId)
      .eq("combined_hash", combinedHash)
      .limit(1)
      .maybeSingle();
    if (matchError) {
      Sentry.captureException(matchError, scope);
    }
    isEmpty = !!match;
  }

  return { combinedHash, isEmpty };
}

/**
 * Download `repo` at `sha` via cloneRepository, then ingest its files. Mirrors
 * how PrSubmissionFiles.ts fetched the head fork. `cloneRepository` resolves the
 * ptg GitHub App installation for the repo's own org (handles cross-org forks).
 */
export async function ingestSubmissionFilesFromRepo(params: IngestFromRepoParams): Promise<IngestResult> {
  const { repo, sha, scope, ...rest } = params;
  // Resolve E2E repos (`<real>--<suffix>`) to the real fixture repo, matching the
  // autograder, so E2E webhook-direct ingestion clones the real test repo in CI
  // (the E2E_MOCK_GITHUB canned path is handled by the callers for local runs).
  const zipBuffer = await cloneRepository(getRepoToCloneConsideringE2E(repo), sha, scope);
  return await ingestSubmissionFilesFromZip({ ...rest, scope, zipBuffer });
}
