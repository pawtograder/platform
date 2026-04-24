import { AxeBuilder } from "@axe-core/playwright";
import { expect, Page } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";

const DEFAULT_EXCLUDES = [
  // Third-party / rich editors often fail strict axe rules without affecting core app UX in E2E.
  ".monaco-editor",
  ".monaco-mouse-cursor-text",
  "[data-surveyjs]",
  ".sv-root",
  ".sv_main"
];

/**
 * Runs axe-core against the current page and fails the test if any violations are found.
 * Use after navigations and key UI settles (e.g. after expect().toBeVisible() on main content).
 */
export async function assertStudentPageAccessible(page: Page, contextLabel?: string): Promise<void> {
  // @axe-core/playwright types against playwright-core's Page; cast for compatibility with test fixtures.
  let builder = new AxeBuilder({ page: page as unknown as PlaywrightCorePage });
  for (const sel of DEFAULT_EXCLUDES) {
    builder = builder.exclude(sel);
  }
  const results = await builder.analyze();
  const violations = results.violations ?? [];
  if (violations.length === 0) return;

  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join("\n");
  const prefix = contextLabel ? `[${contextLabel}] ` : "";
  expect(violations, `${prefix}Accessibility violations:\n${summary}`).toEqual([]);
}
