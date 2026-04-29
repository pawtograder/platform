import {
  readAccessTokenFromCookiePairs,
  supabaseAuthCookieStorageKeyFromUrl
} from "@/utils/supabase/middlewareSession";

describe("supabaseAuthCookieStorageKeyFromUrl", () => {
  it("matches supabase-js default storage key shape", () => {
    expect(supabaseAuthCookieStorageKeyFromUrl("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
  });
});

describe("readAccessTokenFromCookiePairs", () => {
  const url = "https://abcdefgh.supabase.co";
  const key = supabaseAuthCookieStorageKeyFromUrl(url);

  it("reads access_token from a single cookie", () => {
    const session = { access_token: "at-123", expires_at: 9999999999 };
    // @supabase/ssr stores the raw JSON string when it fits in one chunk
    const cookies = [{ name: key, value: JSON.stringify(session) }];
    expect(readAccessTokenFromCookiePairs(cookies, key)).toBe("at-123");
  });

  it("joins chunked cookies", () => {
    const session = { access_token: "joined-token" };
    const json = JSON.stringify(session);
    const part0 = json.slice(0, 5);
    const part1 = json.slice(5);
    const cookies = [
      { name: `${key}.0`, value: part0 },
      { name: `${key}.1`, value: part1 }
    ];
    expect(readAccessTokenFromCookiePairs(cookies, key)).toBe("joined-token");
  });

  it("returns null when cookie absent", () => {
    expect(readAccessTokenFromCookiePairs([], key)).toBeNull();
  });
});
