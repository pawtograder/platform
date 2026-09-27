import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { clsx, type ClassValue } from "clsx";
import { differenceInHours, differenceInMilliseconds, formatDistance } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function dueDateAdvice(date: string | null, courseTimezone?: string) {
  let advice = "";
  if (courseTimezone && date) {
    const hoursUntilDue = differenceInHours(new TZDate(date), TZDate.tz(courseTimezone));
    const msUntilDue = differenceInMilliseconds(new TZDate(date), TZDate.tz(courseTimezone));
    if (msUntilDue < 0) {
      advice = ` (Overdue: ${formatDistance(new TZDate(date), TZDate.tz(courseTimezone))} ago)`;
    } else if (hoursUntilDue < 36) {
      advice = ` (${formatDistance(new TZDate(date), TZDate.tz(courseTimezone))})`;
    }
  }
  return advice;
}

export function formatDueDateInTimezone(
  date: string | null,
  courseTimezone?: string,
  includeTimezone?: boolean,
  giveAdvice?: boolean
) {
  if (!date) {
    return "N/A";
  }
  const timezone = includeTimezone ? ` (${courseTimezone}) ` : "";
  const advice = giveAdvice === true ? dueDateAdvice(date, courseTimezone) : "";
  return formatInTimeZone(date, courseTimezone || "America/New_York", "MMM d h:mm aaa") + timezone + advice;
}

