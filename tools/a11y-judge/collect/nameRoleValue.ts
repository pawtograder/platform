/**
 * WCAG 4.1.2 (Name, Role, Value) collector — and a small 1.1.1 (Non-text
 * Content) image helper.
 *
 * `collectNameRoleValue` enumerates every interactive element (native controls
 * plus ARIA widget roles and anything with an explicit tabindex) and records:
 *   - tag + role (explicit `role` attr, else a small implicit-role mapping),
 *   - the computed accessible name resolved in the standard precedence order
 *     (aria-label -> aria-labelledby -> label[for]/wrapping label -> innerText
 *     / value / title / alt) with `nameSource` naming the winner,
 *   - value/state attributes only (aria-checked/expanded/pressed/selected,
 *     disabled state, and the input *type* — never the input's actual value),
 *   - the element's bounding rect,
 *   - `suspect: true` when the accessible name is empty/whitespace or is merely
 *     the role name (e.g. a button whose only name is "button").
 * Suspect elements' crop rects are also returned so the caller can screenshot
 * each unnamed control for the judge.
 *
 * `collectImages` enumerates <img> and <svg> for 1.1.1: accessible name (alt /
 * aria-label / <title> / role), a decorative flag, ~200 chars of surrounding
 * text context, and a crop rect.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types. No fs, no assertions.
 */
import type { Page } from "@playwright/test";

/** Elements considered "interactive" for the 4.1.2 sweep. */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='combobox']",
  "[role='slider']",
  "[tabindex]"
].join(",");

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ControlRecord {
  index: number;
  tag: string;
  role: string | null;
  accName: string;
  /** Which resolution step produced the accessible name. */
  nameSource: string;
  /** input `type` when the element is an <input>, else null (never the value). */
  inputType: string | null;
  state: {
    checked: string | null;
    expanded: string | null;
    pressed: string | null;
    selected: string | null;
    disabled: boolean;
  };
  rect: Rect;
  visible: boolean;
  suspect: boolean;
}

export interface SuspectCrop {
  index: number;
  rect: Rect;
}

export interface NameRoleValueData {
  controls: ControlRecord[];
  /** Crop rects for suspect (unnamed / role-named) controls. */
  suspectCrops: SuspectCrop[];
}

export interface ImageRecord {
  index: number;
  tag: string;
  accName: string;
  nameSource: string;
  /** True when role=presentation/none or an explicit empty alt marks it decorative. */
  decorative: boolean;
  /** ~200 chars of nearby text for the judge to rate alt adequacy. */
  surroundingText: string;
  /**
   * The closest interactive ancestor (button/link/etc.), when the image sits
   * inside one. An unnamed SVG inside a properly-labelled button is fully
   * conformant — without this field, icon-only controls are undecidable for
   * 1.1.1 (the judge can only see the SVG's own empty name).
   */
  interactiveAncestor: {
    tag: string;
    role: string | null;
    accName: string;
    nameSource: string;
    /** True when the control shows no visible text of its own (icon-only). */
    iconOnly: boolean;
  } | null;
  rect: Rect;
  visible: boolean;
}

export interface ImagesData {
  images: ImageRecord[];
}

export async function collectNameRoleValue(page: Page): Promise<NameRoleValueData> {
  return page.evaluate((selector) => {
    const clamp = (s: string | null | undefined, n: number): string =>
      (s || "").replace(/\s+/g, " ").trim().slice(0, n);

    const isVisible = (el: Element): boolean => {
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };

    const implicitRole = (el: Element): string | null => {
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        const map: Record<string, string> = {
          checkbox: "checkbox",
          radio: "radio",
          range: "slider",
          button: "button",
          submit: "button",
          reset: "button",
          image: "button",
          search: "searchbox",
          email: "textbox",
          tel: "textbox",
          url: "textbox",
          text: "textbox",
          number: "spinbutton"
        };
        return map[type] ?? "textbox";
      }
      return null;
    };

    const resolveName = (el: Element): { name: string; source: string } => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return { name: clamp(ariaLabel, 200), source: "aria-label" };

      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return { name: clamp(text, 200), source: "aria-labelledby" };
      }

      const id = el.getAttribute("id");
      if (id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLabel && forLabel.textContent && forLabel.textContent.trim()) {
          return { name: clamp(forLabel.textContent, 200), source: "label[for]" };
        }
      }
      const wrapLabel = el.closest("label");
      if (wrapLabel && wrapLabel.textContent && wrapLabel.textContent.trim()) {
        return { name: clamp(wrapLabel.textContent, 200), source: "label-wrap" };
      }

      const inner = (el as HTMLElement).innerText;
      if (inner && inner.trim()) return { name: clamp(inner, 200), source: "innerText" };

      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "button" || type === "submit" || type === "reset") {
          const val = (el as HTMLInputElement).value;
          if (val && val.trim()) return { name: clamp(val, 200), source: "value" };
        }
      }

      const title = el.getAttribute("title");
      if (title && title.trim()) return { name: clamp(title, 200), source: "title" };
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return { name: clamp(alt, 200), source: "alt" };

      return { name: "", source: "none" };
    };

    const controls: Array<{
      index: number;
      tag: string;
      role: string | null;
      accName: string;
      nameSource: string;
      inputType: string | null;
      state: {
        checked: string | null;
        expanded: string | null;
        pressed: string | null;
        selected: string | null;
        disabled: boolean;
      };
      rect: Rect;
      visible: boolean;
      suspect: boolean;
    }> = [];
    const suspectCrops: Array<{ index: number; rect: Rect }> = [];

    interface Rect {
      x: number;
      y: number;
      w: number;
      h: number;
    }

    const els = Array.from(document.querySelectorAll(selector));
    els.forEach((el, index) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? implicitRole(el);
      const { name, source } = resolveName(el);
      const r = el.getBoundingClientRect();
      const rect: Rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      const visible = isVisible(el);
      const inputType = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : null;

      const trimmed = name.trim();
      const suspect = trimmed.length === 0 || (role != null && trimmed.toLowerCase() === role.toLowerCase());

      controls.push({
        index,
        tag,
        role,
        accName: name,
        nameSource: source,
        inputType,
        state: {
          checked: el.getAttribute("aria-checked"),
          expanded: el.getAttribute("aria-expanded"),
          pressed: el.getAttribute("aria-pressed"),
          selected: el.getAttribute("aria-selected"),
          disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
        },
        rect,
        visible,
        suspect
      });

      if (suspect && visible && rect.w > 1 && rect.h > 1) {
        suspectCrops.push({ index, rect });
      }
    });

    return { controls, suspectCrops };
  }, INTERACTIVE_SELECTOR);
}

