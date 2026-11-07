/**
 * The survey draft upsert the student page sends while the page is being hidden or unloaded.
 *
 * A reload or a closed tab never unmounts React, and the browser cancels an ordinary request once
 * the page unloads, so answers still waiting for the autosave debounce were lost. A `keepalive`
 * fetch outlives the page. The Supabase client cannot send one: it has no per-request fetch
 * options, and it reads the access token asynchronously, which may not finish before the page is
 * gone. So this posts to PostgREST directly, with the anon key and the student's own access token,
 * as the same upsert the client sends (same table, `on_conflict` and row), so the same RLS applies.
 */
import type { TablesInsert } from "@/utils/supabase/SupabaseTypes";

export type SurveyResponseUpsert = Pick<
  TablesInsert<"survey_responses">,
  "survey_id" | "profile_id" | "response" | "is_submitted" | "submitted_at"
>;

/**
 * Browsers cap the bodies of all keepalive requests a page has in flight at 64 KiB together, and
 * reject a keepalive request that would pass that. These requests stay within 60 KiB together: one
 * that would pass it goes out as an ordinary request instead. That one may be canceled by the
 * unload, but a rejected keepalive request is never sent at all.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

/** Body bytes of the keepalive requests sent from here that haven't finished yet. */
let keepaliveBytesInFlight = 0;

export class SurveyResponseWriteError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(status: number, body: { code?: string; message?: string; details?: string; hint?: string }) {
    super(body.message || `Saving the survey response failed with HTTP ${status}.`);
    this.name = "SurveyResponseWriteError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.hint = body.hint;
  }
}

export async function upsertSurveyResponseWithKeepalive(args: {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  row: SurveyResponseUpsert;
  signal?: AbortSignal;
}): Promise<void> {
  const body = JSON.stringify(args.row);
  const bodyBytes = new TextEncoder().encode(body).length;
  const keepalive = keepaliveBytesInFlight + bodyBytes <= KEEPALIVE_BODY_LIMIT_BYTES;
  if (keepalive) keepaliveBytesInFlight += bodyBytes;
  try {
    const response = await fetch(`${args.supabaseUrl}/rest/v1/survey_responses?on_conflict=survey_id,profile_id`, {
      method: "POST",
      headers: {
        apikey: args.anonKey,
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body,
      keepalive,
      signal: args.signal
    });
    if (!response.ok) {
      let errorBody = {};
      try {
        errorBody = await response.json();
      } catch {
        // Not a PostgREST error body; the status alone has to do.
      }
      throw new SurveyResponseWriteError(response.status, errorBody);
    }
  } finally {
    // Freed once the reply has arrived, or the request has failed.
    if (keepalive) keepaliveBytesInFlight -= bodyBytes;
  }
}
