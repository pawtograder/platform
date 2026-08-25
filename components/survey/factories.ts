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
  RatingElement,
  PassthroughElement
} from "./SurveyBuilderDataTypes";
import { PASSTHROUGH_TYPE } from "./SurveyBuilderDataTypes";

export const DEFAULT_PAGE_NAME = "page";
export const DEFAULT_SURVEY_TITLE = "Survey Name";
export const DEFAULT_TEXT_INPUT_TYPE: TextElement["inputType"] = "text";
export const DEFAULT_BOOL_TRUE = "Yes";
export const DEFAULT_BOOL_FALSE = "No";
export const DEFAULT_CHOICES: Choice[] = [{ value: "Item 1" }, { value: "Item 2" }, { value: "Item 3" }];
export const DEFAULT_RATE_MIN = 1;
export const DEFAULT_RATE_MAX = 5;

export function uid(): string {
  return crypto.randomUUID();
}

export function makeEmptySurvey(): BuilderSurvey {
  const firstPage = makePage(DEFAULT_PAGE_NAME);
  return {
    meta: {
      title: DEFAULT_SURVEY_TITLE,
      config: {}
    },
    pages: [firstPage]
  };
}

export function cloneChoice(c: Choice): Choice {
  const out: Choice = { value: c.value };
  if (c.text !== undefined) out.text = c.text;
  if (c.raw !== undefined) out.raw = { ...c.raw };
  if (c.scalar) out.scalar = true;
  if (c.valueType) out.valueType = c.valueType;
  return out;
}

export function makeChoice(value?: Choice["value"], text?: string): Choice {
  return text ? { value: value ?? "", text } : { value: value ?? "" };
}

/**
 * The value to store when an instructor edits a choice in the builder.
 *
 * Reads the JSON type off the choice rather than off its current value: while the instructor
 * retypes, the value is transiently "", and inferring the type from that would turn a Likert
 * `3` into `"3"` on the next keystroke and orphan every response already submitted against it.
 */
export function nextChoiceValue(choice: Choice, raw: string): Choice["value"] {
  const type = choice.valueType ?? typeof choice.value;
  if (raw.trim() === "") return raw;
  if (type === "number" && Number.isFinite(Number(raw))) return Number(raw);
  if (type === "boolean" && (raw === "true" || raw === "false")) return raw === "true";
  return raw;
}

export function makePassthroughElement(raw: Record<string, unknown>, name: string): PassthroughElement {
  return {
    id: uid(),
    type: PASSTHROUGH_TYPE,
    name,
    title: typeof raw.title === "string" ? raw.title : undefined,
    isRequired: !!raw.isRequired,
    raw
  };
}

export function makePage(name?: string, dummyElFlag: boolean = false): BuilderPage {
  const pageName = name ?? "page";
  const id = uid();
  const defaultElement = makeElement("text");
  return {
    id: id,
    name: pageName,
    elements: dummyElFlag ? [defaultElement] : ([] as BuilderElement[])
  };
}

export function makeElement(type: "text", nameHint?: string): TextElement;
export function makeElement(type: "comment", nameHint?: string): CommentElement;
export function makeElement(type: "radiogroup", nameHint?: string): RadioGroupElement;
export function makeElement(type: "checkbox", nameHint?: string): ChoiceMultiElement;
export function makeElement(type: "boolean", nameHint?: string): BooleanElement;
export function makeElement(type: "rating", nameHint?: string): RatingElement;
export function makeElement(type: ElementType, nameHint?: string): BuilderElement;

export function makeElement(type: ElementType, nameHint?: string): BuilderElement {
  const id = uid();
  const defaultLabel = nameHint ?? `${type}-${id.slice(0, 6)}`;

  switch (type) {
    case "text":
      return {
        id,
        type: "text",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false,
        inputType: DEFAULT_TEXT_INPUT_TYPE
      } satisfies TextElement;

    case "comment":
      return {
        id,
        type: "comment",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false
      } satisfies CommentElement;

    case "radiogroup":
      return {
        id,
        type: "radiogroup",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false,
        choices: DEFAULT_CHOICES.map(cloneChoice)
      } satisfies RadioGroupElement;

    case "checkbox":
      return {
        id,
        type: "checkbox",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false,
        choices: DEFAULT_CHOICES.map(cloneChoice)
      } satisfies ChoiceMultiElement;

    case "boolean":
      return {
        id,
        type: "boolean",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false,
        labelTrue: DEFAULT_BOOL_TRUE,
        labelFalse: DEFAULT_BOOL_FALSE
      } satisfies BooleanElement;

    case "rating":
      return {
        id,
        type: "rating",
        name: defaultLabel,
        title: defaultLabel,
        isRequired: false,
        rateMin: DEFAULT_RATE_MIN,
        rateMax: DEFAULT_RATE_MAX
      } satisfies RatingElement;

    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported element type: ${_exhaustive}`);
    }
  }
}
