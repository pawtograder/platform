/**
 * Duplicate question names in a SurveyJS definition (#1005).
 *
 * SurveyJS saves each answer under a key taken from its question, so two questions with the same
 * key share one answer: picking an answer in one clears the other, a required question can be
 * left empty, and the response shows one value in both places. This module finds those
 * collisions so the builder, the save paths and the publish menu can refuse to publish them.
 * `supabase/migrations/20261029120000_surveys_unique_question_names.sql` applies the same rule
 * in the database; keep the two walks in step.
 *
 * The key is the one survey-core 2.3 uses (Question.getValueName):
 * - a question's `valueName`, when it is a non-empty string, exactly as written;
 * - otherwise its `name`, cleaned the way SurveyJS cleans it on load (Question.getValidName):
 *   trimmed, the first "|" dropped, trimmed again, every "{" and "}" dropped, then any leading
 *   "#"s dropped. So "{q1}", "#q1", "q|1" and " q1 " are all saved as "q1".
 * HTML and image elements hold no answer (QuestionNonValue), so their names are not counted.
 * SurveyJS also turns a number or `true` valueName into a key; both walks ignore those.
 *
 * Scopes follow SurveyJS's data model:
 * - Questions on every page and inside (static) panels share the survey's scope.
 * - Each dynamic panel's `templateElements` are a scope of their own, because their answers are
 *   stored per panel inside the dynamic panel's value. A template question may reuse a name from
 *   outside the dynamic panel, but two questions in the same template may not share one.
 * - Panels hold no answer, so a panel's own name is not counted.
 */

/** A panel or repeating (dynamic) panel that holds a question, by the name it was given. */
export type HoldingPanel = { name: string | null; repeating: boolean };

/** Where one of the colliding questions sits, numbered the way the Visual Builder lists it. */
export type QuestionNameLocation = {
  /** 1-based page number, or null when the survey has no pages (root-level `elements`). */
  page: number | null;
  /**
   * 1-based row on the page: the position of the page element that is, or holds, the question.
   * The builder lists every element of a page as one row, a panel or an HTML block included.
   */
  question: number;
  /**
   * For a question inside a panel or a repeating panel: those panels, outermost first, and the
   * question's 1-based position among the elements of the innermost one.
   */
  inside?: { panels: HoldingPanel[]; question: number };
  /** The answer is saved under the question's valueName rather than its name. */
  byValueName?: true;
  /** The name as written, when SurveyJS saves it as something else (braces, "#" or "|" dropped). */
  writtenName?: string;
};

export type DuplicateQuestionName = {
  name: string;
  locations: QuestionNameLocation[];
};

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Accept the survey definition in any shape it reaches the app in: an object, a JSON string, or a
 * JSON string stored inside the jsonb column (the instructor form writes the latter). Returns null
 * for anything that is not a parseable object, since unparseable JSON is reported elsewhere.
 */
export function parseSurveyJson(raw: unknown): JsonObject | null {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
}

/** A name as the instructor wrote it, trimmed. Names panels in the message. */
function writtenName(name: unknown): string | null {
  if (typeof name === "string") {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof name === "number" && Number.isFinite(name)) return String(name);
  return null;
}

/** survey-core's element types that hold no answer. */
const NON_VALUE_TYPES = new Set(["html", "image"]);

type AnswerKey = { key: string; note: Pick<QuestionNameLocation, "byValueName" | "writtenName"> };

/** Question.getValidName drops only the first "|" (survey-core's itemValueSeparator), not all of them. */
function dropFirstPipe(name: string): string {
  const at = name.indexOf("|");
  return at === -1 ? name : name.slice(0, at) + name.slice(at + 1);
}

