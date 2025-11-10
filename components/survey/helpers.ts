import type {
  BuilderSurvey,
  BuilderPage,
  BuilderElement,
  ElementType,
} from "./SurveyDataTypes";
import { makePage, makeElement } from "./factories";

/**helpers */

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from === to) return arr.slice(); // nothing changes
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const findPageIdx = (pages: BuilderPage[], pageId: string) =>
  pages.findIndex((p) => p.id === pageId);

const findElIdx = (page: BuilderPage, elId: string) =>
  page.elements.findIndex((e) => e.id === elId);

/**
 * survey funcs for page
 */

export function addPage(
  survey: BuilderSurvey,
  name?: string,
  withDefault: boolean = false
): BuilderSurvey {
  const newPage = makePage(name, withDefault);
  return { ...survey, pages: [...survey.pages, newPage] };
}

export function renamePage(
  survey: BuilderSurvey,
  pageId: string,
  name: string
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) =>
      p.id === pageId ? { ...p, name:name } : p
    ),
  };
}


export function removePage(
  survey: BuilderSurvey,
  pageId: string
): BuilderSurvey {
  const idx = findPageIdx(survey.pages, pageId);
  if (idx < 0) return survey; 

  const nextPages = survey.pages
    .slice(0, idx)
    .concat(survey.pages.slice(idx + 1));

  return nextPages.length
    ? { ...survey, pages: nextPages }
    : { ...survey, pages: [makePage("page1", true)] };
}

export function movePage(
  survey: BuilderSurvey,
  pageId: string,
  dir: -1 | 1
): BuilderSurvey {
  const idx = findPageIdx(survey.pages, pageId);
  if (idx < 0) return survey;
  const to = clamp(idx + dir, 0, survey.pages.length - 1);
  if (to === idx) return survey; 
  return {
    ...survey,
    pages: arrayMove(survey.pages, idx, to),
  };
}

/**
 * element operations
 */

export function addElementToPage(
  survey: BuilderSurvey,
  pageId: string,
  type: ElementType,
  nameHint?: string
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) =>
      p.id === pageId
        ? { ...p, elements: [...p.elements, makeElement(type, nameHint)] }
        : p
    ),
  };
}

function normalizeElement(el: BuilderElement): BuilderElement {
  switch (el.type) {
    case "text":
      (el as any).inputType = (el as any).inputType ?? "text";
      delete (el as any).choices;
      delete (el as any).labelTrue;
      delete (el as any).labelFalse;
      return el;

    case "comment":
      delete (el as any).choices;
      delete (el as any).inputType;
      delete (el as any).labelTrue;
      delete (el as any).labelFalse;
      return el;

    case "radiogroup":
    case "checkbox":
      if (!Array.isArray((el as any).choices) || !(el as any).choices.length) {
        (el as any).choices = [{ value: "Item 1" }, { value: "Item 2" }, { value: "Item 3" }];
      }
      delete (el as any).inputType;
      delete (el as any).labelTrue;
      delete (el as any).labelFalse;
      return el;

    case "boolean":
      delete (el as any).choices;
      delete (el as any).inputType;
      (el as any).labelTrue = (el as any).labelTrue ?? "Yes";
      (el as any).labelFalse = (el as any).labelFalse ?? "No";
      return el;

    default:
      return el;
  }
}


export function updateElement<K extends keyof BuilderElement>(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  key: K,
  value: BuilderElement[K]
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            elements: p.elements.map((el) => {
              if (el.id !== elId) return el;

              const next = { ...el, [key]: value } as BuilderElement;

              // if the type itself changed, normalize hard
              if (key === "type") return normalizeElement(next);

              // minor updates may still require guardrails (e.g., clearing choices from text)
              return normalizeElement(next);
            }),
          }
        : p
    ),
  };
}

export function updateElementPatch(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  patch: Partial<BuilderElement>
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            elements: p.elements.map((el) => {
              if (el.id !== elId) return el;
              const next = { ...el, ...patch } as BuilderElement;
              return normalizeElement(next);
            }),
          }
        : p
    ),
  };
}


export function removeElement(
  survey: BuilderSurvey,
  pageId: string,
  elId: string
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) =>
      p.id === pageId
        ? { ...p, elements: p.elements.filter((e) => e.id !== elId) }
        : p
    ),
  };
}

export function moveElement(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  dir: -1 | 1
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) => {
      if (p.id !== pageId) return p;
      const from = findElIdx(p, elId);
      if (from < 0) return p;
      const to = clamp(from + dir, 0, p.elements.length - 1);
      if (to === from) return p;
      return { ...p, elements: arrayMove(p.elements, from, to) };
    }),
  };
}

export function addChoice(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  value?: string,
  text?: string
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) => {
      if (p.id !== pageId) return p;
      return {
        ...p,
        elements: p.elements.map((el) => {
          if (el.id !== elId) return el;
          if (el.type !== "radiogroup" && el.type !== "checkbox") return el;

          const next = [...(el.choices ?? [])];
          const n = next.length + 1;
          next.push(text ? { value: value ?? `Item ${n}`, text } : { value: value ?? `Item ${n}` });
          return { ...el, choices: next };
        }),
      };
    }),
  };
}

export function moveChoice(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  from: number,
  to: number
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) => {
      if (p.id !== pageId) return p;
      return {
        ...p,
        elements: p.elements.map((el) => {
          if (el.id !== elId) return el;
          if (el.type !== "radiogroup" && el.type !== "checkbox") return el;

          const list = el.choices ?? [];
          if (from < 0 || from >= list.length) return el;
          if (to < 0 || to >= list.length) return el;

          return { ...el, choices: arrayMove(list, from, to) };
        }),
      };
    }),
  };
}

export function setChoice(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  idx: number,
  value: string,
  text?: string
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) => {
      if (p.id !== pageId) return p;
      return {
        ...p,
        elements: p.elements.map((el) => {
          if (el.id !== elId) return el;
          if (el.type !== "radiogroup" && el.type !== "checkbox") return el;

          const next = [...(el.choices ?? [])];
          if (idx < 0 || idx >= next.length) return el;
          next[idx] = text ? { value, text } : { value };
          return { ...el, choices: next };
        }),
      };
    }),
  };
}

export function removeChoice(
  survey: BuilderSurvey,
  pageId: string,
  elId: string,
  idx: number
): BuilderSurvey {
  return {
    ...survey,
    pages: survey.pages.map((p) => {
      if (p.id !== pageId) return p;
      return {
        ...p,
        elements: p.elements.map((el) => {
          if (el.id !== elId) return el;
          if (el.type !== "radiogroup" && el.type !== "checkbox") return el;
          const next = (el.choices ?? []).filter((_, i) => i !== idx);
          const safe = next.length ? next : [{ value: "Item 1" }];
          return { ...el, choices: safe };
        }),
      };
    }),
  };
}

