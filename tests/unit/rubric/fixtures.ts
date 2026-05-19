import fs from "fs";
import path from "path";
import { YmlRubricType } from "@/utils/supabase/DatabaseTypes";

const FIXTURE_DIR = path.join(__dirname, "fixtures");

/**
 * Load a fixture snapshot from rubrics.csv (`rubric_structure` JSON shape).
 *
 * The CSV snapshots use YAML-style nested keys (`parts/criteria/checks`) and carry
 * extra fields like `ordinal` that the YAML schema doesn't model. We coerce to
 * `YmlRubricType` so the round-trip tests can exercise the parse/serialize pair on
 * real production data.
 */
export function loadFixtureAsYaml(name: string): YmlRubricType {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf-8")) as Record<string, unknown>;
  return {
    name: raw.name as string,
    description: (raw.description as string | undefined) ?? undefined,
    parts: (raw.parts as YmlRubricType["parts"]) ?? [],
    cap_score_to_assignment_points: (raw.cap_score_to_assignment_points as boolean | undefined) ?? undefined
  };
}

export const FIXTURE_NAMES = [
  "multi_option_check",
  "deduction_only",
  "met_partial",
  "individual_grading",
  "assign_to_student"
] as const;
