/**
 * public.audit is partitioned, and audit_maintain_partitions() creates a new partition every
 * day. CREATE TABLE ... PARTITION OF takes Supabase's default privileges rather than the
 * parent's, so each new partition arrives with INSERT/UPDATE/DELETE/TRUNCATE granted to anon
 * and authenticated. RLS covers the DML, but TRUNCATE is not subject to RLS at all -- it is
 * authorized by grant alone. A one-time REVOKE therefore decays within a day unless the
 * maintenance function revokes on every partition it creates.
 *
 * This is a static guard on the migration text, in the same style as
 * karma-trigger-migrations.test.ts: the failure it prevents is someone rewriting
 * audit_maintain_partitions() in a later migration and dropping the REVOKE, which nothing
 * else would catch until an audit trail got truncated.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "../../supabase/migrations");
const FUNCTION_NAME = "audit_maintain_partitions";

/** The newest migration that (re)defines the function, mirroring how Postgres resolves it. */
function latestDefinition(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const needle = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${FUNCTION_NAME}\\s*\\(`, "i");
  const file = files.filter((f) => needle.test(readFileSync(join(MIGRATIONS_DIR, f), "utf8"))).pop();
  if (!file) {
    throw new Error(`No migration defines public.${FUNCTION_NAME}`);
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const start = [...sql.matchAll(new RegExp(needle, "gi"))].pop()!.index!;
  return { file, body: sql.slice(start) };
}

/** Strip `--` line comments so a commented-out statement cannot satisfy an assertion. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("audit partition grants", () => {
  it("revokes client write privileges on every partition it creates", () => {
    const { body } = latestDefinition();
    const code = stripComments(body);

    // The REVOKE must be inside the branch that just created a partition, not merely present
    // somewhere in the file, or partitions created on later days keep the grants.
    const createIdx = code.indexOf("PARTITION OF public.audit");
    expect(createIdx).toBeGreaterThan(-1);
    const afterCreate = code.slice(createIdx);
    const revokeIdx = afterCreate.search(/REVOKE[^;]*TRUNCATE[^;]*FROM[^;]*anon[^;]*;/i);
    expect(revokeIdx).toBeGreaterThan(-1);

    const revoke = afterCreate.slice(revokeIdx, afterCreate.indexOf(";", revokeIdx) + 1);
    expect(revoke).toMatch(/authenticated/i);
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(revoke.toUpperCase()).toContain(privilege);
    }
    // It has to run in the same loop iteration as the CREATE, i.e. before the loop closes.
    expect(revokeIdx).toBeLessThan(afterCreate.indexOf("END LOOP"));
  });

  it("still enables row level security on new partitions", () => {
    const code = stripComments(latestDefinition().body);
    expect(code).toMatch(/ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/i);
  });
});
