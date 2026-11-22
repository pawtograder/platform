import { repoWebUrl } from "@/hooks/useForgejoInstanceUrl";

describe("repository web URLs", () => {
  it("uses the supplied host for repository and commit links", () => {
    expect(repoWebUrl("https://forgejo.example.test/", "course/homework", "/commit/abc123")).toBe(
      "https://forgejo.example.test/course/homework/commit/abc123"
    );
    expect(repoWebUrl("https://github.com", "course/homework")).toBe("https://github.com/course/homework");
  });

  it("uses Forgejo's source path for a file at a commit", () => {
    expect(repoWebUrl("https://forgejo.example.test", "course/homework", "/blob/abc123/main.ts")).toBe(
      "https://forgejo.example.test/course/homework/src/commit/abc123/main.ts"
    );
    expect(repoWebUrl("https://github.com", "course/homework", "/blob/abc123/main.ts")).toBe(
      "https://github.com/course/homework/blob/abc123/main.ts"
    );
  });

  it("has no link until both the host and repository are known", () => {
    expect(repoWebUrl(undefined, "course/homework", "/commit/abc123")).toBeUndefined();
    expect(repoWebUrl("https://forgejo.example.test", null)).toBeUndefined();
  });
});
