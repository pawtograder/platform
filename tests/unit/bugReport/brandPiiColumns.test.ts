/**
 * @jest-environment node
 */
import fs from "fs";
import path from "path";
import { COLUMNS } from "@/lib/bugReport/privacy";
import type { PiiKind } from "@/lib/bugReport/privacyTypes";
import { brandPiiColumns } from "@/scripts/bugReport/brandPiiColumns";
import { readSchemaFromSource } from "@/scripts/bugReport/schemaReader";

const ROOT = path.resolve(__dirname, "../../..");

const SOURCE = `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          name: string | null;
          bio: Json;
          score: number;
          status: Database["public"]["Enums"]["status"] | "x" | null;
        };
        Insert: {
          id?: string;
          name?: string | null;
        };
        Update: {
          name?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      profile_view: {
        Row: {
          name: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {};
    Enums: { status: "a" | "b" };
    CompositeTypes: {};
  };
};
`;

const KINDS: Record<string, PiiKind> = {
  "profiles.id": "none",
  "profiles.name": "name",
  "profiles.bio": "free_text",
  "profiles.score": "grade",
  "profiles.status": "free_text",
  "profile_view.name": "name"
};

describe("brandPiiColumns", () => {
  const { source, branded } = brandPiiColumns(SOURCE, (k) => KINDS[k]);

  it("brands classified Row columns of tables and views, keeping null outside the brand", () => {
    expect(branded).toBe(5);
    expect(source).toContain(`name: Pii<"name", string> | null;`);
    expect(source).toContain(`bio: Pii<"free_text", Json>;`);
    expect(source).toContain(`score: Pii<"grade", number>;`);
    expect(source).toContain(`status: Pii<"free_text", Database["public"]["Enums"]["status"] | "x"> | null;`);
    expect(source).toContain(`id: string;`);
    expect(source).toMatch(/export type Pii<K extends "name" \| "email" \| "handle" \| "grade" \| "free_text", T>/);
  });

  it("leaves Insert and Update unbranded", () => {
    expect(source).toContain(`Insert: {\n          id?: string;\n          name?: string | null;`);
    expect(source).toContain(`Update: {\n          name?: string | null;`);
  });

  it("is idempotent", () => {
    const again = brandPiiColumns(source, (k) => KINDS[k]);
    expect(again.branded).toBe(0);
    expect(again.source).toBe(source);
  });

  it("does not change what the schema reader sees", () => {
    expect(readSchemaFromSource(source).relations).toEqual(readSchemaFromSource(SOURCE).relations);
  });

  it("has been applied to the committed generated types (run `npm run client-local`)", () => {
    for (const file of ["utils/supabase/SupabaseTypes.d.ts", "supabase/functions/_shared/SupabaseTypes.d.ts"]) {
      const committed = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect({ file, unbranded: brandPiiColumns(committed, (k) => COLUMNS[k]).branded }).toEqual({
        file,
        unbranded: 0
      });
    }
  });
});
