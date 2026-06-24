/**
 * Pure builder for a submission_files export record (no DB / Deno access).
 *
 * Kept self-contained so it can be imported from Node-based unit tests without
 * pulling in Deno-only modules (supabase client, `.ts`-extension imports).
 */

export interface BuildFileExportRecordInput {
  submissionId: number;
  submissionToken?: string;
  name: string;
  is_binary: boolean;
  contents?: string | null;
  content_base64?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  withBinary: boolean;
}

/** Build a file export record without DB access — used in unit tests. */
export function buildFileExportRecord(input: BuildFileExportRecordInput): Record<string, unknown> {
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
    // Treat "" (valid base64 for a zero-byte file) as present, not omitted.
    if (input.withBinary && input.content_base64 !== undefined && input.content_base64 !== null) {
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
