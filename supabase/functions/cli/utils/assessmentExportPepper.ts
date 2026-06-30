/**
 * Load the deployment pepper for assessment export tokenization.
 *
 * The pepper lives in Supabase vault (`assessment-export-pepper`) and is never
 * sent to the CLI or written into export files. ASSESSMENT_EXPORT_PEPPER env var
 * overrides vault for local tests.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import { CLICommandError } from "../errors.ts";
import { createTokenizer, type Tokenizer } from "./tokenization.ts";

let cachedPepper: string | null = null;

export function resetAssessmentExportPepperCache(): void {
  cachedPepper = null;
}

export async function getAssessmentExportPepper(supabase: SupabaseClient<Database>): Promise<string> {
  if (cachedPepper !== null) return cachedPepper;

  const fromEnv = Deno.env.get("ASSESSMENT_EXPORT_PEPPER");
  if (fromEnv !== undefined && fromEnv.length >= 32) {
    cachedPepper = fromEnv;
    return cachedPepper;
  }

  const { data, error } = await supabase.rpc("get_assessment_export_pepper");
  if (error !== null) {
    throw new CLICommandError(`Failed to load assessment-export-pepper: ${error.message}`, 500);
  }
  if (typeof data !== "string" || data.length < 32) {
    throw new CLICommandError("assessment-export-pepper vault secret is missing or invalid", 500);
  }

  cachedPepper = data;
  return cachedPepper;
}

/** Tokenizer for hash/opaque export modes: client salt + server vault pepper. */
export async function createExportTokenizer(supabase: SupabaseClient<Database>, salt: string): Promise<Tokenizer> {
  const pepper = await getAssessmentExportPepper(supabase);
  return createTokenizer(salt, pepper);
}
