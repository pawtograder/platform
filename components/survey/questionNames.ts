/**
 * Duplicate question names in a SurveyJS definition (#1005).
 *
 * SurveyJS saves each answer under its question's `name`, so two questions with the same name
 * share one answer: picking an answer in one clears the other, a required question can be left
 * empty, and the response shows one value in both places. This module finds those collisions so
 * the builder, the save paths and the publish menu can refuse to publish them.
 * `supabase/migrations/20261029120000_surveys_unique_question_names.sql` applies the same rule
 * in the database; keep the two walks in step.
 *
 * Scopes follow SurveyJS's data model:
 * - Questions on every page and inside (static) panels share the survey's scope.
 * - Each dynamic panel's `templateElements` are a scope of their own, because their answers are
 *   stored per panel inside the dynamic panel's value. A template question may reuse a name from
 *   outside the dynamic panel, but two questions in the same template may not share one.
 * - Panels hold no answer, so a panel's own name is not counted.
 */

/** Where one of the colliding questions sits, numbered the way an instructor reads the survey. */
export type QuestionNameLocation = {
  /** 1-based page number, or null when the survey has no pages (root-level `elements`). */
  page: number | null;
  /** 1-based position of the question among the questions of its page (or of its template). */
  question: number;
  /** Name of the dynamic panel whose template holds the question, when it is in one. */
  dynamicPanel?: string;
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

/** SurveyJS trims question names on load, so " q1" and "q1" are the same key. */
function normalizeName(name: unknown): string | null {
  if (typeof name === "string") {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof name === "number" && Number.isFinite(name)) return String(name);
  return null;
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

/**
 * Walk a list of elements, collecting every question name with its scope. `counter` numbers the
 * questions of one page (or one template) in reading order, nested panels included.
 */
function walk(
  elements: unknown[],
  scope: number,
  page: number | null,
  counter: { n: number },
  dynamicPanel: string | undefined,
  state: WalkState
) {
  elements.forEach((el) => {
    if (!isObject(el)) return;
    const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
    const nested = Array.isArray(el.elements) ? el.elements : null;

    // A panel (or anything else that only groups elements) holds no answer of its own.
    if (type === "panel" || (nested && type !== "paneldynamic")) {
      const children = elementList(el, "elements");
      if (children) walk(children, scope, page, counter, dynamicPanel, state);
      return;
    }

    counter.n += 1;
    const name = normalizeName(el.name);
    if (name) state.entries.push({ scope, name, location: { page, question: counter.n, dynamicPanel } });

    const template = Array.isArray(el.templateElements)
      ? el.templateElements
      : type === "paneldynamic"
        ? elementList(el, "templateElements")
        : null;
    if (template) {
      state.nextScope += 1;
      walk(template, state.nextScope, page, { n: 0 }, name ?? "unnamed", state);
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
      if (elements) walk(elements, 0, pageIdx + 1, { n: 0 }, undefined, state);
    });
  }
  // A survey with no pages keeps its questions at the root; SurveyJS makes them one page.
  const rootElements = elementList(json, "elements");
  if (rootElements) walk(rootElements, 0, null, { n: 0 }, undefined, state);
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

/** "page 2, question 1", or "question 3 of the repeating panel "team" on page 1". */
export function describeQuestionLocation(loc: QuestionNameLocation): string {
  const page = loc.page === null ? "" : `page ${loc.page}`;
  if (loc.dynamicPanel !== undefined) {
    return `question ${loc.question} of the repeating panel "${loc.dynamicPanel}"${page ? ` on ${page}` : ""}`;
  }
  return page ? `${page}, question ${loc.question}` : `question ${loc.question}`;
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
    (d) => `"${d.name}" is used by ${joinWithAnd(d.locations.map(describeQuestionLocation))}`
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
