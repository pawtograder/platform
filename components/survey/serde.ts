import type { BuilderSurvey, BuilderPage, BuilderElement, Choice, SurveyMeta } from "./SurveyDataTypes";
import { makeEmptySurvey, makePage, makeElement, cloneChoice } from "./factories";

function toChoiceObject(c: any): Choice {
  if (c == null) return { value: "" };
  if (typeof c === "string") return { value: c };
  if (typeof c === "object" && typeof c.value === "string") {
    return c.text ? { value: c.value, text: c.text } : { value: c.value };
  }
  return { value: String(c) };
}

function fromChoiceObject(c: Choice): any {
  return c.text ? { value: c.value, text: c.text } : { value: c.value };
}

export function toJSON(survey: BuilderSurvey): any {
  const meta = survey.meta ?? {};
  const pages = survey.pages.map((p) => ({
    name: p.name,
    elements: p.elements.map(exportElement)
  }));

  const root: any = {};
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

function exportElement(el: BuilderElement): any {
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
      return { type: (el as any).type, name: (el as any).name, ...(el as any) };
  }
}

export function fromJSON(input: any): BuilderSurvey {
  const root = input ?? {};
  const meta: SurveyMeta = {
    title: isNonEmptyString(root.title) ? root.title : undefined,
    config: pickRootConfig(root)
  };

  const builderPages: BuilderPage[] = safeArray(root.pages).map((p: any, idx: number) => {
    const pageName = isNonEmptyString(p?.name) ? p.name : `page${idx + 1}`;
    const page: BuilderPage = {
      ...makePage(pageName),
      name: pageName,
      elements: safeArray(p?.elements).map(importElement)
    };
    return page;
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

function importElement(src: any): BuilderElement {
  const t = String(src?.type ?? "").toLowerCase();

  switch (t) {
    case "text":
      return {
        ...makeElement("text", src?.name),
        type: "text",
        name: fallbackName(src?.name, "text"),
        title: src?.title,
        description: src?.description,
        isRequired: !!src?.isRequired,
        validators: safeArray(src?.validators),
        inputType: isNonEmptyString(src?.inputType) ? src.inputType : "text",
        config: restWithoutKeys(src, [
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
        ...makeElement("comment", src?.name),
        type: "comment",
        name: fallbackName(src?.name, "comment"),
        title: src?.title,
        description: src?.description,
        isRequired: !!src?.isRequired,
        validators: safeArray(src?.validators),
        config: restWithoutKeys(src, ["id", "type", "name", "title", "description", "isRequired", "validators"])
      };
    case "radiogroup":
      return {
        ...makeElement("radiogroup", src?.name),
        type: "radiogroup",
        name: fallbackName(src?.name, "radiogroup"),
        title: src?.title,
        description: src?.description,
        isRequired: !!src?.isRequired,
        validators: safeArray(src?.validators),
        choices: safeArray(src?.choices).map(toChoiceObject),
        config: restWithoutKeys(src, [
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
        ...makeElement("checkbox", src?.name),
        type: "checkbox",
        name: fallbackName(src?.name, "checkbox"),
        title: src?.title,
        description: src?.description,
        isRequired: !!src?.isRequired,
        validators: safeArray(src?.validators),
        choices: safeArray(src?.choices).map(toChoiceObject),
        config: restWithoutKeys(src, [
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
        ...makeElement("boolean", src?.name),
        type: "boolean",
        name: fallbackName(src?.name, "boolean"),
        title: src?.title,
        description: src?.description,
        isRequired: !!src?.isRequired,
        validators: safeArray(src?.validators),
        labelTrue: src?.labelTrue,
        labelFalse: src?.labelFalse,
        config: restWithoutKeys(src, [
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
      const base = makeElement("text", src?.name);
      return {
        ...base,
        name: isNonEmptyString(src?.name) ? src.name : base.name,
        title: src?.title ?? base.title,
        description: src?.description ?? base.description,
        isRequired: src?.isRequired ?? base.isRequired,
        validators: Array.isArray(src?.validators) ? src.validators : (base.validators ?? []),
        inputType: "text",
        config: restWithoutKeys(src, [
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

function isNonEmptyString(s: any): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function safeArray<T = any>(x: any): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function fallbackName(name: any, prefix: string): string {
  return isNonEmptyString(name) ? name : `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function restWithoutKeys(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return {};
  const out: any = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) out[k] = obj[k];
  }
  return out;
}

function pickRootConfig(root: any): Record<string, any> {
  const cfg: Record<string, any> = {};
  if (!root || typeof root !== "object") return cfg;
  for (const k of Object.keys(root)) {
    if (k !== "title" && k !== "pages") cfg[k] = root[k];
  }
  return cfg;
}
