/** Instructor-gradebook helpers shared by the column-groups and topics E2E specs. */
import type { Page } from "@playwright/test";
import { expect } from "../global-setup";
import { supabase } from "./TestingUtils";
import { visualScreenshot } from "./VisualTestUtils";

/** Wide enough that each realistic gradebook fits in one capture, collapsed or expanded. */
export const GRADEBOOK_VIEWPORT = { width: 2400, height: 900 };

export function tableRegion(page: Page) {
  return page.getByRole("region", { name: "Instructor Gradebook Table" });
}

/** Group/topic header texts in the instructor table, left to right (header row 1). */
export async function headerUnits(page: Page): Promise<string[]> {
  return tableRegion(page)
    .locator("thead tr")
    .first()
    .evaluate((row) =>
      Array.from(row.querySelectorAll("p"))
        .map((p) => (p.textContent ?? "").trim())
        .filter((t) => t.length > 0)
    );
}

/** Settled virtualized table: same row transforms and scroll offsets on two animation frames. */
export async function waitForVirtualizerIdle(page: Page) {
  // Forget the previous call's signature. Expanding groups or switching views changes columns but
  // not row transforms or scroll offsets, so a stale signature would match on the first frame and
  // return before React has rendered the change.
  await page.evaluate(() => {
    delete (window as unknown as { __virtSig?: string }).__virtSig;
  });
  await page.waitForFunction(
    () => {
      const container = document.querySelector('[role="region"][aria-label="Instructor Gradebook Table"]');
      const rows = container ? Array.from(container.querySelectorAll('tbody [role="row"]')) : [];
      if (!container || rows.length === 0) return false;
      const sig = [
        container.scrollTop,
        container.scrollLeft,
        ...rows.map((r) => `${(r as HTMLElement).style.transform}:${(r as HTMLElement).style.height}`)
      ].join("|");
      const w = window as unknown as { __virtSig?: string };
      if (w.__virtSig === sig) return true;
      w.__virtSig = sig;
      return false;
    },
    { polling: "raf", timeout: 10_000 }
  );
}

/**
 * Wait until no rendered cell shows the recalculating indicator. gradebookCell.tsx draws a pulsing
 * calculator icon (`.gradebook-cell-pulse`) while the cell's row has `is_recalculating` set, and the
 * flag reaches the page by realtime broadcast, after the database has finished. A capture taken
 * before the broadcast arrives shows the icons. Each flip also remounts the cell's children, which
 * defeats bounding-box stability checks. Waits for the whole set to drain, and lets a
 * recalculation that stays stuck past `timeoutMs` fail the test instead of passing silently.
 */
export async function waitForGradebookCellsIdle(page: Page, timeoutMs = 30_000) {
  if ((await page.locator(".gradebook-cell-pulse").count()) === 0) return;
  await page.waitForFunction(() => document.querySelectorAll(".gradebook-cell-pulse").length === 0, undefined, {
    timeout: timeoutMs
  });
}

/** No cell recalculating and the virtualizer settled: the instructor table is ready to capture. */
export async function settleInstructorGradebook(page: Page) {
  await waitForGradebookCellsIdle(page);
  await waitForVirtualizerIdle(page);
}

/**
 * Poll until every rendered instructor cell of `columnId` shows the score the database holds for it.
 * Use after a change that recalculates a column on a page that is already open: the recalculation
 * wait in gradebookColumnGroupsFixtures.ts says the database is done, but the new scores still have
 * to arrive by realtime before the cells show them. Cells render `round(score, 2)` (the default
 * render expression), "-" for no score, and "Missing" for a missing one.
 */
