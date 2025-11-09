import type {
  BuilderSurvey,
  BuilderPage,
  BuilderElement,
  Choice,
  SurveyMeta, 
} from "./SurveyDataTypes";
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
    elements: p.elements.map(exportElement),
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
        ...(el.config || {}),
      };
    case "comment":
      return {
        type: "comment",
        name: el.name,
        title: el.title,
        description: el.description,
        isRequired: el.isRequired,
        validators: el.validators,
        ...(el.config || {}),
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
        ...(el.config || {}),
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
        ...(el.config || {}),
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
        ...(el.config || {}),
      };
      // unreachable
    default:
      return { type: (el as any).type, name: (el as any).name, ...(el as any) };
  }
}
  