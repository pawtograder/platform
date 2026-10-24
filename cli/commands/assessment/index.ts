/**
 * Assessment export command group.
 *
 * Exports a privacy-controlled snapshot of class assessment data — rubrics,
 * final grading review scores, autograder test results, hint feedback, and
 * gradebook columns — for downstream analysis.
 *
 * Usage:
 *   pawtograder assessment export -c <class> [--identity opaque|hash|raw] [-o <dir>]
 *   pawtograder assessment deanonymize -c <class> --salt <salt> --i-understand-pii
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
