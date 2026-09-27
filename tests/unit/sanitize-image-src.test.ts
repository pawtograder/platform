import { sanitizeImageSrc } from "@/lib/sanitizeImageSrc";

describe("sanitizeImageSrc", () => {
  // The whole point: an empty / "#" src reaching an <img>/<Avatar.Image> inside an
  // async server layout corrupts Next's SSR stream (controller[kState].transformAlgorithm
  // is not a function). These must all coerce to `undefined` so the element omits `src`.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["hash", "#"],
    ["hash with surrounding whitespace", "  #  "],
    ["null", null],
    ["undefined", undefined]
  ])("returns undefined for %s", (_label, input) => {
    expect(sanitizeImageSrc(input as string | null | undefined)).toBeUndefined();
  });

  it("passes through a real URL unchanged", () => {
    const url = "https://avatars.githubusercontent.com/u/9771079?v=4";
    expect(sanitizeImageSrc(url)).toBe(url);
  });

  it("passes through a relative path unchanged", () => {
    expect(sanitizeImageSrc("/avatars/123.png")).toBe("/avatars/123.png");
  });

  it("does not trim a valid value (preserves the original string)", () => {
    // Only fully-blank / "#" values are dropped; a non-blank value is returned verbatim.
    expect(sanitizeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
