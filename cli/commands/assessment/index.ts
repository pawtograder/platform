/**
 * Assessment export command group.
 *
 * Exports a privacy-controlled snapshot of class assessment data — rubrics,
 * final grading review scores, autograder test results, hint feedback, and
 * gradebook columns — for downstream analysis.
 *
 * Currently implements the "preamble" thin slice: manifest + students +
 * sections only. Per-assignment fact streams (rubric/scores/tests/hints) and
 * gradebook are added in subsequent phases.
 */

import type { Argv } from "yargs";
import { exportHandler, exportBuilder } from "./export";
import { deanonymizeHandler, deanonymizeBuilder } from "./deanonymize";

export const command = "assessment <action>";
export const describe = "Export class assessment data (rubrics, scores, tests, hints, gradebook)";

export const builder = (yargs: Argv) => {
  return yargs
    .command("export", "Export assessment data for a class", exportBuilder, exportHandler)
    .command(
      "deanonymize",
      "Export a CSV mapping subject tokens to student identifiers (name, email, SIS id, sections)",
      deanonymizeBuilder,
      deanonymizeHandler
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