/** The key SurveyJS saves this element's answer under, or null when it holds no answer. */
function answerKey(el: JsonObject, type: string): AnswerKey | null {
  if (NON_VALUE_TYPES.has(type)) return null;
  if (typeof el.valueName === "string" && el.valueName.length > 0) {
    return { key: el.valueName, note: { byValueName: true } };
  }
  if (typeof el.name === "number" && Number.isFinite(el.name)) return { key: String(el.name), note: {} };
  if (typeof el.name !== "string") return null;
  const key = dropFirstPipe(el.name.trim()).trim().replace(/[{}]+/g, "").replace(/^#+/, "");
  if (key.length === 0) return null;
  const written = el.name.trim();
  return { key, note: written === key ? {} : { writtenName: written } };
}

function elementList(container: JsonObject, key: "elements" | "templateElements"): unknown[] | null {
  const primary = container[key];
  if (Array.isArray(primary)) return primary;
  // `questions` is SurveyJS's older alias for both properties.
  const alias = container.questions;
  return Array.isArray(alias) ? alias : null;
}

type Entry = { scope: number; name: string; location: QuestionNameLocation };

/** Scope 0 is the survey; every dynamic panel template gets the next number. */
type WalkState = { entries: Entry[]; nextScope: number };

/** Where a list of elements sits: its page, the page row holding it, and the panels around it. */
type Position = { page: number | null; row: number | null; panels: HoldingPanel[] };

/**
 * Walk a list of elements, collecting every question name with its scope and location. At the
 * top of a page (`row` null) each element is a row of its own; inside a panel, every element
 * belongs to the panel's row.
 */
function walk(elements: unknown[], scope: number, at: Position, state: WalkState) {
  elements.forEach((el, idx) => {
    if (!isObject(el)) return;
    const row = at.row ?? idx + 1;
    const location: QuestionNameLocation =
      at.panels.length === 0
        ? { page: at.page, question: row }
        : { page: at.page, question: row, inside: { panels: at.panels, question: idx + 1 } };
    const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
    const nested = Array.isArray(el.elements) ? el.elements : null;

    // A panel (or anything else that only groups elements) holds no answer of its own.
    if (type === "panel" || (nested && type !== "paneldynamic")) {
      const children = elementList(el, "elements");
      const panels = [...at.panels, { name: writtenName(el.name), repeating: false }];
      if (children) walk(children, scope, { page: at.page, row, panels }, state);
      return;
    }

    const key = answerKey(el, type);
    if (key) state.entries.push({ scope, name: key.key, location: { ...location, ...key.note } });

    const template = Array.isArray(el.templateElements)
      ? el.templateElements
      : type === "paneldynamic"
        ? elementList(el, "templateElements")
        : null;
    if (template) {
      state.nextScope += 1;
      const panels = [...at.panels, { name: writtenName(el.name), repeating: true }];
      walk(template, state.nextScope, { page: at.page, row, panels }, state);
    }
  });
}

/**
 * Every question name used by more than one question in the same scope, in the order the first
 * repeat appears. Returns [] for a survey without duplicates or one that is not parseable.
 */
export function findDuplicateQuestionNames(rawJson: unknown): DuplicateQuestionName[] {
  const json = parseSurveyJson(rawJson);
  if (!json) return [];

  const state: WalkState = { entries: [], nextScope: 0 };
  if (Array.isArray(json.pages)) {
    json.pages.forEach((page, pageIdx) => {
      if (!isObject(page)) return;
      const elements = elementList(page, "elements");
      if (elements) walk(elements, 0, { page: pageIdx + 1, row: null, panels: [] }, state);
    });
  }
  // A survey with no pages keeps its questions at the root; SurveyJS makes them one page.
  const rootElements = elementList(json, "elements");
  if (rootElements) walk(rootElements, 0, { page: null, row: null, panels: [] }, state);
  const { entries } = state;

  const byKey = new Map<string, DuplicateQuestionName>();
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.scope}\u0000${e.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const e of entries) {
    const key = `${e.scope}\u0000${e.name}`;
    if ((counts.get(key) ?? 0) < 2) continue;
    const group = byKey.get(key) ?? { name: e.name, locations: [] };
    group.locations.push(e.location);
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

function describePanel(panel: HoldingPanel): string {
  const kind = panel.repeating ? "repeating panel" : "panel";
  return panel.name === null ? `an unnamed ${kind}` : `the ${kind} "${panel.name}"`;
}

/**
 * "page 2, question 1", or for a question inside panels, "question 1 of the panel "inner" in
 * the panel "group" (page 1, question 2)", where the part in brackets is the builder's row.
 */
export function describeQuestionLocation(loc: QuestionNameLocation): string {
  const row = loc.page === null ? `question ${loc.question}` : `page ${loc.page}, question ${loc.question}`;
  if (!loc.inside) return row;
  const panels = [...loc.inside.panels].reverse().map(describePanel).join(" in ");
  return `question ${loc.inside.question} of ${panels} (${row})`;
}

/** How a question's name relates to the key its answer is saved under, when that is not plain. */
function keyNote(loc: QuestionNameLocation, key: string): string {
  if (loc.byValueName) return " (as its valueName)";
  if (loc.writtenName !== undefined) return ` (named "${loc.writtenName}", saved as "${key}")`;
  return "";
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
}

/**
 * The message shown in the builder, the survey form, the surveys table and (in shorter form) by
 * the database. It names each repeated name and where it is, and says how to fix it.
 */
export function formatDuplicateQuestionNames(duplicates: DuplicateQuestionName[]): string {
  const groups = duplicates.map(
    (d) =>
      `"${d.name}" is used by ${joinWithAnd(d.locations.map((loc) => describeQuestionLocation(loc) + keyNote(loc, d.name)))}`
  );
  const fix =
    duplicates.length === 1 && duplicates[0].locations.length === 2
      ? "Rename one of them."
      : "Rename the repeats so that no two questions share a name.";
  return `Each question needs its own name, because answers are saved under it. ${groups.join(". ")}. ${fix}`;
}

/** The duplicate-name message for a survey definition, or null when every name is unique. */
export function duplicateQuestionNamesMessage(rawJson: unknown): string | null {
  const duplicates = findDuplicateQuestionNames(rawJson);
  return duplicates.length > 0 ? formatDuplicateQuestionNames(duplicates) : null;
}

/** Stable serialization with sorted keys, so two definitions compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two survey definitions are the same content, whatever shape each arrived in. */
export function sameSurveyJson(a: unknown, b: unknown): boolean {
  const pa = parseSurveyJson(a);
  const pb = parseSurveyJson(b);
  if (!pa || !pb) return false;
  return canonical(pa) === canonical(pb);
}

/**
 * Why publishing this survey must be refused, or null if it may be published. Mirrors the
 * database trigger: the check applies when a survey becomes published, or when the questions of
 * a published survey change. A survey that was already published with duplicates before this
 * check existed keeps working when only its dates or settings change; pass its stored definition
 * as `publishedJson` so the form does not block that edit.
 */
export function publishBlockedByDuplicateNames(args: {
  json: unknown;
  status: string | null | undefined;
  publishedJson?: unknown;
}): string | null {
  if (args.status !== "published") return null;
  const message = duplicateQuestionNamesMessage(args.json);
  if (!message) return null;
  if (args.publishedJson !== undefined && sameSurveyJson(args.json, args.publishedJson)) return null;
  return message;
}
