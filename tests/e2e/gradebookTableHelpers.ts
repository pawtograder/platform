/** Instructor-gradebook helpers shared by the column-groups and topics E2E specs. */
import type { Page } from "@playwright/test";
import { expect } from "../global-setup";

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
