/**
 * Client-side contract for the course Gemini API key RPCs (#1126):
 * get_course_gemini_key_status, set_course_gemini_key and remove_course_gemini_key.
 *
 * The RPCs never return key material. This module only interprets their secret-free responses and
 * error codes, and turns them into fixed, user-facing text; it never echoes server messages that
 * could carry input.
 */

export type GeminiKeyStatus = { setup_enabled: boolean; configured: boolean };

export type GeminiKeyRpcError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * - forbidden: not an active instructor of the course (or the course does not exist)
 * - invalid: blank or over-long key; nothing changed
 * - disabled: setup is disabled for the course; nothing changed
 * - busy: another change to the course was in progress; nothing changed
 * - failed: the server answered with any other error; nothing changed
 * - unknown: no answer from the server (network loss, timeout); the change may or may not have applied
 */
export type GeminiKeyFailure = "forbidden" | "invalid" | "disabled" | "busy" | "failed" | "unknown";

export function classifyGeminiKeyError(error: GeminiKeyRpcError, httpStatus?: number): GeminiKeyFailure {
  // postgrest-js reports a fetch that never got a response with status 0.
  if (httpStatus === 0) return "unknown";
  const code = error?.code ?? "";
  if (code === "42501") return "forbidden";
  if (code === "22023") return "invalid";
  if (code === "55000") return "disabled";
  if (code === "55P03") return "busy";
  // PostgREST and Postgres always attach a code to a response they produced. supabase-js reports a
  // fetch that never got a response (offline, aborted, timed out) with an empty code.
  if (code === "") return "unknown";
  return "failed";
}

export const GEMINI_KEY_FAILURE_TEXT: Record<GeminiKeyFailure, string> = {
  forbidden: "You don't have permission to manage this course's Gemini API key.",
  invalid: "Enter a key. Blank values and values longer than 4,096 characters are not accepted. Nothing was changed.",
  disabled:
    "Gemini API key setup is disabled for this course, so a key can't be saved or replaced. Nothing was changed.",
  busy: "Another change to this course was in progress. Nothing was changed; try again.",
  failed: "The change could not be completed. Nothing was changed.",
  unknown:
    "We couldn't confirm whether the change was applied. The status below has been re-read from the server; check it before trying again."
};

export function parseGeminiKeyStatus(data: unknown): GeminiKeyStatus | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.setup_enabled !== "boolean" || typeof d.configured !== "boolean") return null;
  return { setup_enabled: d.setup_enabled, configured: d.configured };
}

export type GeminiKeyOutcome = "saved" | "replaced" | "removed" | "already_absent";

const OUTCOMES_BY_KIND: Record<"save" | "remove", readonly GeminiKeyOutcome[]> = {
  save: ["saved", "replaced"],
  remove: ["removed", "already_absent"]
};

/**
 * Returns the mutation's outcome only when it is one the requested operation can produce. Anything
 * else (missing body, unknown or mismatched outcome) returns null: the client can't tell what happened.
 */
export function parseGeminiKeyOutcome(kind: "save" | "remove", data: unknown): GeminiKeyOutcome | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const outcome = (data as Record<string, unknown>).outcome;
  return OUTCOMES_BY_KIND[kind].find((o) => o === outcome) ?? null;
}

export function successText(outcome: GeminiKeyOutcome): string {
  switch (outcome) {
    case "saved":
      return "Key saved. It has not been checked with Google, and saving it does not turn on AI grading.";
    case "replaced":
      return "Key replaced. The new key has not been checked with Google.";
    case "removed":
      return "Key removed from Pawtograder. This does not revoke the key at Google.";
    case "already_absent":
      return "No key was stored, so there was nothing to remove.";
  }
}

/** Mirrors the server's trimming for client-side messaging only; the server decides. */
export function isBlankGeminiKey(value: string): boolean {
  return /^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*$/u.test(value);
}
