/**
 * The extension list the REST sync uses to call a file binary (`isBinaryPath` in
 * GitHubSyncHelpers.ts), copied byte for byte so the git engine can use it without importing the
 * REST stack (docs/handout-sync-git-worker.md §5.3).
 *
 * The engine ORs it with numstat's `-\t-`. Content sniffing alone would make a NUL-free PDF or
 * class file mergeable, which today's sync never did. The original stays in GitHubSyncHelpers.ts
 * until the REST path is deleted (§10.1); `binaryPath.test.ts` pins the two lists to each other.
 */
export function isBinaryPath(path: string): boolean {
  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".class",
    ".jar",
    ".war",
    ".ear",
    ".pyc",
    ".pyo",
    ".o",
    ".a",
    ".lib",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".webm",
    ".ogg",
    ".wav",
    ".flac"
  ];

  const lowerPath = path.toLowerCase();
  return binaryExtensions.some((ext) => lowerPath.endsWith(ext));
}
