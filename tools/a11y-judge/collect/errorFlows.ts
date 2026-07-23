/**
 * WCAG 3.3.1 (Error Identification) collector.
 *
 * `ErrorFlowRecorder` scripts an interaction and captures the resulting error
 * state for the judge:
 *   - `step(label, fn)` appends a transcript entry ({ label, tOffset } in ms
 *     since the recorder was constructed) and then runs `fn`,
 *   - `snapshotErrorState()` dumps, from the live page, every `[aria-invalid]`
 *     element (with its resolved aria-describedby text), every role=alert /
 *     role=status region's contents, and the currently-focused element's
 *     identity — the raw material for judging whether an error was identified
 *     in text and associated with the field.
 *
 * The recorder holds no filesystem state; the caller serializes `transcript`
 * and each snapshot into `raw-json` probes. When a page has no reachable
 * invalid-submit flow, the caller emits a probe with `flowAvailable: false`.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types.
 */
import type { Page } from "@playwright/test";

export interface TranscriptEntry {
  label: string;
  /** ms since the recorder was constructed. */
  tOffset: number;
}

export interface InvalidFieldDump {
  tag: string;
  role: string | null;
  name: string;
  ariaInvalid: string | null;
  describedByText: string[];
  rect: { x: number; y: number; w: number; h: number };
}

export interface AlertDump {
  role: string | null;
  ariaLive: string | null;
  text: string;
}

export interface ErrorStateSnapshot {
  invalidFields: InvalidFieldDump[];
  alerts: AlertDump[];
  focused: {
    tag: string;
    role: string | null;
    name: string;
    type: string | null;
  } | null;
}

export class ErrorFlowRecorder {
  private readonly page: Page;
  private readonly start: number;
  readonly transcript: TranscriptEntry[] = [];

  constructor(page: Page) {
    this.page = page;
    this.start = Date.now();
  }

  async step(label: string, fn: () => Promise<void>): Promise<void> {
    this.transcript.push({ label, tOffset: Date.now() - this.start });
    await fn();
  }

  async snapshotErrorState(): Promise<ErrorStateSnapshot> {
    return this.page.evaluate(() => {
      const clamp = (s: string | null | undefined, n: number): string =>
        (s || "").replace(/\s+/g, " ").trim().slice(0, n);

      const resolveDescribedBy = (el: Element): string[] => {
        const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        return ids
          .map((id) => clamp(document.getElementById(id)?.textContent, 200))
          .filter((t) => t.length > 0);
      };

      const invalidFields = Array.from(document.querySelectorAll("[aria-invalid]"))
        .filter((el) => el.getAttribute("aria-invalid") !== "false")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            name: clamp(el.getAttribute("aria-label") ?? (el as HTMLElement).innerText, 120),
            ariaInvalid: el.getAttribute("aria-invalid"),
            describedByText: resolveDescribedBy(el),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height }
          };
        });

      const alerts = Array.from(document.querySelectorAll("[role='alert'],[role='status'],[aria-live]")).map((el) => ({
        role: el.getAttribute("role"),
        ariaLive: el.getAttribute("aria-live"),
        text: clamp((el as HTMLElement).innerText ?? el.textContent, 200)
      }));

      const active = document.activeElement as HTMLElement | null;
      const focused =
        active && active !== document.body
          ? {
              tag: active.tagName.toLowerCase(),
              role: active.getAttribute("role"),
              name: clamp(active.getAttribute("aria-label") ?? active.innerText, 120),
              type: active.getAttribute("type")
            }
          : null;

      return { invalidFields, alerts, focused };
    });
  }
}
