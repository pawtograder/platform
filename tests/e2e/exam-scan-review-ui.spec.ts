import { expect, test, type Page } from "@playwright/test";
import { batchStatus, processToReview, runExamWorker, seedUploadedBatch } from "./examScanFixture";
import { loginAsUser, supabase } from "./TestingUtils";

// The Scan & Match page as an instructor uses it. exam-grading.spec.ts drives the same pipeline
// through RPCs; these tests click the page and check what it shows while the worker runs.

/** The review table's row for exam #n (exams are numbered in page order: Alice #1, Bob #2). Rows are
 * found by their exam cell because every row's student picker lists every name. */
function examRow(page: Page, n: number) {
  return page.locator("tr").filter({ has: page.getByRole("cell", { name: `#${n}`, exact: true }) });
}

/** Counts full page loads from here on, so a test can show the page updated without a reload. */
function countLoads(page: Page) {
  const loads = { n: 0 };
  page.on("load", () => loads.n++);
  return loads;
}

test.describe("Scan & Match progress and refresh (#1262)", () => {
  test("a batch that is reading pages or matching says so and moves on without a reload", async ({ page }) => {
    test.setTimeout(150_000);
    const { course, instructor, alice, assignment, batchId } = await seedUploadedBatch("progress");

    // Put the batch mid-OCR by hand (one of three pages read), so the in-progress state holds still
    // long enough to look at instead of racing the worker.
    expect((await supabase.from("exam_scan_batches").update({ status: "ocr" }).eq("id", batchId)).error).toBeNull();
    const { data: firstPage } = await supabase
      .from("exam_scan_pages")
      .select("id")
      .eq("batch_id", batchId)
      .eq("page_index", 0)
      .single();
    const { error: readErr } = await supabase
      .from("exam_scan_pages")
      .update({ ocr_text: "", ocr_data: { words: [] } })
      .eq("id", firstPage!.id);
    expect(readErr).toBeNull();

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    const loads = countLoads(page);
    const status = page.getByRole("status").filter({ hasText: "Reading pages" });
    await expect(status).toContainText("1 of 3");
    await expect(page.getByRole("button", { name: "Process (OCR + match)" })).toHaveCount(0);

    expect(
      (await supabase.from("exam_scan_batches").update({ status: "matching" }).eq("id", batchId)).error
    ).toBeNull();
    await expect(page.getByRole("status").filter({ hasText: "Matching names" })).toBeVisible({ timeout: 15_000 });

    // Now let the real worker finish: the review table appears on its own.
    // Undo the hand-made OCR so the worker really reads page 0 (and finds Alice on it).
    expect(
      (await supabase.from("exam_scan_pages").update({ ocr_text: null, ocr_data: null }).eq("id", firstPage!.id)).error
    ).toBeNull();
    await processToReview(batchId);
    await expect(page.getByRole("heading", { name: "Review matches (3 exams)" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Needs review").filter({ visible: true })).toBeVisible();
    const { data: first } = await supabase
      .from("exam_scanned_submissions")
      .select("matched_profile_id")
      .eq("batch_id", batchId)
      .eq("exam_index", 0)
      .single();
    expect(first?.matched_profile_id).toBe(alice.private_profile_id);
    expect(loads.n).toBe(0);
  });

  test("while submissions are being created, nothing on the review table can be changed", async ({ page }) => {
    test.setTimeout(150_000);
    const { course, instructor, assignment, batchId } = await seedUploadedBatch("frozen");
    await processToReview(batchId);
    const { error: confirmErr } = await supabase
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .not("matched_profile_id", "is", null);
    expect(confirmErr).toBeNull();
    // 'finalizing' with no queued work: the state holds still. The database already refuses match
    // edits now (exam_scanned_submission_freeze_match); the page must not offer them.
    expect(
      (await supabase.from("exam_scan_batches").update({ status: "finalizing" }).eq("id", batchId)).error
    ).toBeNull();

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    await expect(page.getByRole("status").filter({ hasText: "Creating submissions" })).toContainText("0 of 2");
    await expect(page.getByRole("button", { name: /Create \d+ submission/ })).toBeDisabled();
    for (const button of await page.getByRole("button", { name: "Confirm" }).all()) await expect(button).toBeDisabled();
    for (const button of await page.getByRole("button", { name: "Skip" }).all()) await expect(button).toBeDisabled();
    for (const select of await page.getByRole("combobox").all()) await expect(select).toBeDisabled();
  });

  test("Create submissions refreshes the rows and the batch until it is completed, without a reload", async ({
    page
  }) => {
    test.setTimeout(180_000);
    const { course, instructor, assignment, batchId } = await seedUploadedBatch("finalize");
    await processToReview(batchId);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    const loads = countLoads(page);
    for (const n of [1, 2]) {
      const row = examRow(page, n);
      await row.getByRole("button", { name: "Confirm" }).click();
      await expect(row.getByText("confirmed")).toBeVisible();
    }

    // The controls while finalizing are covered by the test above, where that state holds still.
    await page.getByRole("button", { name: "Create 2 submission(s)" }).click();

    // Drive the worker from here; the page only polls. Rows first: "created" exists before this fix
    // too, so this checks the refresh, not new wording.
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return batchStatus(batchId);
        },
        { timeout: 90_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");
    for (const n of [1, 2]) {
      await expect(examRow(page, n).getByText("created")).toBeVisible({
        timeout: 15_000
      });
    }
    await expect(page.getByText("Submissions created").filter({ visible: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Create 0 submission(s)" })).toBeDisabled();
    expect(loads.n).toBe(0);
  });
});