export async function expectInstructorColumnMatchesDb(page: Page, columnId: number, timeout = 60_000) {
  const { data, error } = await supabase
    .from("gradebook_column_students")
    .select("student_id, score, score_override, is_missing")
    .eq("gradebook_column_id", columnId)
    .eq("is_private", true);
  if (error) throw new Error(`Failed to read scores for column ${columnId}: ${error.message}`);
  const expected = (data ?? []).map((row) => {
    const score = row.score_override ?? row.score;
    const text = row.is_missing ? "Missing" : score === null ? "-" : String(Math.round(score * 100) / 100);
    return { student: row.student_id, text };
  });
  await expect
    .poll(
      async () => {
        const shown = await tableRegion(page).evaluate((el, id) => {
          const out: Record<string, string> = {};
          el.querySelectorAll(`[data-gradebook-cell-trigger][data-column-id="${id}"]`).forEach((cell) => {
            const student = cell.getAttribute("data-student-id");
            if (student) out[student] = (cell.textContent ?? "").replace(/\*/g, "").trim();
          });
          return out;
        }, columnId);
        return expected.filter(({ student, text }) => shown[student] !== text).map(({ student }) => student);
      },
      { timeout, message: `Gradebook cells of column ${columnId} never matched the database` }
    )
    .toEqual([]);
}

/** Expand every group and wait until no collapsed group (an "Expand group" cell button) is left. */
export async function expandAllGroups(page: Page) {
  await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
  await expect(tableRegion(page).getByRole("button", { name: "Expand group", exact: true })).toHaveCount(0);
  await settleInstructorGradebook(page);
}

type GradebookScreenshotOptions = NonNullable<Parameters<typeof visualScreenshot>[2]> & {
  /**
   * The capture shows an open menu. A realtime refresh re-renders the table under an open menu
   * and can close it while visualScreenshot waits for the page to settle, so the capture would
   * show the table without the menu. Reopen it with `open` if `menuItem` is no longer visible.
   */
  keepMenuOpen?: { menuItem: string; open: () => Promise<void> };
};

/**
 * visualScreenshot for the instructor gradebook page: waits for recalculation indicators to drain
 * and the virtualizer to settle before the capture, and again right before it is taken.
 */
export async function gradebookScreenshot(page: Page, name: string, options: GradebookScreenshotOptions = {}) {
  const { keepMenuOpen, beforeScreenshot, ...rest } = options;
  await settleInstructorGradebook(page);
  return visualScreenshot(page, name, {
    ...rest,
    beforeScreenshot: async (api) => {
      await waitForGradebookCellsIdle(page);
      if (keepMenuOpen) {
        const item = page.getByRole("menuitem", { name: keepMenuOpen.menuItem, exact: true });
        if (!(await item.isVisible())) {
          await keepMenuOpen.open();
          await expect(item).toBeVisible();
        }
      }
      await beforeScreenshot?.(api);
    }
  });
}

export async function waitForToastsGone(page: Page) {
  await expect(page.locator('[data-scope="toast"][data-state="open"]')).toHaveCount(0, { timeout: 15_000 });
}

export async function openInstructorGradebook(page: Page, courseId: number) {
  await page.goto(`/course/${courseId}/manage/gradebook`);
  await expect(tableRegion(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Showing 6 students/)).toBeVisible({ timeout: 60_000 });
  await waitForVirtualizerIdle(page);
}

/** Columns render only near the viewport, so scroll the table right until the header exists. */
export async function openColumnMenu(page: Page, columnName: string) {
  const header = tableRegion(page)
    .locator("[data-col-id]")
    .filter({ has: page.getByText(columnName, { exact: true }) })
    .first();
  for (let i = 0; i < 20 && (await header.count()) === 0; i++) {
    await tableRegion(page).evaluate((el) => el.scrollBy({ left: 600 }));
    await waitForVirtualizerIdle(page);
  }
  await header.scrollIntoViewIfNeeded();
  await header.getByRole("button", { name: "Column options" }).click();
}

/** Scroll the table back to its left edge, so screenshots start at the first column. */
export async function scrollTableHome(page: Page) {
  await tableRegion(page).evaluate((el) => el.scrollTo({ left: 0, top: 0 }));
  await waitForVirtualizerIdle(page);
}

/**
 * Click a menu item, reopening its menu with `open` if the menu has closed. A realtime refresh
 * re-renders the table under an open menu, which can close it between a screenshot and the
 * click; a plain click would then wait for an item that never comes back.
 */
export async function clickMenuItem(page: Page, name: string, open: () => Promise<void>) {
  const item = page.getByRole("menuitem", { name });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await item.isVisible()) {
      try {
        await item.click({ timeout: 10_000 });
        return;
      } catch {
        // The menu closed under the click; reopen it below.
      }
    }
    await open();
    await item.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  }
  await item.click({ timeout: 10_000 });
}
