/**
 * Normalize an image `src` so that empty / `"#"` / whitespace-only / `null` /
 * `undefined` values become `undefined` instead of reaching the DOM.
 *
 * Rendering `<img src="">` or `<img src="#">` (including a Chakra
 * `<Avatar.Image>` with such a value) inside the tree of an *async server
 * layout* corrupts Next.js's SSR stream and throws
 * `TypeError: controller[kState].transformAlgorithm is not a function` from
 * Node's internal webstreams, which takes down the entire route render (seen on
 * `/course/[course_id]`). Coercing to `undefined` makes the element omit `src`
 * entirely — and lets `Avatar` fall back to initials — which streams safely.
 *
 * See vercel/next.js#75995 and vercel/next.js#68319.
 */
export function sanitizeImageSrc(src: string | null | undefined): string | undefined {
  if (typeof src !== "string") return undefined;
  const trimmed = src.trim();
  if (trimmed === "" || trimmed === "#") return undefined;
  return src;
}
