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



const SurveyBuilder = () => {
  return (
    <div>
      
    </div>
  )
}

export default SurveyBuilder
