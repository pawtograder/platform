/**
 * Stream submission_files rows for submissions export.
 */

import { Buffer } from "node:buffer";
import { CLICommandError } from "../errors.ts";
import { matchesSubmissionFilePath } from "./filePathMatchers.ts";
import { getAdminClient } from "./supabase.ts";
import type { Tokenizer } from "./tokenization.ts";

const FILE_PAGE_SIZE = 500;
/** Submission ids per files-section batch (passed from CLI between calls). */
export const FILES_SUBMISSION_BATCH_SIZE = 200;

export interface StreamSubmissionFilesOptions {
  withBinary: boolean;
  /** Zero-based batch over submissionIds (each batch covers FILES_SUBMISSION_BATCH_SIZE ids). */
  filesBatchIndex: number;
  submissionIds: number[];
  /** Glob patterns on submission_files.name — file must match at least one if set. */
  includeFiles?: string[];
  /** Glob patterns on submission_files.name — file is skipped if any match. */
  excludeFiles?: string[];
}

export interface StreamSubmissionFilesResult {
  fileCount: number;
  nextFilesBatchIndex: number | null;
}

export async function streamSubmissionFiles(
  supabase: ReturnType<typeof getAdminClient>,
  tokenizer: Tokenizer | null,
  writer: { write: (record: Record<string, unknown>) => Promise<void> },
  options: StreamSubmissionFilesOptions
): Promise<StreamSubmissionFilesResult> {
  const { withBinary, filesBatchIndex, submissionIds, includeFiles, excludeFiles } = options;
  const batchStart = filesBatchIndex * FILES_SUBMISSION_BATCH_SIZE;
  const batchIds = submissionIds.slice(batchStart, batchStart + FILES_SUBMISSION_BATCH_SIZE);

  if (batchIds.length === 0) {
    return { fileCount: 0, nextFilesBatchIndex: null };
  }

  let cursor = 0;
  let total = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("submission_files")
      .select("id, submission_id, name, contents, is_binary, file_size, mime_type, storage_key")
      .in("submission_id", batchIds)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(FILE_PAGE_SIZE);

    if (error) throw new CLICommandError(`Failed to load submission files: ${error.message}`, 500);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      if (!matchesSubmissionFilePath(row.name, includeFiles, excludeFiles)) continue;

      const submissionRef =
        tokenizer === null
          ? { id: row.submission_id }
          : { token: await tokenizer.token("submission", row.submission_id) };

      const record: Record<string, unknown> = {
        kind: "file",
        submission: submissionRef,
        name: row.name,
        is_binary: row.is_binary,
        mime_type: row.mime_type,
        file_size: row.file_size
      };

      if (row.is_binary) {
        if (withBinary) {
          if (!row.storage_key) {
            await writer.write({
              kind: "warning",
              scope: "files",
              message: "binary_file_missing_storage_key",
              submission_id: row.submission_id,
              name: row.name
            });
            record.binary_omitted = true;
            record.content_base64 = null;
          } else {
            const { data: blob, error: dlErr } = await supabase.storage
              .from("submission-files")
              .download(row.storage_key);
            if (dlErr || !blob) {
              await writer.write({
                kind: "warning",
                scope: "files",
                message: dlErr?.message ?? "binary_file_download_failed",
                submission_id: row.submission_id,
                name: row.name
              });
              record.binary_omitted = true;
              record.content_base64 = null;
            } else {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              record.content_base64 = Buffer.from(bytes).toString("base64");
              record.binary_omitted = false;
            }
          }
        } else {
          record.binary_omitted = true;
          record.content_base64 = null;
        }
        record.contents = null;
      } else {
        record.contents = row.contents;
        record.content_base64 = null;
        record.binary_omitted = false;
      }

      await writer.write(record);
      total += 1;
    }

    if (rows.length < FILE_PAGE_SIZE) break;
    cursor = rows[rows.length - 1]!.id;
  }

  const nextStart = batchStart + FILES_SUBMISSION_BATCH_SIZE;
  const nextFilesBatchIndex = nextStart < submissionIds.length ? filesBatchIndex + 1 : null;
  return { fileCount: total, nextFilesBatchIndex };
}

/** Build a file export record without DB access — used in unit tests. */
export function buildFileExportRecord(input: {
  submissionId: number;
  submissionToken?: string;
  name: string;
  is_binary: boolean;
  contents?: string | null;
  content_base64?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  withBinary: boolean;
}): Record<string, unknown> {
  const submissionRef =
    input.submissionToken !== undefined ? { token: input.submissionToken } : { id: input.submissionId };

  const record: Record<string, unknown> = {
    kind: "file",
    submission: submissionRef,
    name: input.name,
    is_binary: input.is_binary,
    mime_type: input.mime_type ?? null,
    file_size: input.file_size ?? null
  };

  if (input.is_binary) {
    if (input.withBinary && input.content_base64) {
      record.content_base64 = input.content_base64;
      record.binary_omitted = false;
    } else {
      record.content_base64 = null;
      record.binary_omitted = true;
    }
    record.contents = null;
  } else {
    record.contents = input.contents ?? null;
    record.content_base64 = null;
    record.binary_omitted = false;
  }

  return record;
}
