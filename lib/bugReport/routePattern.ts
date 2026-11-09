/**
 * Turns a concrete pathname back into its Next.js app-router pattern, so bug reports carry
 * `/course/[course_id]/assignments/[assignment_id]` rather than `/course/12/assignments/345`.
 *
 * `params` is what `useParams()` returns for the current route. Each segment equal to a
 * param value is replaced by `[name]`; a catch-all param (array value) collapses its run
 * of segments into `[...name]`. Segments are matched left to right and each param is used
 * once, so a static segment that happens to equal an earlier param value is left alone.
 * Route groups such as `(auth-pages)` never appear in a pathname, so they don't appear
 * in the pattern either.
 */
export function routePatternFor(
  pathname: string,
  params: Record<string, string | string[] | undefined> | null | undefined
): string {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (!params || segments.length === 0) {
    return "/" + segments.join("/");
  }

  const single = new Map<string, string>();
  const catchAll: { name: string; values: string[] }[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      if (value.length > 0) catchAll.push({ name, values: value.map(safeDecode) });
    } else if (typeof value === "string" && value.length > 0) {
      single.set(name, safeDecode(value));
    }
  }

  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = safeDecode(segments[i]);

    const ca = catchAll.find(
      (c) =>
        !used.has(c.name) &&
        c.values.length <= segments.length - i &&
        c.values.every((v, j) => v === safeDecode(segments[i + j]))
    );
    if (ca) {
      used.add(ca.name);
      out.push(`[...${ca.name}]`);
      i += ca.values.length - 1;
      continue;
    }

    let matched: string | undefined;
    for (const [name, value] of single) {
      if (!used.has(name) && value === seg) {
        matched = name;
        break;
      }
    }
    if (matched) {
      used.add(matched);
      out.push(`[${matched}]`);
    } else {
      out.push(segments[i]);
    }
  }
  return "/" + out.join("/");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
