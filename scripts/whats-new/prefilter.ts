/**
 * Step 1 of the What's New suggestion bot (docs/prd-whats-new-bot.md): decide without a model call
 * whether a merged PR could need a walkthrough. Pure, so tests/unit/whats-new-suggest.test.ts can
 * cover every rule.
 */

export type PrefilterInput = {
  title: string;
  labels: string[];
  files: string[];
};

export type PrefilterResult =
  | { send: true; matchedFiles: string[] }
  | { send: false; reason: string; matchedFiles: string[] };

/**
 * Conventional-commit types whose PRs don't add something users run into. `fix` is not one of them:
 * a fix can make a feature visible for the first time, such as the office hours OP badge, which a
 * new request only showed after a reload until #1166.
 */
const SKIPPED_TITLE_TYPES = ["chore", "test", "docs", "ci", "refactor", "build", "perf"];
const SKIPPED_TITLE = new RegExp(`^(${SKIPPED_TITLE_TYPES.join("|")})(\\([^)]*\\))?!?:`, "i");

/** Paths whose changes can change what users see. lib/courseFeatures.ts adds Feature flags toggles (#1351). */
const UI_PREFIXES = ["app/", "components/", "hooks/"];
const UI_FILES = ["lib/courseFeatures.ts"];

export const NO_WHATS_NEW_LABEL = "no-whats-new";
export const ENTRIES_DIR = "lib/whatsNew/entries/";

function isTestFile(path: string) {
  return /(^|\/)(tests?|__tests__|__mocks__)\//.test(path) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

/** Changed files that can change what users see, test files excluded. */
export function uiFiles(files: string[]): string[] {
  return files.filter(
    (path) => !isTestFile(path) && (UI_FILES.includes(path) || UI_PREFIXES.some((prefix) => path.startsWith(prefix)))
  );
}

export function prefilter({ title, labels, files }: PrefilterInput): PrefilterResult {
  const matchedFiles = uiFiles(files);
  const type = title.trim().match(SKIPPED_TITLE)?.[1];
  if (type) return { send: false, reason: `title starts with "${type.toLowerCase()}"`, matchedFiles };
  if (labels.includes(NO_WHATS_NEW_LABEL))
    return { send: false, reason: `labeled ${NO_WHATS_NEW_LABEL}`, matchedFiles };
  if (files.some((path) => path.startsWith(ENTRIES_DIR))) {
    return { send: false, reason: `already changes a file under ${ENTRIES_DIR}`, matchedFiles };
  }
  if (matchedFiles.length === 0) {
    return {
      send: false,
      reason: `no changed file under ${UI_PREFIXES.join(", ")} or ${UI_FILES.join(", ")}`,
      matchedFiles
    };
  }
  return { send: true, matchedFiles };
}

/**
 * The parts of a unified diff (`gh pr diff`) that touch `paths`, so the model sees only the files
 * the pre-filter matched.
 */
export function diffForFiles(diff: string, paths: string[]): string {
  const wanted = new Set(paths);
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const header = section.match(/^diff --git a\/(\S+) b\/(\S+)/);
      return header !== null && (wanted.has(header[1]) || wanted.has(header[2]));
    })
    .join("");
}
