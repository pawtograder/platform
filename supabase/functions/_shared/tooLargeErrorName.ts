// Builds the student-visible `workflow_run_error.name` for a push-direct submission
// rejected for being too large.
//
// Extracted from github-repo-webhook so the length invariant can actually be tested. The
// column is CHECK (length("name") >= 1 AND length("name") <= 500)
// (workflow_run_error_name_length, 20250801174131) and the message is DETERMINISTIC, so an
// over-long value does not fail once — it fails identically on every webhook retry, the
// retained submission is cleaned up each time, and the student never receives the rejection
// at all. A deeply nested file path was enough to reach that.

/** `length("name") <= 500`, from workflow_run_error_name_length. */
export const MAX_ERROR_NAME_LENGTH = 500;

/**
 * Longest path to embed in a message. The surrounding sentence is ~145 characters, so this
 * leaves comfortable headroom under MAX_ERROR_NAME_LENGTH.
 */
export const MAX_ERROR_NAME_PATH_LENGTH = 300;

/**
 * Shorten an over-long path from the MIDDLE, keeping the leading directories and the file
 * name. Both ends are what let a student find the file: a tail truncation would drop the
 * name itself, and truncating the finished sentence would drop the instruction to push
 * again. Weighted towards the end, where the name is.
 */
export function shortenPathForErrorName(path: string): string {
  if (path.length <= MAX_ERROR_NAME_PATH_LENGTH) return path;
  const headLength = Math.floor((MAX_ERROR_NAME_PATH_LENGTH - 1) * 0.4);
  const tailLength = MAX_ERROR_NAME_PATH_LENGTH - 1 - headLength;
  return `${path.slice(0, headLength)}…${path.slice(path.length - tailLength)}`;
}

export type TooLargeErrorNameInputs =
  | {
      kind: "file_too_large";
      /** Abbreviated commit sha. Part of the message so the upsert key is unique per push. */
      shortSha: string;
      fileName: string;
      fileSize: number;
      perFileLimitMb: number;
    }
  | {
      kind: "submission_too_large";
      shortSha: string;
      observedMb: number;
      limitMb: number;
    };

/**
 * The message, guaranteed to satisfy the length constraint.
 *
 * The commit sha is deliberately near the FRONT: the upsert key is
 * (repository_id, run_number, run_attempt, name) and push-direct always uses 0/0, so the sha
 * is what keeps two oversized pushes from colliding on one row. Any bounding has to preserve
 * it, which middle-shortening the path does by construction — the final clamp below is a
 * belt-and-braces guard for future edits to the sentence, not the primary mechanism.
 */
export function buildTooLargeErrorName(inputs: TooLargeErrorNameInputs): string {
  const message =
    inputs.kind === "file_too_large"
      ? `Your submission at commit ${inputs.shortSha} was not recorded: the file "${shortenPathForErrorName(
          inputs.fileName
        )}" is ${(inputs.fileSize / (1024 * 1024)).toFixed(1)} MB, over the ${
          inputs.perFileLimitMb
        } MB per-file limit. Remove or shrink it and push again.`
      : `Your submission at commit ${inputs.shortSha} was not recorded: the repository is too large to process (${inputs.observedMb} MB, limit ${inputs.limitMb} MB). Remove large files — build output and caches are the usual cause — and push again.`;
  if (message.length <= MAX_ERROR_NAME_LENGTH) return message;
  return `${message.slice(0, MAX_ERROR_NAME_LENGTH - 1)}…`;
}
