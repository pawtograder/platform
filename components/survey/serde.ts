import type {
  BuilderSurvey,
  BuilderPage,
  BuilderElement,
  Choice,
  SurveyMeta,
  PassthroughElement,
  RatingElement
} from "./SurveyBuilderDataTypes";
import { PASSTHROUGH_TYPE } from "./SurveyBuilderDataTypes";
import { makeEmptySurvey, makePage, makeElement, makePassthroughElement, cloneChoice } from "./factories";

/** Keys every element carries; excluded from an element's `config` passthrough bag. */
const BASE_KEYS = ["id", "type", "name", "title", "description", "isRequired", "validators"];

const RATING_KEYS = [
  "rateMin",
  "rateMax",
  "rateStep",
  "rateCount",
  "rateValues",
  "minRateDescription",
  "maxRateDescription"
];

/**
 * Read a SurveyJS choice. A choice may be a bare scalar ("Yes", 3, true) or an object
 * `{ value, text, ... }`, and `value` may be a number — Likert scales use numeric values,
 * so coercing them to strings both breaks the scale and orphans already-submitted responses.
 * Anything beyond value/text is kept in `raw` so it survives the round trip.
 */
function toChoiceObject(c: unknown): Choice {
  if (c == null) return { value: "" };
  if (typeof c === "string") return { value: c, scalar: true };
  if (typeof c === "number") return { value: c, scalar: true, valueType: "number" };
  if (typeof c === "boolean") return { value: c, scalar: true, valueType: "boolean" };
  if (typeof c === "object" && "value" in (c as Record<string, unknown>)) {
    const obj = c as Record<string, unknown>;
    const rawValue = obj.value as unknown;
    const value: Choice["value"] =
      typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
        ? rawValue
        : String(rawValue);
    // `raw` holds only the properties beyond value/text. Keeping it disjoint makes this
    // conversion idempotent -- normalizeForEditor re-runs it on already-imported choices,
    // and storing the whole object here would nest a `raw` key inside `raw` each pass and
    // then emit it as a bogus property on save.
    const extras: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      // `raw` is not special-cased on the way in: a source choice that genuinely carries a
      // property named `raw` keeps it, since `extras` is written back verbatim. (Skipping it
      // here would silently drop it, which is the passthrough contract this exists to honor.)
      if (k === "value") continue;
      // A plain string label is lifted onto the Choice so the builder can edit it. A
      // localized label is a per-locale object ({ default: "Yes", fr: "Oui" }); it stays in
      // the passthrough bag and is written back untouched, because stringifying it would
      // produce "[object Object]" and destroy every translation.
      if (k === "text" && typeof obj.text === "string") continue;
      extras[k] = obj[k];
    }
    const out: Choice = { value, raw: extras };
    if (typeof value === "number") out.valueType = "number";
    else if (typeof value === "boolean") out.valueType = "boolean";
    if (typeof obj.text === "string") out.text = obj.text;
    return out;
  }
  return { value: String(c) };
}

/**
 * Write a choice back out. A choice that came in as a bare scalar and was never given a
 * label goes back out as a bare scalar, so round-tripping a survey is a no-op.
 */
function fromChoiceObject(c: Choice): unknown {
  // Only a choice that ARRIVED as a bare scalar goes back out as one. Choices created in the
  // builder have no source shape and are written in object form, which is what the templates
  // and the rest of the repo use -- and what consumers reading the saved JSON expect.
  if (c.scalar && c.text === undefined) return c.value;
  const out: Record<string, unknown> = { ...(c.raw ?? {}), value: c.value };
  if (c.text !== undefined) out.text = c.text;
  return out;
}

