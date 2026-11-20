import { safeRedirectPath, sameOriginRedirectPath } from "@/lib/redirectPath";

describe("safeRedirectPath", () => {
  it.each(["/", "/course", "/course/1/assignments?tab=open#top", "/oauth/consent?authorization_id=abc%2Fdef"])(
    "keeps the same-origin path %s",
    (path) => {
      expect(safeRedirectPath(path)).toBe(path);
    }
  );

  it.each([null, undefined, ""])("treats %p as no redirect", (value) => {
    expect(safeRedirectPath(value)).toBeUndefined();
  });

  it.each(["//evil.test", "///evil.test", "//evil.test/oauth/consent"])("rejects protocol-relative %s", (value) => {
    expect(safeRedirectPath(value)).toBeUndefined();
  });

  it.each(["/\\evil.test", "\\\\evil.test", "/\\/evil.test", "/course\\..\\evil"])(
    "rejects backslashes in %s",
    (value) => {
      expect(safeRedirectPath(value)).toBeUndefined();
    }
  );

  it.each(["/\t/evil.test", "/\n/evil.test", "/\r/evil.test", "/\u0000/evil.test", "/\u007f/evil.test"])(
    "rejects control characters in %j",
    (value) => {
      expect(safeRedirectPath(value)).toBeUndefined();
    }
  );

  it.each([
    "https://evil.test/",
    "http://pawtograder.invalid/course",
    "javascript:alert(1)",
    "evil.test/course",
    "course"
  ])("rejects %s, which is not an absolute path", (value) => {
    expect(safeRedirectPath(value)).toBeUndefined();
  });
});

describe("sameOriginRedirectPath", () => {
  const app = "https://app.example";

  it("turns a URL on the app's origin into its path, query and fragment", () => {
    expect(sameOriginRedirectPath("https://app.example/oauth/consent?authorization_id=abc#x", app)).toBe(
      "/oauth/consent?authorization_id=abc#x"
    );
  });

  it("gives / for GoTrue's site URL fallback", () => {
    expect(sameOriginRedirectPath("https://app.example", app)).toBe("/");
    expect(sameOriginRedirectPath("https://app.example/", `${app}/`)).toBe("/");
  });

  it("accepts a same-origin path", () => {
    expect(sameOriginRedirectPath("/course", app)).toBe("/course");
  });

  it.each([
    "https://evil.test/oauth/consent",
    "https://app.example.evil.test/",
    "https://evil.test@app.example.evil.test/",
    "http://app.example/course",
    "https://app.example:8443/course",
    "//evil.test/course",
    "/\\evil.test",
    "/\t/evil.test",
    "javascript:alert(1)"
  ])("rejects %s", (value) => {
    expect(sameOriginRedirectPath(value, app)).toBeUndefined();
  });

  it("re-checks the path, so a same-origin URL with a // path is rejected", () => {
    expect(sameOriginRedirectPath("https://app.example//evil.test/course", app)).toBeUndefined();
  });

  it.each([
    [null, app],
    ["", app],
    ["https://app.example/course", undefined],
    ["https://app.example/course", ""],
    ["https://app.example/course", "not a url"],
    ["http://[::1", app]
  ])("gives undefined for value %p and base %p", (value, base) => {
    expect(sameOriginRedirectPath(value, base)).toBeUndefined();
  });
});
