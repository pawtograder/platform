import { readdirSync } from "fs";
import { join } from "path";

// The migration runner (charts/pawtograder/images/migrations/migrate.sh) keys
// supabase_migrations.schema_migrations on the numeric prefix alone, so two files that share a
// prefix are one migration as far as the database is concerned. The second one is skipped
// silently on a fresh database, and every later run of the runner reads that row's hash against
// the wrong file and refuses to proceed as drift, which blocks the deploy rather than the merge.
//
// 20260910010000 arrived twice on 2026-09-10, from two PRs that were each green on their own.
// Staging applied one, skipped the other, and its next migration job failed. This test is where
// that collision gets caught instead.
describe("supabase migrations", () => {
  const migrationsDir = join(__dirname, "..", "..", "supabase", "migrations");
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));

  it("has migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("names every file <version>_<name>.sql", () => {
    const malformed = files.filter((name) => !/^\d{14}_.+\.sql$/.test(name));
    expect(malformed).toEqual([]);
  });

  it("gives every migration its own version", () => {
    const byVersion = new Map<string, string[]>();
    for (const name of files) {
      const version = name.split("_")[0];
      byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
    }

    const collisions = [...byVersion.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([version, names]) => `${version}: ${names.join(", ")}`);
    expect(collisions).toEqual([]);
  });
});
