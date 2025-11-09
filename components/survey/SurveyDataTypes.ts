export interface SurveyMeta {
  title?: string;
  config?: Record<string, any>;
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


export type ElementType =
  | "text"
  | "comment"
  | "checkbox"
  | "radiogroup"
  | "boolean";


export type Choice = {
  value: string;    
  text?: string;   
};

export interface ElementBase {
  id: string;               
  type: ElementType;
  name: string;              
  title?: string;
  description?: string;
  isRequired?: boolean;
  validators?: Array<Record<string, any>>;
  config?: Record<string, any>;
}

export type TextElement = ElementBase & {
  type: "text";
  inputType: "text" | "number" | "email" | "tel" | "url";
};

export type CommentElement = ElementBase & {
  type: "comment";
}

export type RadioGroupElement = ElementBase & {
  type: "radiogroup";
  choices: Choice[];
}

export type ChoiceMultiElement = ElementBase & {
  type: "checkbox";
  choices: Choice[];
};

export type BooleanElement = ElementBase & {
  type: "boolean";
  labelTrue?: string;
  labelFalse?: string;
}