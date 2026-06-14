import { decodeJwtPayloadUnsafe, isJwtExpired, middlewareNeedsSupabaseGetSession } from "@/utils/supabase/jwtPayload";

function b64url(obj: object): string {
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("decodeJwtPayloadUnsafe", () => {
  it("decodes a standard JWT payload", () => {
    const payload = { sub: "abc", email: "a@b.com", exp: 2000000000 };
    const token = `xx.${b64url(payload)}.yy`;
    expect(decodeJwtPayloadUnsafe(token)).toEqual(payload);
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtPayloadUnsafe("not-a-jwt")).toBeNull();
    expect(decodeJwtPayloadUnsafe("a.b")).toBeNull();
  });
});

describe("isJwtExpired", () => {
  it("treats missing exp as not expired", () => {
    expect(isJwtExpired({}, 100)).toBe(false);
  });

  it("detects expired JWTs", () => {
    expect(isJwtExpired({ exp: 100 }, 100)).toBe(true);
    expect(isJwtExpired({ exp: 101 }, 100)).toBe(false);
  });
});

describe("middlewareNeedsSupabaseGetSession", () => {
  it("requires getSession when token missing or payload invalid", () => {
    expect(middlewareNeedsSupabaseGetSession(null, null)).toBe(true);
    expect(middlewareNeedsSupabaseGetSession("tok", null)).toBe(true);
    expect(middlewareNeedsSupabaseGetSession("tok", {})).toBe(true);
  });

  it("skips getSession when token has sub and is not expired", () => {
    const payload = { sub: "u1", exp: 2000000000 };
    const token = `h.${b64url(payload)}.s`;
    expect(middlewareNeedsSupabaseGetSession(token, payload)).toBe(false);
  });

  it("requires getSession when JWT is expired", () => {
    const payload = { sub: "u1", exp: 1 };
    const token = `h.${b64url(payload)}.s`;
    expect(middlewareNeedsSupabaseGetSession(token, payload)).toBe(true);
  });
});