/** Drop keys whose value is `undefined` so exporting never invents a key. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function toJSON(survey: BuilderSurvey): Record<string, unknown> {
  const meta = survey.meta ?? {};
  const pages = survey.pages.map((p) => ({
    name: p.name,
    elements: p.elements.map(exportElement)
  }));

  const root: Record<string, unknown> = {};
  if (meta.title) root.title = meta.title;
  if (meta.config) {
    for (const k of Object.keys(meta.config)) {
      if (k !== "pages" && k !== "title") root[k] = meta.config[k];
    }
  }
  root.pages = pages;

  return root;
}

export function toJSONString(survey: BuilderSurvey, space = 2): string {
  return JSON.stringify(toJSON(survey), null, space);
}

function exportElement(el: BuilderElement): Record<string, unknown> {
  switch (el.type) {
    case "text":
      return compact({
        type: "text",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        inputType: el.inputType ?? "text",
        validators: el.validators,
        ...(el.config || {})
      });
    case "comment":
      return compact({
        type: "comment",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        ...(el.config || {})
      });
    case "radiogroup":
    case "checkbox":
      return compact({
        type: el.type,
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        choices: (el.choices ?? []).map(fromChoiceObject),
        ...(el.config || {})
      });
    case "boolean":
      return compact({
        type: "boolean",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        labelTrue: el.labelTrue,
        labelFalse: el.labelFalse,
        ...(el.config || {})
      });
    case "rating":
      return compact({
        type: "rating",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        rateMin: el.rateMin,
        rateMax: el.rateMax,
        rateStep: el.rateStep,
        rateCount: el.rateCount,
        rateValues: el.rateValues ? el.rateValues.map(fromChoiceObject) : undefined,
        minRateDescription: el.minRateDescription,
        maxRateDescription: el.maxRateDescription,
        ...(el.config || {})
      });
    case PASSTHROUGH_TYPE:
      // Write the source JSON back byte-for-byte. The builder renders these read-only, so
      // there is nothing to merge in and saving an untouched survey is a true no-op.
      return { ...el.raw };
    default: {
      const _exhaustive: never = el;
      return { ...(_exhaustive as Record<string, unknown>) };
    }
  }
}

export function fromJSON(input: unknown): BuilderSurvey {
  const root = (input ?? {}) as Record<string, unknown>;
  const meta: SurveyMeta = {
    title: isNonEmptyString(root.title) ? root.title : undefined,
    config: pickRootConfig(root)
  };

  const builderPages: BuilderPage[] = safeArray(root.pages).map((p: unknown, idx: number) => {
    const page = p as Record<string, unknown>;
    const pageName = isNonEmptyString(page?.name) ? page.name : `page${idx + 1}`;
    const pageObj: BuilderPage = {
      ...makePage(pageName),
      name: pageName,
      elements: safeArray(page?.elements).map(importElement)
    };
    return pageObj;
  });

  const pages = builderPages.length > 0 ? builderPages : [makePage()];

  const survey: BuilderSurvey = {
    ...makeEmptySurvey(),
    meta,
    pages
  };

  return normalizeForEditor(survey);
}

export function fromJSONString(json: string): BuilderSurvey {
  try {
    const parsed = JSON.parse(json);
    return fromJSON(parsed);
  } catch {
    return {
      ...makeEmptySurvey(),
      meta: { title: undefined, config: {} },
      pages: [makePage()]
    };
  }
}

/**
 * Deep-copies choice lists so editing one cannot mutate shared state. Runs on the output of
 * `importElement`, so choices are already `Choice` objects — it must NOT re-run
 * `toChoiceObject`, which cannot distinguish an imported bare-scalar choice (`{ value: "Yes" }`,
 * no `raw`) from a source object choice that happened to have no extra properties, and would
 * therefore rewrite every bare `"Yes"` in a template as `{ "value": "Yes" }` on save.
 */
export function normalizeForEditor(survey: BuilderSurvey): BuilderSurvey {
  const pages = (survey.pages ?? []).map((p) => ({
    ...p,
    elements: (p.elements ?? []).map((el) => {
      if (el.type === "radiogroup" || el.type === "checkbox") {
        return { ...el, choices: safeArray<Choice>(el.choices).map(cloneChoice) };
      }
      if (el.type === "rating" && el.rateValues) {
        return { ...el, rateValues: safeArray<Choice>(el.rateValues).map(cloneChoice) };
      }
      return el;
    })
  }));

  return {
    ...survey,
    meta: survey.meta ?? { title: undefined, config: {} },
    pages
  };
}

