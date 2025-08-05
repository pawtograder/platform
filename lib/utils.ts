import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { clsx, type ClassValue } from "clsx";
import { differenceInHours, formatDistance } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function dueDateAdvice(date: string | null, courseTimezone?: string) {
  let advice = "";
  if (courseTimezone && date) {
    const hoursUntilDue = differenceInHours(new TZDate(date), TZDate.tz(courseTimezone));
    if (hoursUntilDue < 36) {
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

export function appendTimezoneOffset(date: string | null, timezone: string) {
  if (!date) {
    return date;
  }
  const notTheRightTimeButRightTimezone = new TZDate(date, timezone).toISOString();
  const offset = notTheRightTimeButRightTimezone.substring(notTheRightTimeButRightTimezone.length - 6);
  //If there is already an offset, keep it as is
  if (date.charAt(date.length - 6) === "+" || date.charAt(date.length - 6) === "-") {
    return date;
  }
  return date + offset;
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
