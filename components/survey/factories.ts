import type {
BuilderSurvey,
BuilderPage,
BuilderElement,
ElementType,
Choice,
TextElement,
CommentElement,
RadioGroupElement,
ChoiceMultiElement,
BooleanElement,
} from "./SurveyDataTypes"

export const DEFAULT_PAGE_NAME = "page";
export const DEFAULT_SURVEY_TITLE = "Survey Name";
export const DEFAULT_TEXT_INPUT_TYPE: TextElement["inputType"] = "text";
export const DEFAULT_BOOL_TRUE = "Yes";
export const DEFAULT_BOOL_FALSE = "No";
export const DEFAULT_CHOICES: Choice[] = [{ value: "Item 1" }, { value: "Item 2" }, {value: "Item 3"}];

export function uid(): string {
    return crypto.randomUUID();
}

export function makeEmptySurvey(): BuilderSurvey {
  const firstPage = makePage(DEFAULT_PAGE_NAME);
  return {
    meta: {
      title: DEFAULT_SURVEY_TITLE,
      config: {},
    },
    pages: [firstPage],
  };
}

export function cloneChoice(c: Choice): Choice {
  return c.text ? { value: c.value, text: c.text } : { value: c.value };
}

export function makeChoice(value?: string, text?: string): Choice {
  return text ? { value: value ?? "", text } : { value: value ?? "" };
}


export function makePage(name?: string, dummyElFlag: boolean = false): BuilderPage {
    const pageName = name ?? "page";
    const id = uid();
    const defaultElement = makeElement("text");
  return {
    id: id,
    name: pageName,
    elements: dummyElFlag ? [defaultElement]: [],
  };
}

export function makeElement(type: ElementType, nameHint?: string): BuilderElement {
    const id = uid();
    const defaultName = `${type}-${id.slice(0, 6)}`;
    const name = nameHint || defaultName;

    switch (type) {
        case "text":
            return {
                id,
                type: "text",
                name,
                title: "",
                isRequired: false,
                inputType: DEFAULT_TEXT_INPUT_TYPE,
            } satisfies TextElement;

        case "comment":
        return {
            id,
            type: "comment",
            name,
            title: "",
            isRequired: false,
        } satisfies CommentElement;

        case "radiogroup":
        return {
            id,
            type: "radiogroup",
            name,
            title: "",
            isRequired: false,
            choices: DEFAULT_CHOICES.map(cloneChoice),
        } satisfies RadioGroupElement;

        case "checkbox":
        return {
            id,
            type: "checkbox",
            name,
            title: "",
            isRequired: false,
            choices: DEFAULT_CHOICES.map(cloneChoice),
        } satisfies ChoiceMultiElement;

        case "boolean":
        return {
            id,
            type: "boolean",
            name,
            title: "",
            isRequired: false,
            labelTrue: DEFAULT_BOOL_TRUE,
            labelFalse: DEFAULT_BOOL_FALSE,
        } satisfies BooleanElement;

        default: {
        const _exhaustive: never = type;
        throw new Error(`Unsupported element type: ${_exhaustive}`);
    }

    }

}