function importElement(src: unknown): BuilderElement {
  const elem = src as Record<string, unknown>;
  const t = String(elem?.type ?? "").toLowerCase();

  switch (t) {
    case "text":
      return {
        ...makeElement("text", elem?.name as string | undefined),
        type: "text",
        name: fallbackName(elem?.name, "text"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        inputType: isNonEmptyString(elem?.inputType)
          ? (elem.inputType as "text" | "number" | "email" | "tel" | "url")
          : "text",
        config: restWithoutKeys(elem, [...BASE_KEYS, "inputType"])
      };
    case "comment":
      return {
        ...makeElement("comment", elem?.name as string | undefined),
        type: "comment",
        name: fallbackName(elem?.name, "comment"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        config: restWithoutKeys(elem, BASE_KEYS)
      };
    case "radiogroup":
    case "checkbox": {
      const type = t as "radiogroup" | "checkbox";
      return {
        ...makeElement(type, elem?.name as string | undefined),
        type,
        name: fallbackName(elem?.name, type),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        choices: safeArray(elem?.choices).map(toChoiceObject),
        config: restWithoutKeys(elem, [...BASE_KEYS, "choices"])
      };
    }
    case "boolean":
      return {
        ...makeElement("boolean", elem?.name as string | undefined),
        type: "boolean",
        name: fallbackName(elem?.name, "boolean"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        labelTrue: elem?.labelTrue as string | undefined,
        labelFalse: elem?.labelFalse as string | undefined,
        config: restWithoutKeys(elem, [...BASE_KEYS, "labelTrue", "labelFalse"])
      };
    case "rating": {
      const base = makeElement("rating", elem?.name as string | undefined);
      const rating: RatingElement = {
        ...base,
        type: "rating",
        name: fallbackName(elem?.name, "rating"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        rateMin: numberOrUndefined(elem?.rateMin),
        rateMax: numberOrUndefined(elem?.rateMax),
        rateStep: numberOrUndefined(elem?.rateStep),
        rateCount: numberOrUndefined(elem?.rateCount),
        rateValues: Array.isArray(elem?.rateValues) ? safeArray(elem.rateValues).map(toChoiceObject) : undefined,
        minRateDescription: elem?.minRateDescription as string | undefined,
        maxRateDescription: elem?.maxRateDescription as string | undefined,
        config: restWithoutKeys(elem, [...BASE_KEYS, ...RATING_KEYS])
      };
      // A rating with no explicit scale keeps SurveyJS's own defaults rather than
      // inheriting the builder's 1-5, so exporting cannot invent a scale.
      if (rating.rateMin === undefined) delete rating.rateMin;
      if (rating.rateMax === undefined) delete rating.rateMax;
      return rating;
    }
    default: {
      // No editor for this type. Keep the source JSON verbatim so saving is a no-op;
      // previously this fell through to a short-text question and the type was lost.
      const raw = (elem ?? {}) as Record<string, unknown>;
      const el: PassthroughElement = makePassthroughElement(raw, fallbackName(elem?.name, t || "question"));
      return el;
    }
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function safeArray<T = unknown>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function fallbackName(name: unknown, prefix: string): string {
  return isNonEmptyString(name) ? name : `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function restWithoutKeys(obj: unknown, keys: string[]): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, unknown> = {};
  const record = obj as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (!keys.includes(k)) out[k] = record[k];
  }
  return out;
}

function pickRootConfig(root: unknown): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (!root || typeof root !== "object") return cfg;
  const record = root as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (k !== "title" && k !== "pages") cfg[k] = record[k];
  }
  return cfg;
}
