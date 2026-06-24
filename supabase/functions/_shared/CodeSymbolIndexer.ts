/**
 * Server-side symbol indexing for a submission's source files.
 *
 * Parses each text file with {@link parseSymbols} and stores the result as one row per file in
 * `submission_file_symbol_index` (per-file JSONB). Reused by the `index-submission` edge function
 * and called inline from submission ingestion. Deno-only (imports the JSR Supabase client); the
 * frontend/backfill never import this — the backfill invokes the edge function instead.
 */
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "./SupabaseTypes.d.ts";
import { getSymbolLanguage, parseSymbols } from "./CodeSymbolParser.ts";

export type IndexSubmissionResult = {
  /** Files that were parsed and written to the index. */
  indexed: number;
  /** Files skipped because they are binary or an unsupported language. */
  skipped: number;
};

/**
 * (Re)build the symbol index for every supported, non-binary file in a submission.
 * Upserts one row per file keyed by `submission_file_id`, so re-running is idempotent.
 */
export async function indexSubmission(
  adminClient: SupabaseClient<Database>,
  submissionId: number
): Promise<IndexSubmissionResult> {
  const { data: files, error } = await adminClient
    .from("submission_files")
    .select("id, name, contents, is_binary, class_id, submission_id, profile_id, assignment_group_id")
    .eq("submission_id", submissionId);
  if (error) {
    throw new Error(`Failed to load submission files for indexing: ${error.message}`);
  }

  const rows: Database["public"]["Tables"]["submission_file_symbol_index"]["Insert"][] = [];
  let skipped = 0;
  for (const file of files ?? []) {
    const language = getSymbolLanguage(file.name);
    if (file.is_binary || language === null || file.contents == null) {
      skipped++;
      continue;
    }
    const symbols = parseSymbols(file.contents, file.name);
    rows.push({
      submission_file_id: file.id,
      submission_id: file.submission_id,
      class_id: file.class_id,
      profile_id: file.profile_id,
      assignment_group_id: file.assignment_group_id,
      language,
      symbols: symbols as unknown as Database["public"]["Tables"]["submission_file_symbol_index"]["Insert"]["symbols"],
      indexed_at: new Date().toISOString()
    });
  }

  if (rows.length > 0) {
    const { error: upsertError } = await adminClient
      .from("submission_file_symbol_index")
      .upsert(rows, { onConflict: "submission_file_id" });
    if (upsertError) {
      throw new Error(`Failed to upsert symbol index: ${upsertError.message}`);
    }
  }

  return { indexed: rows.length, skipped };
}