export async function collectImages(page: Page): Promise<ImagesData> {
  const images = await page.evaluate(() => {
    const clamp = (s: string | null | undefined, n: number): string =>
      (s || "").replace(/\s+/g, " ").trim().slice(0, n);

    const isVisible = (el: Element): boolean => {
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };

    interface Rect {
      x: number;
      y: number;
      w: number;
      h: number;
    }

    // Compact accessible-name resolver for the interactive ancestor (mirrors
    // the precedence used by collectNameRoleValue's in-page resolver).
    const resolveAncestorName = (el: Element): { name: string; source: string } => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return { name: clamp(ariaLabel, 200), source: "aria-label" };
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return { name: clamp(text, 200), source: "aria-labelledby" };
      }
      const inner = (el as HTMLElement).innerText;
      if (inner && inner.trim()) return { name: clamp(inner, 200), source: "innerText" };
      const title = el.getAttribute("title");
      if (title && title.trim()) return { name: clamp(title, 200), source: "title" };
      return { name: "", source: "none" };
    };

    const INTERACTIVE_SELECTOR =
      "button,a[href],[role='button'],[role='link'],[role='menuitem'],[role='tab'],[role='checkbox'],[role='switch'],[tabindex]";

    const records: Array<{
      index: number;
      tag: string;
      accName: string;
      nameSource: string;
      decorative: boolean;
      surroundingText: string;
      interactiveAncestor: {
        tag: string;
        role: string | null;
        accName: string;
        nameSource: string;
        iconOnly: boolean;
      } | null;
      rect: Rect;
      visible: boolean;
    }> = [];

    const els = Array.from(document.querySelectorAll("img,svg"));
    els.forEach((el, index) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const decorative = role === "presentation" || role === "none" || (tag === "img" && el.getAttribute("alt") === "");

      let name = "";
      let source = "none";
      const ariaLabel = el.getAttribute("aria-label");
      const alt = tag === "img" ? el.getAttribute("alt") : null;
      const svgTitle = tag === "svg" ? (el.querySelector("title")?.textContent ?? null) : null;
      const title = el.getAttribute("title");
      if (ariaLabel && ariaLabel.trim()) {
        name = clamp(ariaLabel, 200);
        source = "aria-label";
      } else if (alt && alt.trim()) {
        name = clamp(alt, 200);
        source = "alt";
      } else if (svgTitle && svgTitle.trim()) {
        name = clamp(svgTitle, 200);
        source = "svg-title";
      } else if (title && title.trim()) {
        name = clamp(title, 200);
        source = "title";
      }

      const container = (el.closest("figure") as HTMLElement | null) ?? (el.parentElement as HTMLElement | null);
      const surroundingText = clamp(container?.innerText, 200);

      let interactiveAncestor: (typeof records)[number]["interactiveAncestor"] = null;
      const ancestor = el.closest(INTERACTIVE_SELECTOR);
      if (ancestor && ancestor !== el) {
        const resolved = resolveAncestorName(ancestor);
        interactiveAncestor = {
          tag: ancestor.tagName.toLowerCase(),
          role: ancestor.getAttribute("role"),
          accName: resolved.name,
          nameSource: resolved.source,
          iconOnly: !((ancestor as HTMLElement).innerText || "").trim()
        };
      }

      const r = el.getBoundingClientRect();
      records.push({
        index,
        tag,
        accName: name,
        nameSource: source,
        decorative,
        surroundingText,
        interactiveAncestor,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        visible: isVisible(el)
      });
    });
    return records;
  });

  return { images };
}