/** Matches a trailing UTC designator or numeric offset: "Z", "+05:30", "-0400". */
export const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** The exact shape an `<input type="datetime-local">` produces: a wall clock with no zone. */
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Stamp the offset `timezone` has *at the entered wall clock* onto a `datetime-local` value,
 * so "2026-09-01T09:00" becomes "2026-09-01T09:00-04:00" for a New York course.
 *
 * The offset has to be resolved from the wall clock in the target zone, not from the same text
 * parsed in the browser's zone: those two instants differ by up to a day, so on a DST-transition
 * day the browser-anchored reading lands on the wrong side of the transition and the stamped
 * offset is an hour off (#890). `fromZonedTime` does the target-zone reading.
 *
 * Anything that is not a bare wall clock is returned unchanged: values that already carry an
 * offset or `Z`, empty values, and date-only values (which have no time to place in a zone).
 */
export function appendTimezoneOffset(date: string | null, timezone: string) {
  if (!date || !DATETIME_LOCAL.test(date)) {
    return date;
  }
  const instant = fromZonedTime(date, timezone);
  // `Date.parse(date + "Z")` reads the same wall clock as UTC, so the difference is exactly the
  // offset that turns this text into `instant`. Deriving it this way rather than formatting the
  // offset in effect *at* `instant` keeps the two in agreement inside a spring-forward gap, where
  // the entered wall clock does not exist and the two readings differ by an hour.
  const offsetMinutes = (Date.parse(date + "Z") - instant.getTime()) / 60_000;
  if (!Number.isFinite(offsetMinutes)) {
    // Nothing sensible to append. Hand the value back untouched and let the caller's own
    // validation reject it, rather than producing a string that only looks well-formed.
    return date;
  }
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absMinutes = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const mm = String(Math.round(absMinutes % 60)).padStart(2, "0");
  return `${date}${sign}${hh}:${mm}`;
}

/**
 * Resolve a value from a `datetime-local` input into an absolute instant, treating the
 * entered wall clock as being in `timezone`.
 *
 * A `datetime-local` value ("2026-09-01T09:00") carries no offset, so `new Date(...)` and
 * `new TZDate(..., tz)` both anchor it to the *browser's* zone — silently shifting the time
 * whenever the author is not sitting in the course time zone. Going through
 * `appendTimezoneOffset` first pins it to the course zone instead. Values that already carry
 * an offset (e.g. loaded back from the database) are passed through unchanged.
 *
 * Returns `null` for anything unparseable, so callers never have to reason about `Invalid Date`.
 */
/**
 * Render a stored timestamp as the value an `<input type="datetime-local">` accepts, showing the
 * wall clock in `timezone`. The inverse of `appendTimezoneOffset`.
 */
export function toDateTimeLocalValue(value: string | null | undefined, timezone: string): string {
  if (!value) {
    return "";
  }
  // A bare wall clock is already what the input wants; only zoned values need re-expressing in the
  // course zone. Matching on the same regex the write path uses keeps the two halves of the
  // round-trip in agreement — an offset form the reader failed to recognize would be handed to the
  // input verbatim, which rejects it and renders blank, silently discarding the date on save.
  if (!HAS_UTC_OFFSET.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  // "yyyy-MM-ddTHH:mm" — the format `<input type="datetime-local">` accepts.
  return formatInTimeZone(parsed, timezone, "yyyy-MM-dd'T'HH:mm");
}

export function parseZonedFormDate(date: string | null | undefined, timezone: string): Date | null {
  if (!date) {
    return null;
  }
  const parsed = new Date(appendTimezoneOffset(date, timezone)!);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Helper function to detect if a file is a text/code file
 * @param file - The file to check
 * @returns True if the file is a text/code file
 */
export const isTextFile = (file: File): boolean => {
  // Check MIME type first
  if (file.type.startsWith("text/")) {
    return true;
  }

  // Common code file extensions that might not have proper MIME types
  const textExtensions = [
    // Programming languages
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".java",
    ".cpp",
    ".c",
    ".h",
    ".cs",
    ".php",
    ".rb",
    ".go",
    ".rs",
    ".kt",
    ".swift",
    ".scala",
    ".clj",
    ".hs",
    ".ml",
    ".fs",
    ".elm",
    ".dart",
    ".lua",
    ".perl",
    ".pl",
    ".r",
    ".m",
    ".vb",
    ".pas",
    ".ada",
    ".asm",
    ".s",
    ".sh",
    ".bat",
    ".ps1",
    ".fish",
    ".zsh",
    ".bash",
    // Web technologies
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".xml",
    ".xhtml",
    ".svg",
    ".vue",
    ".svelte",
    // Data formats
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".env",
    // Documentation
    ".md",
    ".txt",
    ".rst",
    ".adoc",
    ".tex",
    ".rtf",
    // Configuration files
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
    ".tsconfig",
    ".jsconfig",
    ".dockerfile",
    ".dockerignore",
    ".makefile",
    ".cmake",
    ".gradle",
    ".maven",
    ".ant",
    // Database
    ".sql",
    ".mongodb",
    ".cql",
    ".cypher",
    // Other
    ".log",
    ".diff",
    ".patch",
    ".lock"
  ];

  const extension = "." + file.name.split(".").pop()?.toLowerCase();
  return textExtensions.includes(extension);
};

/**
 * Helper function to get language identifier for syntax highlighting
 * @param fileName - The filename to extract language from
 * @returns The language identifier for syntax highlighting
 */
export const getLanguageFromFile = (fileName: string): string => {
  const extension = fileName.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript family
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    // Web technologies
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    xml: "xml",
    svg: "xml",
    vue: "vue",
    svelte: "svelte",
    // Programming languages
    py: "python",
    java: "java",
    cpp: "cpp",
    c: "c",
    h: "c",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    go: "go",
    rs: "rust",
    kt: "kotlin",
    swift: "swift",
    scala: "scala",
    clj: "clojure",
    hs: "haskell",
    ml: "ocaml",
    fs: "fsharp",
    elm: "elm",
    dart: "dart",
    lua: "lua",
    perl: "perl",
    pl: "perl",
    r: "r",
    m: "matlab",
    vb: "vbnet",
    pas: "pascal",
    ada: "ada",
    asm: "assembly",
    s: "assembly",
    // Shell scripts
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "bash",
    bat: "batch",
    ps1: "powershell",
    // Data formats
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    properties: "properties",
    env: "bash",
    // Documentation
    md: "markdown",
    rst: "rst",
    tex: "latex",
    // Database
    sql: "sql",
    mongodb: "javascript",
    cql: "sql",
    cypher: "cypher",
    // Configuration
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    gradle: "gradle",
    // Other
    diff: "diff",
    patch: "diff",
    log: "text",
    txt: "text"
  };

  return languageMap[extension || ""] || "text";
};

/**
 * Get the color of a help queue type
 * @param queueType - The type of a help queue
 * @returns The color of the help queue type
 */
export const getQueueTypeColor = (queueType: HelpQueue["queue_type"] | null) => {
  if (!queueType) {
    return "gray";
  }
  switch (queueType) {
    case "text":
      return "blue";
    case "video":
      return "green";
    case "in_person":
      return "orange";
    default:
      return "gray";
  }
};
