/** Replace runner/repo prefixes before pawtograder-grading with /anonymous */
export function sanitizeGradingPaths(text: string): string {
  return text.replace(/(?:\/[^\s/]+)+(?=\/pawtograder-grading)/g, "/anonymous");
}

/** Return output from the first occurrence of sentinel (inclusive), or null if absent. */
export function sliceOutputFromSentinel(output: string, sentinel: string): string | null {
  const idx = output.indexOf(sentinel);
  if (idx === -1) return null;
  return output.slice(idx);
}

/**
 * Sanitize grading paths, then optionally keep only text from sentinel onward.
 * Returns null when sentinel is set but not found (row should be omitted).
 */
export function prepareInstructorBuildOutput(rawOutput: string, options: { sentinel?: string | null }): string | null {
  const sanitized = sanitizeGradingPaths(rawOutput);
  if (!options.sentinel) return sanitized;
  return sliceOutputFromSentinel(sanitized, options.sentinel);
}
