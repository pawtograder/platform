export interface SurveyMeta {
  title?: string;
  config?: Record<string, unknown>;
}

export interface BuilderSurvey {
  meta: SurveyMeta;
  pages: BuilderPage[];
}

export interface BuilderPage {
  id: string;
  name: string;
  elements: BuilderElement[];
}

export type BuilderElement =
  | TextElement
  | CommentElement
  | RadioGroupElement
  | ChoiceMultiElement
  | BooleanElement
  | RatingElement
  | PassthroughElement;

/** Question types the builder can create and edit. */
export type ElementType = "text" | "comment" | "checkbox" | "radiogroup" | "boolean" | "rating";

/**
 * Marker type for a SurveyJS question the builder has no editor for (matrix, ranking,
 * dropdown, ...). The original JSON is kept verbatim in `raw` and written back out
 * unchanged, so opening the builder on a survey that uses one no longer rewrites it into
 * something else. Instructors edit these in the JSON editor.
 */
export const PASSTHROUGH_TYPE = "__passthrough__";

/** `ElementType` plus the non-editable passthrough marker. */
export type BuilderElementType = ElementType | typeof PASSTHROUGH_TYPE;

/**
 * A SurveyJS choice. `value` is what gets stored in the response, and SurveyJS allows it
 * to be a number or boolean as well as a string — Likert scales use numbers. `raw` carries
 * any other properties on the choice (imageLink, enableIf, ...) so they survive a round trip.
 */
export type Choice = {
  value: string | number | boolean;
  text?: string;
  raw?: Record<string, unknown>;
  /**
   * Set only when the source JSON wrote this choice as a bare scalar (`"Yes"`, `3`) rather
   * than as `{ value: ... }`. Both forms are valid SurveyJS and mean the same thing, so this
   * exists purely so that re-saving an untouched survey reproduces the shape it arrived in.
   * Choices created in the builder have no source shape and are written as objects.
   */
  scalar?: true;
};

export interface ElementBase {
  id: string;
  type: BuilderElementType;
  name: string;
  title?: string;
  description?: string;
  isRequired?: boolean;
  validators?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
}

export type TextElement = ElementBase & {
  type: "text";
  inputType: "text" | "number" | "email" | "tel" | "url";
};

export type CommentElement = ElementBase & {
  type: "comment";
};

export type RadioGroupElement = ElementBase & {
  type: "radiogroup";
  choices: Choice[];
};

export type ChoiceMultiElement = ElementBase & {
  type: "checkbox";
  choices: Choice[];
};

export type BooleanElement = ElementBase & {
  type: "boolean";
  labelTrue?: string;
  labelFalse?: string;
};

export type RatingElement = ElementBase & {
  type: "rating";
  rateMin?: number;
  rateMax?: number;
  rateStep?: number;
  rateCount?: number;
  /** Explicit scale points. When present, SurveyJS ignores rateMin/rateMax/rateCount. */
  rateValues?: Choice[];
  minRateDescription?: string;
  maxRateDescription?: string;
};

export type PassthroughElement = ElementBase & {
  type: typeof PASSTHROUGH_TYPE;
  /** The untouched source JSON, including its real `type`. */
  raw: Record<string, unknown>;
};

/** The `type` string the passthrough element stands in for, for display purposes. */
export function passthroughSourceType(el: PassthroughElement): string {
  const t = el.raw?.type;
  return typeof t === "string" && t.trim().length > 0 ? t : "unknown";
}
