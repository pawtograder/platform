import type { BuilderSurvey, BuilderPage, BuilderElement, Choice, SurveyMeta } from "./SurveyBuilderDataTypes";
import { makeEmptySurvey, makePage, makeElement, cloneChoice } from "./factories";

function toChoiceObject(c: unknown): Choice {
  if (c == null) return { value: "" };
  if (typeof c === "string") return { value: c };
  if (typeof c === "object" && "value" in c && typeof (c as Record<string, unknown>).value === "string") {
    const obj = c as Record<string, unknown>;
    return obj.text ? { value: obj.value as string, text: obj.text as string } : { value: obj.value as string };
  }
  return { value: String(c) };
}

function fromChoiceObject(c: Choice): { value: string; text?: string } {
  return c.text ? { value: c.value, text: c.text } : { value: c.value };
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
      return {
        type: "text",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        inputType: el.inputType ?? "text",
        validators: el.validators,
        ...(el.config || {})
      };
    case "comment":
      return {
        type: "comment",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        ...(el.config || {})
      };
    case "radiogroup":
      return {
        type: "radiogroup",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        choices: (el.choices ?? []).map(fromChoiceObject),
        ...(el.config || {})
      };
    case "checkbox":
      return {
        type: "checkbox",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        choices: (el.choices ?? []).map(fromChoiceObject),
        ...(el.config || {})
      };
    case "boolean":
      return {
        type: "boolean",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        labelTrue: el.labelTrue,
        labelFalse: el.labelFalse,
        ...(el.config || {})
      };
    // unreachable
    default:
      return {
        type: (el as Record<string, unknown>).type,
        name: (el as Record<string, unknown>).name,
        ...(el as Record<string, unknown>)
      };
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

export function normalizeForEditor(survey: BuilderSurvey): BuilderSurvey {
  const pages = (survey.pages ?? []).map((p) => ({
    ...p,
    elements: (p.elements ?? []).map((el) => {
      if (el.type === "radiogroup" || el.type === "checkbox") {
        const normalizedChoices = safeArray(el.choices).map((c) =>
          cloneChoice ? cloneChoice(toChoiceObject(c)) : toChoiceObject(c)
        );
        return { ...el, choices: normalizedChoices };
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
        config: restWithoutKeys(elem, [
          "type",
          "id",
          "name",
          "title",
          "description",
          "isRequired",
          "validators",
          "inputType"
        ])
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
        config: restWithoutKeys(elem, ["id", "type", "name", "title", "description", "isRequired", "validators"])
      };
    case "radiogroup":
      return {
        ...makeElement("radiogroup", elem?.name as string | undefined),
        type: "radiogroup",
        name: fallbackName(elem?.name, "radiogroup"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        choices: safeArray(elem?.choices).map(toChoiceObject),
        config: restWithoutKeys(elem, [
          "id",
          "type",
          "name",
          "title",
          "description",
          "isRequired",
          "validators",
          "choices"
        ])
      };
    case "checkbox":
      return {
        ...makeElement("checkbox", elem?.name as string | undefined),
        type: "checkbox",
        name: fallbackName(elem?.name, "checkbox"),
        title: elem?.title as string | undefined,
        description: elem?.description as string | undefined,
        isRequired: !!elem?.isRequired,
        validators: safeArray(elem?.validators),
        choices: safeArray(elem?.choices).map(toChoiceObject),
        config: restWithoutKeys(elem, [
          "id",
          "type",
          "name",
          "title",
          "description",
          "isRequired",
          "validators",
          "choices"
        ])
      };
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
        config: restWithoutKeys(elem, [
          "id",
          "type",
          "name",
          "title",
          "description",
          "isRequired",
          "validators",
          "labelTrue",
          "labelFalse"
        ])
      };
    default: {
      const base = makeElement("text", elem?.name as string | undefined);
      return {
        ...base,
        name: isNonEmptyString(elem?.name) ? elem.name : base.name,
        title: (elem?.title as string | undefined) ?? base.title,
        description: (elem?.description as string | undefined) ?? base.description,
        isRequired: (elem?.isRequired as boolean | undefined) ?? base.isRequired,
        validators: Array.isArray(elem?.validators)
          ? (elem.validators as Array<Record<string, unknown>>)
          : (base.validators ?? []),
        inputType: "text",
        config: restWithoutKeys(elem, [
          "id",
          "type",
          "name",
          "title",
          "description",
          "isRequired",
          "validators",
          "inputType"
        ])
      };
    }
  }
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
