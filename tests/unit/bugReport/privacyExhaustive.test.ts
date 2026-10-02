/**
 * @jest-environment node
 */
import fs from "fs";
import path from "path";
import { COLUMNS, EDGE_FUNCTIONS, RPCS } from "@/lib/bugReport/privacy";
import { isPiiKind, isTableRef, parseJsonPath } from "@/lib/bugReport/privacyTypes";
import relationshipsFile from "@/lib/bugReport/generated/relationships.json";
import edgeWrappersFile from "@/lib/bugReport/generated/edgeFunctionWrappers.json";
import {
  checkExhaustive,
  edgeWrappersJson,
  GENERATOR_HINT,
  relationshipsJson
} from "@/scripts/bugReport/privacyArtifacts";
import { readSchema } from "@/scripts/bugReport/schemaReader";

const ROOT = path.resolve(__dirname, "../../..");
const schema = readSchema(path.join(ROOT, "utils/supabase/SupabaseTypes.d.ts"));
const edgeSource = fs.readFileSync(path.join(ROOT, "lib/edgeFunctions.ts"), "utf8");

describe("lib/bugReport/privacy.ts", () => {
  it("classifies every column, view field, RPC, and edge-function wrapper", () => {
    const { missing, stale } = checkExhaustive(schema, edgeSource);
    if (missing.length > 0)
      throw new Error(`missing privacy classification:\n  ${missing.join("\n  ")}\n${GENERATOR_HINT}`);
    expect(stale).toEqual([]);
  });

  it("uses only valid kinds, JSONPaths, and table references", () => {
    const errors: string[] = [];
    for (const [k, v] of Object.entries(COLUMNS)) if (!isPiiKind(v)) errors.push(`COLUMNS ${k}`);
    const checkMap = (label: string, map: Record<string, unknown>) => {
      if (Object.keys(map).length === 0) errors.push(`${label}: empty map`);
      for (const [p, v] of Object.entries(map)) {
        try {
          parseJsonPath(p);
        } catch {
          errors.push(`${label}: bad path ${p}`);
        }
        if (isTableRef(v) ? !schema.relations[v.$table] : !isPiiKind(v)) errors.push(`${label}: bad value at ${p}`);
      }
    };
    for (const [k, v] of Object.entries(RPCS)) {
      if (isPiiKind(v)) continue;
      if (isTableRef(v)) {
        if (!schema.relations[v.$table]) errors.push(`RPCS ${k}: unknown table ${v.$table}`);
      } else checkMap(`RPCS ${k}`, v);
    }
    for (const [k, v] of Object.entries(EDGE_FUNCTIONS)) checkMap(`EDGE_FUNCTIONS ${k}`, v);
    expect(errors).toEqual([]);
  });

  it("classifies the PII columns named in docs/operations/data-retention.md", () => {
    expect(COLUMNS["profiles.name"]).toBe("name");
    expect(COLUMNS["profiles.sortable_name"]).toBe("name");
    expect(COLUMNS["profiles.avatar_url"]).toBe("handle");
    expect(COLUMNS["users.github_username"]).toBe("handle");
    expect(COLUMNS["user_roles.canvas_id"]).toBe("handle");
    expect(COLUMNS["gradebook_column_students.score"]).toBe("grade");
    expect(COLUMNS["gradebook_column_students.score_override"]).toBe("grade");
    expect(COLUMNS["grader_results.score"]).toBe("grade");
    expect(COLUMNS["submission_reviews.total_score"]).toBe("grade");
    expect(COLUMNS["discussion_threads.body"]).toBe("free_text");
    expect(COLUMNS["help_request_messages.message"]).toBe("free_text");
    expect(COLUMNS["emails.body"]).toBe("free_text");
    expect(COLUMNS["notifications.body"]).toBe("free_text");
    expect(COLUMNS["audit.ip_addr"]).toBe("handle");
    expect(COLUMNS["audit.old"]).toBe("free_text");
    expect(COLUMNS["audit.new"]).toBe("free_text");
  });
});

describe("lib/bugReport/generated", () => {
  it("relationships.json matches the generated types (rerun npm run client-local)", () => {
    expect(relationshipsFile).toEqual(relationshipsJson(schema));
  });
  it("edgeFunctionWrappers.json matches lib/edgeFunctions.ts (rerun npm run client-local)", () => {
    expect(edgeWrappersFile).toEqual(edgeWrappersJson(edgeSource));
  });
});
