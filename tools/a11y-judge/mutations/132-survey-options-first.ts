/**
 * WCAG 1.3.2 Meaningful Sequence — PLANTS A FAILURE (survey pages only).
 *
 * For every SurveyJS question (`.sd-question`), moves the question TITLE element
 * to AFTER its options/content container in DOM order, then restores the visual
 * order with flexbox `order` so the screenshot still looks correct. The result:
 * the on-screen order (title, then options) disagrees with the programmatic
 * reading/DOM order (options, then title) — a 1.3.2 meaningful-sequence failure
 * that is invisible in a screenshot but wrong to a screen reader / serialized
 * reading order.
 */
import type { Mutation } from "./types";

const mutation132: Mutation = {
  id: "132-survey-options-first",
  criterion: "1.3.2",
  description:
    "Moves SurveyJS question titles after their options in DOM order (visual order preserved via CSS), breaking reading order.",
  expected: "fail",
  pageIds: ["survey-taking"],
  async apply(page) {
    await page.addInitScript(() => {
      const DONE = "a11yMut132";
      const reorder = (question: Element): void => {
        const el = question as HTMLElement;
        if (el.dataset[DONE] === "done") return; // idempotent per question
        // SurveyJS DOM: .sd-question > .sd-question__header (wraps the title)
        // followed by .sd-question__content (the options). The header and
        // content are SIBLINGS — moving the title within the header never
        // changes reading order, so we move the whole header after the content
        // inside their common parent.
        const header = question.querySelector<HTMLElement>(":scope .sd-question__header");
        const content = question.querySelector<HTMLElement>(":scope .sd-question__content");
        if (!header || !content || header.contains(content) || content.contains(header)) return;
        const parent = content.parentElement;
        if (!parent || header.parentElement !== parent) return;
        // Force a column flex container so `order` controls the visual layout.
        parent.style.display = "flex";
        parent.style.flexDirection = "column";
        // DOM order: content first, then header/title (bad for AT). Visual
        // order: header first via negative `order` (looks unchanged on screen).
        header.style.order = "-1";
        content.style.order = "0";
        // Physically move the header node after the content.
        parent.appendChild(header);
        // Only mark done if the DOM order really flipped.
        if (content.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING) {
          el.dataset[DONE] = "done";
        }
      };
      const scan = (): void => {
        document.querySelectorAll(".sd-question").forEach(reorder);
      };
      const start = (): void => {
        scan();
        // SurveyJS mounts/re-renders questions asynchronously — keep reordering
        // late-arriving question roots.
        const observer = new MutationObserver(() => scan());
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
    });
  }
};

export default mutation132;
