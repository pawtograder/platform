/**
 * Maps a concrete pathname to its Next.js app-router pattern ("/course/12/gradebook" →
 * "/course/[course_id]/gradebook"), so trace output is keyed by page, not by seeded ids.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

type Pattern = { pattern: string; segments: string[] };

let cached: Pattern[] | null = null;

function collect(dir: string, segments: string[], out: Pattern[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.includes("page.tsx") || entries.includes("page.ts") || entries.includes("route.ts")) {
    out.push({ pattern: "/" + segments.join("/"), segments: [...segments] });
  }
  for (const name of entries) {
    if (name.startsWith("_") || name.startsWith("@") || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    // Route groups "(name)" don't appear in the URL.
    collect(full, /^\(.*\)$/.test(name) ? segments : [...segments, name], out);
  }
}

function patterns(): Pattern[] {
  if (!cached) {
    cached = [];
    collect(path.join(process.cwd(), "app"), [], cached);
  }
  return cached;
}

function score(p: Pattern, parts: string[]): number | null {
  let s = 0;
  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i];
    if (/^\[\[?\.\.\..+\]\]?$/.test(seg)) return s + 1; // catch-all: matches the rest
    if (i >= parts.length) return null;
    if (/^\[.+\]$/.test(seg)) s += 10;
    else if (seg === parts[i]) s += 100;
    else return null;
  }
  return p.segments.length === parts.length ? s : null;
}

/** The most specific app route matching `pathname`, or the pathname with numeric ids replaced. */
export function routePatternFor(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const parts = clean === "/" ? [] : clean.slice(1).split("/");
  let best: { pattern: string; score: number } | null = null;
  for (const p of patterns()) {
    const s = score(p, parts);
    if (s !== null && (!best || s > best.score)) best = { pattern: p.pattern, score: s };
  }
  if (best) return best.pattern === "/" ? "/" : best.pattern;
  return clean.replace(/\/\d+(?=\/|$)/g, "/[id]");
}
