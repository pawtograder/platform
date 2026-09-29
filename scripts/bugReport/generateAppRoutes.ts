/**
 * Writes `lib/bugReport/generated/appRoutes.json`: every app-router page pattern under `app/`, for
 * `recordingLevelFor` to resolve a pathname to the page Next would render before it looks the
 * page up in ROUTE_POLICY. Run it after adding, moving, or removing a page:
 *
 *   npx tsx scripts/bugReport/generateAppRoutes.ts
 *
 * tests/unit/bugReport/routePolicy.test.tsx fails when the committed file is stale.
 *
 * Route groups `(name)` and parallel-route slots `@name` don't appear in the URL, so they're left
 * out of the pattern; private folders `_name` and intercepting routes `(.)name` aren't routes.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export const APP_DIR = path.join(ROOT, "app");
export const APP_ROUTES_JSON = path.join(ROOT, "lib/bugReport/generated/appRoutes.json");
export const APP_ROUTES_HINT = "Regenerate it with: npx tsx scripts/bugReport/generateAppRoutes.ts";

const PAGE_FILES = new Set(["page.tsx", "page.ts", "page.jsx", "page.js"]);

function collect(dir: string, segments: string[], out: Set<string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && PAGE_FILES.has(e.name))) out.add("/" + segments.join("/"));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith("_") || name === "node_modules" || /^\(\.{1,3}\)/.test(name)) continue;
    const invisible = /^\(.*\)$/.test(name) || name.startsWith("@");
    collect(path.join(dir, name), invisible ? segments : [...segments, name], out);
  }
}

/** Every page pattern under `appDir`, sorted, e.g. "/course/[course_id]/gradebook". */
export function collectAppRoutes(appDir: string = APP_DIR): string[] {
  const out = new Set<string>();
  collect(appDir, [], out);
  return [...out].sort();
}

if (require.main === module) {
  fs.writeFileSync(APP_ROUTES_JSON, JSON.stringify(collectAppRoutes(), null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(ROOT, APP_ROUTES_JSON)}`);
}
