/**
 * PR-mode submission file ingestion.
 *
 * For pr-mode assignments there is no autograder workflow that packages the
 * student's code, so ptg fetches it itself: given a PR head fork repo + head
 * sha, download the zipball (via cloneRepository, which resolves the ptg GitHub
 * App installation for the *fork's own org* — the cross-org case), and write the
 * files into `submission_files` exactly like autograder-create-submission does
 * (text inline, binary→storage at the submission-scoped key that
 * can_access_submission_storage_path authorizes). Without this a pr-mode
 * submission has no files and there is nothing for a grader to view or diff.
 *
 * Unlike the autograder path this does NOT gate on a pawtograder.yml
 * `submissionFiles` pattern set (pr-mode assignments have no autograder config):
 * the whole head tree is ingested. The diff base is the snapshotted base_sha on
 * the submission row.
 *
 * Idempotent: if the submission already has files (webhook re-delivery, or
 * ingest_pr_submission returned an existing version), this is a no-op.
 */
import { Buffer } from "node:buffer";
import { Open as openZip } from "npm:unzipper";
import * as Sentry from "npm:@sentry/deno";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { cloneRepository, END_TO_END_REPO_PREFIX } from "./GitHubWrapper.ts";
import type { Database } from "./SupabaseTypes.d.ts";

// Mirrors the guards in autograder-create-submission so a hostile/huge PR can't
// OOM the edge isolate.
const MAX_SUBMISSION_ZIP_MB = Number(Deno.env.get("MAX_SUBMISSION_ZIP_MB")) || 120;
const MAX_SUBMISSION_UNZIPPED_MB = Number(Deno.env.get("MAX_SUBMISSION_UNZIPPED_MB")) || 300;
const MAX_SUBMISSION_ZIP_BYTES = MAX_SUBMISSION_ZIP_MB * 1024 * 1024;
const MAX_SUBMISSION_UNZIPPED_BYTES = MAX_SUBMISSION_UNZIPPED_MB * 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".tif",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
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

// Resolve "../" etc. so a malicious archive can't escape the submission path.
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
  return result === "" ? "unnamed" : result;
}

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

export type IngestPrFilesParams = {
  adminSupabase: SupabaseClient<Database>;
  submissionId: number;
  classId: number;
  profileId: string | null;
  groupId: number | null;
  headRepo: string; // the PR head fork, "owner/name"
  headSha: string;
  scope?: Sentry.Scope;
};

/**
 * Download the PR head fork at headSha and write its files to submission_files
 * for `submissionId`. No-op if the submission already has files.
 */
export async function ingestPrSubmissionFiles(params: IngestPrFilesParams): Promise<void> {
  const { adminSupabase, submissionId, classId, profileId, groupId, headRepo, headSha, scope } = params;

  // Idempotency: a submission version maps to a single head sha; if its files
  // are already present (re-delivery, or an existing version was returned),
  // don't fetch or write again.
  const { count: existingFiles } = await adminSupabase
    .from("submission_files")
    .select("id", { count: "exact", head: true })
    .eq("submission_id", submissionId);
  if ((existingFiles ?? 0) > 0) {
    return;
  }

  const storageProfileKey = profileId || groupId;

  // E2E fast path: under E2E_MOCK_GITHUB the head repo isn't a real GitHub repo,
  // so bypass the fetch and write a single canned file (parallels the
  // autograder-create-submission E2E mock) so the flow is end-to-end testable.
  const e2eMock = Deno.env.get("E2E_MOCK_GITHUB") === "true" && headRepo.startsWith(END_TO_END_REPO_PREFIX);
  if (e2eMock) {
    const mockContents = `// PR submission mock for ${headRepo}@${headSha}\n`;
    const { error } = await adminSupabase.from("submission_files").insert({
      submission_id: submissionId,
      name: "Main.java",
      profile_id: profileId,
      assignment_group_id: groupId,
      contents: mockContents,
      class_id: classId,
      is_binary: false,
      file_size: mockContents.length
    });
    if (error) {
      Sentry.captureException(error, scope);
      throw error;
    }
    return;
  }

  // cloneRepository resolves getOctoKit for headRepo's OWN org (cross-org forks)
  // and returns the zipball buffer. Throws if the ptg App isn't installed there.
  const repo = await cloneRepository(headRepo, headSha, scope);

  if (repo.length > MAX_SUBMISSION_ZIP_BYTES) {
    throw new Error(
      `PR head zip too large: ${Math.ceil(repo.length / (1024 * 1024))} MB > ${MAX_SUBMISSION_ZIP_MB} MB`
    );
  }

  const zip = await openZip.buffer(repo);
  const totalUncompressedBytes = zip.files.reduce(
    (sum: number, f: { uncompressedSize?: number }) => sum + (f.uncompressedSize ?? 0),
    0
  );
  if (totalUncompressedBytes > MAX_SUBMISSION_UNZIPPED_BYTES) {
    throw new Error(
      `PR head unzipped too large: ${Math.ceil(totalUncompressedBytes / (1024 * 1024))} MB > ${MAX_SUBMISSION_UNZIPPED_MB} MB`
    );
  }

  const stripTopDir = (str: string) => str.split("/").slice(1).join("/");
  const files = zip.files.filter(
    (f: { path: string; type: string }) => f.type === "File" && stripTopDir(f.path) !== ""
  );

  const usedBinaryStorageRelPaths = new Set<string>();
  for (const zipEntry of files) {
    const name = stripTopDir(zipEntry.path);
    const contents: Buffer = await zipEntry.buffer();
    if (contents.length > MAX_FILE_SIZE) {
      throw new Error(`File "${name}" exceeds the 50 MB per-file limit`);
    }

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
        throw new Error(`Failed to upload binary file "${logicalPath}": ${storageError.message}`);
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
        await adminSupabase.storage.from("submission-files").remove([storageKey]);
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
}
