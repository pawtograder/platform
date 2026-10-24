/**
 * Seeded-defect injector registry for the a11y-judge kit.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types and node builtins.
 *
 * Each `Mutation` plants exactly ONE known WCAG failure on the driver pages via
 * `page.addInitScript` (registered before navigation so the perturbation is
 * deterministic and present from first paint). Injectors are idempotent and
 * resilient to React re-renders (observer- or interval-based where the target
 * content mounts dynamically). Wave 3 wires this into the evidence driver keyed
 * by the `A11Y_MUTATION` env var; the judge is expected to catch each defect.
 */
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import type { Mutation } from "./types";
import mutation111 from "./111-alt-degrade";
import mutation131 from "./131-spoken-value-collapse";
import mutation132 from "./132-survey-options-first";
import mutation243 from "./243-tabindex-shuffle";
import mutation246 from "./246-headings-generic";
import mutation247 from "./247-outline-none";
import mutation331 from "./331-hide-error-text";
import mutation412 from "./412-strip-labels";
import mutation413 from "./413-silent-toast";

export type { Mutation } from "./types";

/** Environment variable read by {@link applyMutationFromEnv}. */
export const MUTATION_ENV_VAR = "A11Y_MUTATION";

/** All registered seeded-defect injectors. */
export const MUTATIONS: Mutation[] = [
  mutation111,
  mutation131,
  mutation132,
  mutation243,
  mutation246,
  mutation247,
  mutation331,
  mutation412,
  mutation413
];

/** Look up a mutation by its stable id, or `undefined` if none matches. */
export function getMutation(id: string): Mutation | undefined {
  return MUTATIONS.find((mutation) => mutation.id === id);
}

/**
 * Read `process.env.A11Y_MUTATION` and, if set, apply the matching mutation to
 * `page`. Returns the applied mutation, or `null` when the env var is unset
 * (a clean run). Throws if the env var names an unknown mutation id, so a typo
 * never silently produces a mislabeled "clean" collection.
 */
export async function applyMutationFromEnv(page: Page): Promise<Mutation | null> {
  const id = process.env[MUTATION_ENV_VAR];
  if (!id || id.trim() === "") return null;
  const mutation = getMutation(id.trim());
  if (!mutation) {
    throw new Error(`Unknown ${MUTATION_ENV_VAR}="${id}". Known ids: ${MUTATIONS.map((m) => m.id).join(", ")}`);
  }
  await mutation.apply(page);
  return mutation;
}

/** Ground-truth sidecar shape written next to a collected evidence bundle. */
export type GroundTruth = { mutationId: string; criterion: string; expected: "fail" } | { clean: true };

/**
 * Write `groundTruth.json` into `outDir` recording whether the collection ran
 * clean or with a planted defect. This is the label the mutation gauntlet
 * compares judge verdicts against.
 */
export function writeGroundTruthSidecar(outDir: string, mutation: Mutation | null): void {
  fs.mkdirSync(outDir, { recursive: true });
  const groundTruth: GroundTruth = mutation
    ? { mutationId: mutation.id, criterion: mutation.criterion, expected: mutation.expected }
    : { clean: true };
  fs.writeFileSync(path.join(outDir, "groundTruth.json"), JSON.stringify(groundTruth, null, 2));
}
