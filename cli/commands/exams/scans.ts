/**
 * exams scans — the Scans page steps: upload, process, status, finalize.
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError, CLIError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable } from "@/cli/utils/output";
import { openPdf, rasterizePages } from "@/cli/utils/pdfRasterize";

function batchOptions(y: Argv) {
  return y
    .option("class", { alias: "c", describe: "Class ID, slug, or name", type: "string", demandOption: true })
    .option("batch", { alias: "b", describe: "Scan batch ID", type: "number", demandOption: true });
}

async function uploadScans(args: {
  class: string;
  assignment: string;
  file: string;
  pagesPerExam: number;
}): Promise<void> {
  if (!fs.existsSync(args.file)) throw new CLIError(`File not found: ${args.file}`);
  const file = fs.readFileSync(args.file);
  // pdfjs refuses a Buffer, so pass a view of the same bytes rather than a copy.
  const doc = await openPdf(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
  try {
    // Created before rasterizing, so a pages-per-exam that doesn't match the template is refused
    // before any page is uploaded.
    const created = await apiCall("exams.scans.create_batch", {
      class: args.class,
      assignment: args.assignment,
      pages_per_exam: args.pagesPerExam,
      total_pages: doc.numPages
    });
    const batchId = created.batch_id as number;
    logger.step(`Uploading ${doc.numPages} page(s) to batch ${batchId}`);

    try {
      for await (const page of rasterizePages(doc)) {
        await apiCall("exams.scans.upload_page", {
          class: args.class,
          batch: batchId,
          page_index: page.pageIndex,
          content_base64: page.png.toString("base64")
        });
        logger.progress(page.pageIndex + 1, doc.numPages, `${page.width}x${page.height}`);
      }
    } catch (error) {
      logger.error(`Batch ${batchId} is incomplete and cannot be processed. Upload the PDF again as a new batch.`);
      throw error;
    }

    logger.success(`Uploaded ${doc.numPages} page(s) as batch ${batchId}`);
    logger.info(`Next: pawtograder exams scans process -c ${args.class} --batch ${batchId}`);
  } finally {
    await doc.destroy();
  }
}

export function buildScansCommands(yargs: Argv): Argv {
  return yargs
    .command(
      "upload",
      "Rasterize a scanned PDF and upload it as a new batch",
      (y) =>
        y
          .option("class", { alias: "c", describe: "Class ID, slug, or name", type: "string", demandOption: true })
          .option("assignment", { alias: "a", describe: "Assignment ID or slug", type: "string", demandOption: true })
          .option("file", { alias: "f", describe: "Scanned PDF", type: "string", demandOption: true })
          .option("pages-per-exam", {
            describe: "Pages in each student's exam; must match the template",
            type: "number",
            demandOption: true
          }),
      async (args) => {
        try {
          await uploadScans({
            class: args.class as string,
            assignment: args.assignment as string,
            file: args.file as string,
            pagesPerExam: args.pagesPerExam as number
          });
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "process",
      "Start OCR and name matching for an uploaded batch",
      (y) => addJsonOption(batchOptions(y)),
      async (args) => {
        try {
          const data = await apiCall("exams.scans.process", {
            class: args.class as string,
            batch: args.batch as number
          });
          if (emitJson(args, data)) return;
          logger.success(`Processing started for batch ${data.batch_id} (${data.pages_enqueued} page(s))`);
          logger.info(`Check progress: pawtograder exams scans status -c ${args.class} --batch ${data.batch_id}`);
          logger.info("Confirm the matches on the exam's Scans page, then run exams scans finalize.");
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "finalize",
      "Create submissions for the batch's confirmed exams",
      (y) =>
        addJsonOption(batchOptions(y)).option("dry-run", {
          describe: "List which pages become which student's submission, without creating anything",
          type: "boolean",
          default: false
        }),
      async (args) => {
        try {
          const data = await apiCall("exams.scans.finalize", {
            class: args.class as string,
            batch: args.batch as number,
            dry_run: args.dryRun === true
          });
          if (emitJson(args, data)) return;
          if (!data.dry_run) {
            logger.success(`Creating ${data.enqueued} submission(s) for batch ${data.batch_id}`);
            logger.info(`Check progress: pawtograder exams scans status -c ${args.class} --batch ${data.batch_id}`);
            return;
          }
          logger.step(`Finalize plan for batch ${data.batch_id} (dry run)`);
          printTable(
            ["Exam", "Action", "Match", "Student", "Pages"],
            data.plan.map((row: Record<string, unknown>) => [
              (row.exam_index as number) + 1,
              row.action as string,
              row.match_status as string,
              (row.student_name as string | null) ?? (row.profile_id as string | null),
              (row.page_indexes as number[]).join(", ")
            ])
          );
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "status",
      "Show a batch's state and how many exams are matched",
      (y) => addJsonOption(batchOptions(y)),
      async (args) => {
        try {
          const data = await apiCall("exams.scans.status", {
            class: args.class as string,
            batch: args.batch as number
          });
          if (emitJson(args, data)) return;

          const s = data.summary;
          logger.step(`Batch ${data.batch.id} (exam ${data.batch.exam_id})`);
          logger.info(`Status: ${s.status}${s.error ? ` (${s.error})` : ""}`);
          logger.info(`Pages: ${s.pages_uploaded} of ${s.total_pages} uploaded, ${s.pages_per_exam} per exam`);
          if (!s.upload_complete) logger.warning("The upload is incomplete; processing will refuse this batch.");
          logger.info(
            `Scanned exams: ${s.scanned_exams} (confirmed ${s.matches.confirmed}, suggested ${s.matches.suggested}, ` +
              `unmatched ${s.matches.unmatched}, skipped ${s.matches.skipped})`
          );
          logger.info(`Submissions created: ${s.submissions_created}`);
        } catch (error) {
          handleError(error);
        }
      }
    );
}
