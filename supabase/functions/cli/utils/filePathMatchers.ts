/**
 * Glob matching for submission file paths in export filters.
 *
 * Patterns use minimatch-style * and ? on the full file path (submission_files.name).
 * ** matches across path separators; * and ? do not match /.
 */

function globPatternToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+^${}()|[]\\.".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

function matchesGlob(pattern: string, path: string): boolean {
  const re = globPatternToRegExp(pattern);
  if (re.test(path)) return true;
  // Patterns without / also match the basename (e.g. *.java matches src/Main.java).
  if (!pattern.includes("/")) {
    const slash = path.lastIndexOf("/");
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    return re.test(base);
  }
  return false;
}

/** True when the file path passes include/exclude filters (empty lists = no constraint). */
export function matchesSubmissionFilePath(
  filePath: string,
  includePatterns: string[] | undefined,
  excludePatterns: string[] | undefined
): boolean {
  if (includePatterns && includePatterns.length > 0) {
    if (!includePatterns.some((p) => matchesGlob(p, filePath))) return false;
  }
  if (excludePatterns && excludePatterns.length > 0) {
    if (excludePatterns.some((p) => matchesGlob(p, filePath))) return false;
  }
  return true;
}
