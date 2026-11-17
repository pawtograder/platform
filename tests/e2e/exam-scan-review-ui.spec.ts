import { expect, test, type Page } from "@playwright/test";
import { batchStatus, processToReview, runExamWorker, seedUploadedBatch } from "./examScanFixture";
import { createAuthenticatedClient, createClass, createUserInClass, loginAsUser, supabase } from "./TestingUtils";

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

async function scannedRow(batchId: number, examIndex: number) {
  const { data } = await supabase
    .from("exam_scanned_submissions")
    .select("id, matched_profile_id, match_status, match_confidence")
    .eq("batch_id", batchId)
    .eq("exam_index", examIndex)
    .single();
  return data!;
}

test.describe("Confirming a student the scan does not name (#1265)", () => {
  test("a hand-picked student with a different name needs an acknowledgment, and Cancel keeps nothing", async ({
    page
  }) => {
    test.setTimeout(150_000);
    const { course, instructor, extras, assignment, batchId } = await seedUploadedBatch("wrong student", {
      sheets: [{ sis: "unknown", name: "ALPHA_TESTER" }],
      extraStudents: ["Clark Johnson"]
    });
    const [clark] = extras;
    await processToReview(batchId);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    const row = examRow(page, 1);
    await row.getByRole("combobox").selectOption({ label: "Clark Johnson" });
    await expect(row.getByText("Scan: “ALPHA TESTER” · Selected: “Clark Johnson”")).toBeVisible();
    // The worker's score was for no one in particular; it must not be shown as Clark's.
    await expect.poll(async () => (await scannedRow(batchId, 0)).matched_profile_id).toBe(clark.private_profile_id);
    expect(await scannedRow(batchId, 0)).toMatchObject({ match_status: "suggested", match_confidence: null });

    await row.getByRole("button", { name: "Confirm" }).click();
    const prompt = row.getByRole("alert");
    await expect(prompt).toContainText("The scan says “ALPHA TESTER”, not “Clark Johnson”");
    // Focus lands on Cancel, so a second Enter on Confirm cannot accept the warning.
    await expect(prompt.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Confirm" })).toBeFocused();
    expect((await scannedRow(batchId, 0)).match_status).toBe("suggested");
    await page.reload();
    expect((await scannedRow(batchId, 0)).match_status).toBe("suggested");

    // Acknowledged deliberately: move to "Confirm anyway" and press Enter. (Focused directly: WebKit's
    // default Tab order skips buttons.)
    await examRow(page, 1).getByRole("button", { name: "Confirm" }).click();
    await expect(examRow(page, 1).getByRole("button", { name: "Cancel" })).toBeFocused();
    await examRow(page, 1).getByRole("button", { name: "Confirm anyway" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await scannedRow(batchId, 0)).match_status).toBe("confirmed");
    expect((await scannedRow(batchId, 0)).matched_profile_id).toBe(clark.private_profile_id);
  });

  test("the same name confirms in one click; a SIS-only match with another name still asks", async ({ page }) => {
    test.setTimeout(150_000);
    const { course, instructor, bob, assignment, batchId } = await seedUploadedBatch("sis only", {
      sheets: [
        // Order and case differ from "Alice Smith", so the worker (exact compare) relies on the SIS id.
        // The fake provider only reads [A-Za-z0-9 _-] from the path, so no comma here.
        { sis: "alice", name: "SMITH_alice" },
        { sis: "bob", name: "Robert_J" }
      ]
    });
    await processToReview(batchId);
    // The worker matched Bob from his SIS id alone (the written name matches nobody).
    expect(await scannedRow(batchId, 1)).toMatchObject({
      matched_profile_id: bob.private_profile_id,
      match_status: "suggested",
      match_confidence: 0.9
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    await examRow(page, 1).getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await scannedRow(batchId, 0)).match_status).toBe("confirmed");
    await expect(examRow(page, 1).getByRole("alert")).toHaveCount(0);

    const bobRow = examRow(page, 2);
    await expect(bobRow.getByText("Scan: “Robert J” · Selected: “Bob Jones” · SIS matched")).toBeVisible();
    await bobRow.getByRole("button", { name: "Confirm" }).click();
    await expect(bobRow.getByRole("alert")).toContainText("The scan says “Robert J”, not “Bob Jones”");
    expect((await scannedRow(batchId, 1)).match_status).toBe("suggested");
  });

  test("a name two roster students share still needs an acknowledgment", async ({ page }) => {
    test.setTimeout(150_000);
    const { course, instructor, alice, assignment, batchId } = await seedUploadedBatch("same name", {
      sheets: [{ sis: "alice", name: "Alice_Smith" }],
      extraStudents: ["Alice Smith"]
    });
    await processToReview(batchId);
    // The written name fits both Alices, so only the SIS id picked this one.
    expect(await scannedRow(batchId, 0)).toMatchObject({ matched_profile_id: alice.private_profile_id });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    await examRow(page, 1).getByRole("button", { name: "Confirm" }).click();
    await expect(examRow(page, 1).getByRole("alert")).toContainText("More than one student is named “Alice Smith”");
    expect((await scannedRow(batchId, 0)).match_status).toBe("suggested");
  });

  test("View scan shows the sheet, and only staff of the course can read it", async ({ page }) => {
    test.setTimeout(150_000);
    const { course, instructor, alice, assignment, batchId } = await seedUploadedBatch("view scan");
    await processToReview(batchId);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/scans`);
    await examRow(page, 1).getByRole("button", { name: "View scan" }).click();
    const dialog = page.getByRole("dialog", { name: "Scan of exam #1" });
    const image = dialog.getByRole("img", { name: "Scanned page of exam #1" });
    await expect(image).toBeVisible();
    expect(await image.getAttribute("src")).toContain("/storage/v1/object/sign/exam-scans/");
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // The same two reads View scan makes, as real users: Postgres and Storage decide, not the page.
    const row = await scannedRow(batchId, 0);
    const { data: page0 } = await supabase
      .from("exam_scan_pages")
      .select("image_path")
      .eq("scanned_submission_id", row.id)
      .single();
    const grader = await createUserInClass({ role: "grader", class_id: course.id });
    const other = await createClass({ name: "Exam scan review UI other course" });
    const outsider = await createUserInClass({ role: "instructor", class_id: other.id });
    const cases = [
      { who: "instructor", user: instructor, allowed: true },
      { who: "grader", user: grader, allowed: true },
      { who: "student in the course", user: alice, allowed: false },
      { who: "instructor of another course", user: outsider, allowed: false }
    ];
    for (const c of cases) {
      const client = await createAuthenticatedClient(c.user);
      const { data: pages } = await client
        .from("exam_scan_pages")
        .select("image_path")
        .eq("scanned_submission_id", row.id);
      const { data: signed, error } = await client.storage.from("exam-scans").createSignedUrl(page0!.image_path, 60);
      expect({ who: c.who, pages: pages?.length ?? 0, signed: !!signed?.signedUrl && !error }).toEqual({
        who: c.who,
        pages: c.allowed ? 1 : 0,
        signed: c.allowed
      });
    }
  });
});
