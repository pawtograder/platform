"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CardBody,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  NumberInput,
  Select,
  Stack,
  Switch,
  Tag,
  TagLabel,
  Text,
  Textarea,
  Tooltip,
  VStack,
} from "@chakra-ui/react";

import type {
  BuilderSurvey,
  BuilderPage,
  BuilderElement,
  TextElement,
  CommentElement,
  RadioGroupElement,
  ChoiceMultiElement,
  BooleanElement,
  Choice,
  ElementType,
} from "./SurveyDataTypes";
import { makeEmptySurvey, makePage, makeElement } from "./factories";
import { toJSON, fromJSON } from "./serde";

function isText(el: BuilderElement): el is TextElement {
  return el.type === "text";
}
function isComment(el: BuilderElement): el is CommentElement {
  return el.type === "comment";
}
function isRadio(el: BuilderElement): el is RadioGroupElement {
  return el.type === "radiogroup";
}
function isCheckbox(el: BuilderElement): el is ChoiceMultiElement {
  return el.type === "checkbox";
}
function isBoolean(el: BuilderElement): el is BooleanElement {
  return el.type === "boolean";
}

const ELEMENT_LABEL: Record<ElementType, string> = {
  text: "Short Text",
  comment: "Long Text",
  radiogroup: "Single Choice",
  checkbox: "Checkboxes",
  boolean: "Yes / No",
};

const TEXT_INPUT_TYPES: TextElement["inputType"][] = ["text", "email", "tel", "url", "number"];

type Props = {
  value?: string;
  onChange: (json: string) => void;
};



const SurveyBuilder = ({ value, onChange }: Props) => {
  const [survey, setSurvey] = useState<BuilderSurvey>(() => {
    const parsed = fromJSON(value || "");
    return parsed ?? makeEmptySurvey();
  });
  const [pageIdx, setPageIdx] = useState(0);
  useEffect(() => {
    const parsed = fromJSON(value || "");
    setSurvey(parsed ?? makeEmptySurvey());
    setPageIdx(0);
  }, [value]);

  useEffect(() => {
    onChange(toJSON(survey));
  }, [survey]);

  const currentPage = survey.pages[pageIdx];
function updateElement(id: string, patch: Partial<BuilderElement>) {
  const pages = [...survey.pages];
  const page = { ...pages[pageIdx] };

  page.elements = page.elements.map((el) => {
    if (el.id !== id) return el;
    if ("inputType" in patch && !isText(el)) {
      return el; 
    }

    return { ...el, ...patch } as BuilderElement;
  });

  pages[pageIdx] = page;
  setSurvey((s) => ({ ...s, pages }));
}


function addChoice(id: string) {
  const pages = [...survey.pages];
  const page = { ...pages[pageIdx] };
  page.elements = page.elements.map((el) =>
    el.id === id && (isRadio(el) || isCheckbox(el))
      ? { ...el, choices: [...(el.choices ?? []), { value: `opt${el.choices?.length ?? 0}` }] }
      : el
  );
  pages[pageIdx] = page;
  setSurvey((s) => ({ ...s, pages }));
}

function updateChoice(id: string, idx: number, patch: Partial<Choice>) {
  const pages = [...survey.pages];
  const page = { ...pages[pageIdx] };
  page.elements = page.elements.map((el) => {
    if (el.id !== id || !(isRadio(el) || isCheckbox(el))) return el;
    const ch = [...(el.choices ?? [])];
    ch[idx] = { ...ch[idx], ...patch };
    return { ...el, choices: ch };
  });
  pages[pageIdx] = page;
  setSurvey((s) => ({ ...s, pages }));
}

function removeChoice(id: string, idx: number) {
  const pages = [...survey.pages];
  const page = { ...pages[pageIdx] };
  page.elements = page.elements.map((el) => {
    if (el.id !== id || !(isRadio(el) || isCheckbox(el))) return el;
    const ch = [...(el.choices ?? [])];
    ch.splice(idx, 1);
    return { ...el, choices: ch };
  });
  pages[pageIdx] = page;
  setSurvey((s) => ({ ...s, pages }));
}



  return (
    <div>
      
    </div>
  )
}

export default SurveyBuilder
