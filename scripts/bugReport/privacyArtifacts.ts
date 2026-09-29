/**
 * What `npm run client` / `client-local` does for the bug reporter after regenerating the types:
 * writes the runtime maps the select parser needs (the `.d.ts` types do not exist at runtime) and
 * checks that `lib/bugReport/privacy.ts` classifies every column, view field, RPC, and edge-function
 * wrapper. The unit test `tests/unit/bugReport/privacyExhaustive.test.ts` runs the same check in CI.
 */
import fs from "fs";
import path from "path";
import { format, resolveConfig } from "prettier";
import { COLUMNS, EDGE_FUNCTIONS, RPCS } from "../../lib/bugReport/privacy";
import { readEdgeFunctionWrappers, readSchemaFromSource, type SchemaInfo } from "./schemaReader";

const ROOT = path.resolve(__dirname, "../..");
export const RELATIONSHIPS_JSON = path.join(ROOT, "lib/bugReport/generated/relationships.json");
export const EDGE_WRAPPERS_JSON = path.join(ROOT, "lib/bugReport/generated/edgeFunctionWrappers.json");
export const EDGE_FUNCTIONS_TS = path.join(ROOT, "lib/edgeFunctions.ts");

/** Runtime shape of `relationships.json`, read by `lib/bugReport/selectParser.ts`. */
export type RelationshipsJson = Record<
  string,
  { kind: "table" | "view"; fks: { name: string; columns: string[]; ref: string; oneToOne: boolean }[] }
>;

/** Runtime shape of `edgeFunctionWrappers.json`: edge function slug to the wrappers that invoke it. */
export type EdgeWrappersJson = Record<string, string[]>;

export function relationshipsJson(schema: SchemaInfo): RelationshipsJson {
  const out: RelationshipsJson = {};
  for (const name of Object.keys(schema.relations).sort()) {
    const r = schema.relations[name];
    out[name] = {
      kind: r.kind,
      fks: r.relationships.map((fk) => ({
        name: fk.foreignKeyName,
        columns: fk.columns,
        ref: fk.referencedRelation,
        oneToOne: fk.isOneToOne
      }))
    };
  }
  return out;
}

export function edgeWrappersJson(edgeFunctionsSource: string): EdgeWrappersJson {
  const bySlug: EdgeWrappersJson = {};
  for (const [wrapper, target] of Object.entries(readEdgeFunctionWrappers(edgeFunctionsSource))) {
    for (const slug of target.edgeFunctions) (bySlug[slug] ??= []).push(wrapper);
  }
  return Object.fromEntries(
    Object.keys(bySlug)
      .sort()
      .map((slug) => [slug, bySlug[slug].sort()])
  );
}

export async function formatJson(filePath: string, value: unknown): Promise<string> {
  const config = (await resolveConfig(filePath)) ?? {};
  return format(JSON.stringify(value), { ...config, filepath: filePath });
}

export type ExhaustivenessReport = { missing: string[]; stale: string[] };

/** Keys the schema and wrappers have that privacy.ts lacks (missing), and the reverse (stale). */
export function checkExhaustive(schema: SchemaInfo, edgeFunctionsSource: string): ExhaustivenessReport {
  const wantColumns = new Set<string>();
  for (const [relation, info] of Object.entries(schema.relations)) {
    for (const column of Object.keys(info.columns)) wantColumns.add(`${relation}.${column}`);
  }
  const wantRpcs = new Set(Object.keys(schema.functions));
  const wantWrappers = new Set(Object.keys(readEdgeFunctionWrappers(edgeFunctionsSource)));
  const missing: string[] = [];
  const stale: string[] = [];
  const diff = (label: string, want: Set<string>, have: Record<string, unknown>) => {
    for (const k of [...want].sort()) if (!Object.prototype.hasOwnProperty.call(have, k)) missing.push(`${label} ${k}`);
    for (const k of Object.keys(have).sort()) if (!want.has(k)) stale.push(`${label} ${k}`);
  };
  diff("column", wantColumns, COLUMNS);
  diff("rpc", wantRpcs, RPCS);
  diff("edge-function wrapper", wantWrappers, EDGE_FUNCTIONS);
  return { missing, stale };
}

export const GENERATOR_HINT =
  "Run `npx tsx scripts/bugReport/generatePrivacyDraft.ts` to add draft entries for the missing keys, " +
  "review each one (`// DRAFT` / `// UNCERTAIN` comments, see lib/bugReport/PRIVACY_REVIEW.md), then rerun `npm run client-local`.";

/**
 * Called by `scripts/PostprocessSupabaseTypes.ts` with the processed types source. Writes the runtime
 * maps and returns an error message when privacy.ts is not exhaustive, or null when it is.
 */
export async function runBugReportPostprocess(typesSource: string): Promise<string | null> {
  const schema = readSchemaFromSource(typesSource);
  const edgeSource = fs.readFileSync(EDGE_FUNCTIONS_TS, "utf8");
  fs.mkdirSync(path.dirname(RELATIONSHIPS_JSON), { recursive: true });
  fs.writeFileSync(RELATIONSHIPS_JSON, await formatJson(RELATIONSHIPS_JSON, relationshipsJson(schema)), "utf8");
  fs.writeFileSync(EDGE_WRAPPERS_JSON, await formatJson(EDGE_WRAPPERS_JSON, edgeWrappersJson(edgeSource)), "utf8");
  const { missing, stale } = checkExhaustive(schema, edgeSource);
  if (stale.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `lib/bugReport/privacy.ts has ${stale.length} entries for keys that no longer exist (the generator drops them):\n  ${stale.join("\n  ")}`
    );
  }
  if (missing.length === 0) return null;
  return (
    `lib/bugReport/privacy.ts has no privacy classification for ${missing.length} key(s):\n  ${missing.join("\n  ")}\n` +
    GENERATOR_HINT
  );
}
