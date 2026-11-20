/**
 * @jest-environment node
 *
 * ADR 8 (bug reporter spec §4): the bug reporter builds Sentry replay envelopes itself and records
 * with Sentry's rrweb fork, so an SDK or rrweb upgrade can change the upload format under it. Those
 * packages are pinned to exact versions, move together in one Renovate group, and are upgraded
 * only after the release-tier tests pass (.github/workflows/bug-reporter-release.yml). This fails if:
 *   - a direct `@sentry/*` or `@sentry-internal/*` dependency is a range rather than an exact version;
 *   - package-lock.json disagrees with package.json about one of them;
 *   - the lockfile resolves any Sentry SDK package, or any rrweb package, to a second version;
 *   - renovate.json stops grouping, pinning, or labelling them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const renovate = readJson("renovate.json");

const PINNED = /^@sentry(-internal)?\//;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// Sentry's build tooling is versioned on its own line (bundler plugins 4.x, the CLI 2.x).
const TOOLING = /^@sentry\/(cli(-.*)?|bundler-plugin-core|webpack-plugin|babel-plugin-component-annotate)$/;
const RRWEB = /^@sentry-internal\/rr/;

type Deps = Record<string, string>;
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function pinnedDeps(manifest: Partial<Record<(typeof sections)[number], Deps>>): [string, string][] {
  return sections.flatMap((s) => Object.entries(manifest[s] ?? {})).filter(([name]) => PINNED.test(name));
}

/** Every installed copy of a package in the lockfile, keyed by package name. */
function installedVersions(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(lock.packages as Record<string, { version?: string }>)) {
    const name = key.split("node_modules/").pop();
    if (!key || !name || !PINNED.test(name) || !entry.version) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(entry.version);
  }
  return out;
}

describe("ADR 8: Sentry and rrweb versions", () => {
  const direct = pinnedDeps(pkg);

  it("has the packages the bug reporter relies on as direct dependencies", () => {
    const names = direct.map(([n]) => n);
    for (const n of ["@sentry/nextjs", "@sentry/core", "@sentry-internal/rrweb", "@sentry-internal/rrweb-player"]) {
      expect(names).toContain(n);
    }
  });

  it("pins every direct @sentry/* and @sentry-internal/* dependency to an exact version", () => {
    const ranges = direct.filter(([, spec]) => !EXACT.test(spec)).map(([n, spec]) => `${n}@${spec}`);
    expect(ranges).toEqual([]);
  });

  it("has the same spec and installed version in package-lock.json", () => {
    const lockRoot = pinnedDeps(lock.packages[""]);
    expect(Object.fromEntries(lockRoot)).toEqual(Object.fromEntries(direct));
    for (const [name, spec] of direct) {
      expect(`${name}@${lock.packages[`node_modules/${name}`]?.version}`).toBe(`${name}@${spec}`);
    }
  });

  it("resolves every Sentry SDK package to the pinned SDK version, and rrweb to the pinned rrweb", () => {
    const sdk = pkg.dependencies["@sentry/nextjs"];
    const rrweb = pkg.dependencies["@sentry-internal/rrweb"];
    const wrong: string[] = [];
    for (const [name, versions] of installedVersions()) {
      if (TOOLING.test(name)) continue;
      const want = RRWEB.test(name) ? rrweb : sdk;
      for (const v of versions) if (v !== want) wrong.push(`${name}@${v} (want ${want})`);
    }
    expect(wrong).toEqual([]);
    expect(pkg.dependencies["@sentry-internal/rrweb-player"]).toBe(rrweb);
  });

  it("groups them in Renovate, pinned, with the label that starts the release tier", () => {
    const rules = renovate.packageRules as {
      matchPackageNames?: string[];
      enabled?: boolean;
      groupName?: string;
      rangeStrategy?: string;
      labels?: string[];
    }[];
    const group = rules.find((r) => r.enabled !== false && r.groupName);
    expect(group).toBeDefined();
    expect(group!.matchPackageNames).toEqual(expect.arrayContaining(["@sentry/*", "@sentry-internal/*"]));
    expect(group!.rangeStrategy).toBe("pin");
    expect(group!.labels).toContain("bug-reporter-release");
    // A later rule could switch the group back off; Renovate applies rules in order.
    expect(rules.indexOf(group!)).toBe(rules.length - 1);
  });
});
