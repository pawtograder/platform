"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Text,
  Heading,
  Input,
  Separator,
  Badge,
  Span,
  Accordion,
  Textarea,
  Switch,
  Stack
} from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { LuChevronUp, LuChevronDown, LuTrash2 } from "react-icons/lu";

import type { BuilderSurvey, BuilderPage, BuilderElement, ElementType } from "./SurveyDataTypes";
import { makeEmptySurvey } from "./factories";
import { toJSON, fromJSON, fromJSONString, toJSONString } from "./serde";

import {
  addPage as addPageOp,
  renamePage as renamePageOp,
  removePage as removePageOp,
  movePage as movePageOp,
  addElementToPage as addElementToPageOp,
  updateElement as updateElementOp,
  removeElement as removeElementOp,
  moveElement as moveElementOp,
  updateElementPatch as updateElementPatchOp
} from "./helpers";

import {
  addChoice as addChoiceOp,
  setChoice as setChoiceOp,
  removeChoice as removeChoiceOp,
  moveChoice as moveChoiceOp
} from "./helpers";

/** Fallback sample so the component is always usable in isolation */
const MOCK_JSON = JSON.stringify({
  pages: [
    { id: "p1", name: "page1", elements: [] },
    { id: "p2", name: "page2", elements: [] }
  ]
});

/** Normalize any JSON-ish input (string or object) to a stable string for comparisons. */
const normalizeJSON = (raw?: unknown) => {
  if (raw == null) return "";
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj);
    } catch {
      return raw.trim();
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
};

const isPlainEmptyObject = (v: unknown) =>
  typeof v === "object" && v != null && Object.keys(v as Record<string, unknown>).length === 0;

const safeFromJSON = (raw?: unknown): BuilderSurvey => {
  // choose a source
  if (raw == null || (typeof raw === "object" && isPlainEmptyObject(raw))) {
    return makeEmptySurvey(); // or seed with your MOCK_JSON if you prefer
  }

  if (typeof raw === "string") {
    const s = raw.trim();
    return s.length === 0 ? makeEmptySurvey() : fromJSONString(s);
  }

  return fromJSON(raw);
};

type Props = {
  value?: string; // JSON string
  onChange: (json: string) => void;
  initialJson?: string;
};

const SurveyBuilder = ({ value, onChange, initialJson }: Props) => {
  // Object-form source of truth
  const [survey, setSurvey] = useState<BuilderSurvey>(() => safeFromJSON(value ?? initialJson));

  const [pageIdx, setPageIdx] = useState(0);

  // For the page title input (to avoid reserializing while typing)
  const [pageNameDraft, setPageNameDraft] = useState<string>("");

  // Accordion open ids for the current page (open by default)
  const currentPage = survey.pages[pageIdx];
  const allIdsOnPage = useMemo(() => currentPage?.elements?.map((el) => el.id) ?? [], [currentPage]);
  const [openItems, setOpenItems] = useState<string[]>(allIdsOnPage);

  const lastEmittedJSONRef = useRef<string>(normalizeJSON(toJSON(survey) as any));
  const lastAcceptedPropJSONRef = useRef<string>(normalizeJSON(value ?? initialJson ?? ""));

  // Sync page title draft when changing pages/survey
  useEffect(() => {
    setPageNameDraft(survey.pages[pageIdx]?.name ?? `page${pageIdx + 1}`);
  }, [pageIdx, survey.pages]);

  // Only accept parent updates if they differ from what we just emitted
  useEffect(() => {
    const incoming = normalizeJSON(value ?? "");
    if (!incoming) return;
    if (incoming === lastEmittedJSONRef.current) return;
    if (incoming !== lastAcceptedPropJSONRef.current) {
      const next = safeFromJSON(value);
      setSurvey(next);
      setPageIdx(0);
      lastAcceptedPropJSONRef.current = incoming;
    }
  }, [value]);

  // Serialize upward whenever local object state changes
  useEffect(() => {
    const json = toJSONString(survey, 2);
    lastEmittedJSONRef.current = normalizeJSON(json);
    onChange(json);
  }, [survey, onChange]);

  // Open all accordions by default on page switch
  useEffect(() => {
    setOpenItems(allIdsOnPage);
  }, [allIdsOnPage, pageIdx]);

  // Safely typed elements list for rendering
  const elements: BuilderElement[] = Array.isArray(currentPage?.elements)
    ? (currentPage!.elements as BuilderElement[])
    : [];

  /* ========= Page ops (via helpers) ========= */

  function addPage() {
    setSurvey((prev) => {
      const next = addPageOp(prev, undefined, false);
      setPageIdx(next.pages.length - 1);
      return next;
    });
  }

  function commitRenamePageById(pageId: string, raw: string) {
    const nextName = (raw ?? "").trim() || `page${pageIdx + 1}`;
    setSurvey((prev) => renamePageOp(prev, pageId, nextName));
  }

  function handlePageNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (currentPage) commitRenamePageById(currentPage.id, pageNameDraft);
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  function movePageUpById(pageId: string) {
    setSurvey((prev) => {
      const beforeId = pageId;
      const next = movePageOp(prev, pageId, -1);
      const newIdx = next.pages.findIndex((p) => p.id === beforeId);
      if (newIdx >= 0) setPageIdx(newIdx);
      return next;
    });
  }

  function movePageDownById(pageId: string) {
    setSurvey((prev) => {
      const beforeId = pageId;
      const next = movePageOp(prev, pageId, +1);
      const newIdx = next.pages.findIndex((p) => p.id === beforeId);
      if (newIdx >= 0) setPageIdx(newIdx);
      return next;
    });
  }

  function deletePageById(pageId: string) {
    setSurvey((prev) => {
      const idx = prev.pages.findIndex((p) => p.id === pageId);
      const next = removePageOp(prev, pageId);
      const fallbackIdx = Math.min(Math.max(0, idx - 1), Math.max(0, next.pages.length - 1));
      setPageIdx(fallbackIdx);
      return next;
    });
  }

  /* ========= Element ops (via helpers) ========= */

  const currentPageId = currentPage?.id;

  function addElementToCurrentPage(type: ElementType, nameHint?: string) {
    if (!currentPageId) return;
    setSurvey((prev) => {
      const next = addElementToPageOp(prev, currentPageId, type, nameHint);
      const page = next.pages.find((p) => p.id === currentPageId)!;
      const added = page.elements.at(-1);
      if (added) {
        setOpenItems((ids) => Array.from(new Set([...ids, added.id])));
        const safeName = nameHint ?? added.name ?? `${type}_${page.elements.length}`;
        const withName = updateElementOp(next, currentPageId, added.id, "name" as any, safeName);
        const withTitle = updateElementOp(withName, currentPageId, added.id, "title" as any, safeName);
        return withTitle;
      }
      return next;
    });
  }

  function updateElementField(elId: string, key: keyof BuilderElement, value: any) {
    if (!currentPageId) return;
    setSurvey((prev) => updateElementOp(prev, currentPageId, elId, key as any, value));
  }

  function updateElementFields(elId: string, patch: Partial<BuilderElement>) {
    if (!currentPageId) return;
    setSurvey((prev) => updateElementPatchOp(prev, currentPageId, elId, patch));
  }

  function moveElementById(elId: string, dir: -1 | 1) {
    if (!currentPageId) return;
    setSurvey((prev) => moveElementOp(prev, currentPageId, elId, dir));
  }

  function deleteElementById(elId: string) {
    if (!currentPageId) return;
    setSurvey((prev) => removeElementOp(prev, currentPageId, elId));
  }

  function updateQuestionName(elId: string, value: string) {
    if (!currentPageId) return;
    setSurvey((prev) => {
      const afterName = updateElementOp(prev, currentPageId, elId, "name" as keyof BuilderElement, value as any);
      const afterTitle = updateElementOp(afterName, currentPageId, elId, "title" as keyof BuilderElement, value as any);
      return afterTitle;
    });
  }

  // Type label for each element type
  const typeLabel = (t: BuilderElement["type"]) =>
    t === "text"
      ? "Short Text"
      : t === "comment"
        ? "Long Text"
        : t === "radiogroup"
          ? "Single Choice"
          : t === "checkbox"
            ? "Checkboxes"
            : t === "boolean"
              ? "Yes / No"
              : t;

  return (
    <Flex height="100vh">
      {/* Left rail: pages */}
      <Box width="300px" overflow="auto" height="100%" borderRight="1px solid" borderColor="gray.200" p="4">
        <Flex direction="column" gap="6">
          <Heading size="md">Pages</Heading>
          <Flex direction="column" gap="2">
            {survey.pages.map((p, idx) => {
              const isActive = idx === pageIdx;
              const atTop = idx === 0;
              const atBottom = idx === survey.pages.length - 1;
              return (
                <Flex
                  key={p.id}
                  align="center"
                  justify="space-between"
                  borderWidth={isActive ? "2px" : "1px"}
                  borderColor={isActive ? "blue.400" : "gray.200"}
                  borderRadius="md"
                  px="2"
                  py="1"
                  gap="2"
                >
                  <Text textStyle="xs" fontWeight="bold">
                    {idx + 1}.
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPageIdx(idx)}
                    flex="1"
                    justifyContent="flex-start"
                  >
                    <Text lineClamp={1}>{p.name || `Page ${idx + 1}`}</Text>
                  </Button>
                  <HStack gap="1">
                    <Tooltip content="Move up">
                      <IconButton
                        aria-label="Move page up"
                        size="xs"
                        variant="ghost"
                        onClick={() => movePageUpById(p.id)}
                      >
                        <LuChevronUp />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content="Move down">
                      <IconButton
                        aria-label="Move page down"
                        size="xs"
                        variant="ghost"
                        onClick={() => movePageDownById(p.id)}
                      >
                        <LuChevronDown />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content={survey.pages.length <= 1 ? "Cannot delete last page" : "Delete page"}>
                      <IconButton
                        aria-label="Delete page"
                        size="xs"
                        variant="ghost"
                        onClick={() => deletePageById(p.id)}
                      >
                        <LuTrash2 />
                      </IconButton>
                    </Tooltip>
                  </HStack>
                </Flex>
              );
            })}
          </Flex>

          <Button type="button" onClick={addPage}>
            Add Page
          </Button>
        </Flex>
      </Box>

      {/* Main area (page header + editor box) */}
      <Box flex="1" overflow="auto" height="100%" p="4">
        {/* Header */}
        <Flex direction="column" gap="1" mb="4">
          <Text fontSize="xl" fontWeight="semibold">
            {currentPage?.name ?? ""}
          </Text>
          <Text fontSize="sm" color="gray.500">
            Page {pageIdx + 1} of {survey.pages.length}
          </Text>
        </Flex>

        {/* Page editor box */}
        {currentPage && (
          <Flex direction="column" borderWidth="1px" borderRadius="md" p="3" gap="3" overflow="hidden">
            {/* Top: page name input */}
            <Box>
              <Text fontSize="sm" color="gray.600" mb="1">
                Page name
              </Text>
              <Input
                size="sm"
                value={pageNameDraft}
                onChange={(e) => setPageNameDraft(e.target.value)}
                onBlur={() => commitRenamePageById(currentPage.id, pageNameDraft)}
                onKeyDown={handlePageNameKeyDown}
                placeholder={`page${pageIdx + 1}`}
              />
            </Box>

            <Separator />

            {/* Center: elements (all types) */}
            {elements.length > 0 && (
              <Box flex="1" overflow="auto" p="1">
                <Accordion.Root multiple collapsible value={openItems} onValueChange={(e) => setOpenItems(e.value)}>
                  {elements.map((el, idxEl) => {
                    const atTop = idxEl === 0;
                    const atBottom = idxEl === elements.length - 1;
                    const label = typeLabel(el.type);

                    return (
                      <Accordion.Item key={el.id} value={el.id}>
                        <Accordion.ItemTrigger>
                          <Span flex="1">{el.title?.trim() || `${label} Question`}</Span>
                          <Badge variant="subtle" mr="2">
                            {label}
                          </Badge>

                          <HStack gap="1" mr="1">
                            <Tooltip content="Move up">
                              <IconButton
                                aria-label="Move question up"
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  moveElementById(el.id, -1);
                                }}
                              >
                                <LuChevronUp />
                              </IconButton>
                            </Tooltip>

                            <Tooltip content="Move down">
                              <IconButton
                                aria-label="Move question down"
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  moveElementById(el.id, +1);
                                }}
                              >
                                <LuChevronDown />
                              </IconButton>
                            </Tooltip>

                            <Tooltip content="Delete question">
                              <IconButton
                                aria-label="Delete question"
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteElementById(el.id);
                                }}
                              >
                                <LuTrash2 />
                              </IconButton>
                            </Tooltip>
                          </HStack>

                          <Accordion.ItemIndicator />
                        </Accordion.ItemTrigger>

                        <Accordion.ItemContent>
                          <Accordion.ItemBody>
                            <Box display="grid" gap="3">
                              {/* Question name */}
                              <Box>
                                <Text fontSize="sm" color="gray.600" mb="1">
                                  Question name
                                </Text>
                                <Input
                                  size="sm"
                                  value={el.name ?? ""}
                                  onChange={(e) => updateQuestionName(el.id, e.target.value)}
                                  placeholder={`${label} question`}
                                />
                              </Box>

                              {/* Description */}
                              <Box>
                                <Text fontSize="sm" color="gray.600" mb="1">
                                  Description
                                </Text>
                                <Textarea
                                  size="sm"
                                  value={el.description ?? ""}
                                  onChange={(e) => updateElementField(el.id, "description", e.target.value)}
                                  placeholder="Optional helper text"
                                />
                              </Box>

                              {/* Required toggle */}
                              <Box>
                                <Switch.Root
                                  checked={!!el.isRequired}
                                  onCheckedChange={(detail) => updateElementField(el.id, "isRequired", detail.checked)}
                                  display="flex"
                                  alignItems="center"
                                  gap="2"
                                >
                                  <Switch.HiddenInput />
                                  <Switch.Control />
                                  <Switch.Label>Required</Switch.Label>
                                </Switch.Root>
                              </Box>

                              {/* ======= NEW: Choices/Options blocks ======= */}

                              {/* RadioGroup / Checkbox: Choices editor */}
                              {(el.type === "radiogroup" || el.type === "checkbox") && (
                                <Box mt="2" p="3" borderWidth="1px" rounded="md">
                                  <Heading as="h4" size="sm" mb="3">
                                    Choices
                                  </Heading>

                                  <Stack gap="2">
                                    {(el.choices ?? []).map((c, i) => (
                                      <HStack key={i} align="start">
                                        <Input
                                          size="sm"
                                          flex="1"
                                          value={c.value}
                                          placeholder={`Value ${i + 1}`}
                                          onChange={(e) => {
                                            const list = [...(el.choices ?? [])];
                                            const curr = list[i] ?? { value: "" };
                                            list[i] = {
                                              ...curr,
                                              value: e.target.value
                                            };
                                            updateElementFields(el.id, { choices: list });
                                          }}
                                        />
                                        <HStack>
                                          <IconButton
                                            aria-label="Move up"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                              const list = [...(el.choices ?? [])];
                                              if (i > 0) {
                                                const [item] = list.splice(i, 1);
                                                list.splice(i - 1, 0, item);
                                                updateElementFields(el.id, { choices: list });
                                              }
                                            }}
                                          >
                                            <Span>↑</Span>
                                          </IconButton>
                                          <IconButton
                                            aria-label="Move down"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                              const list = [...(el.choices ?? [])];
                                              if (i < list.length - 1) {
                                                const [item] = list.splice(i, 1);
                                                list.splice(i + 1, 0, item);
                                                updateElementFields(el.id, { choices: list });
                                              }
                                            }}
                                          >
                                            <Span>↓</Span>
                                          </IconButton>
                                          <IconButton
                                            aria-label="Remove"
                                            size="sm"
                                            colorScheme="red"
                                            variant="ghost"
                                            onClick={() => {
                                              const list = [...(el.choices ?? [])].filter((_, j) => j !== i);
                                              const safe = list.length > 0 ? list : [{ value: "Item 1" }];
                                              updateElementFields(el.id, { choices: safe });
                                            }}
                                          >
                                            <Span>✕</Span>
                                          </IconButton>
                                        </HStack>
                                      </HStack>
                                    ))}

                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        const curr = el.choices ?? [];
                                        const n = curr.length + 1;
                                        const next = [...curr, { value: `Item ${n}` }];
                                        updateElementFields(el.id, { choices: next });
                                      }}
                                    >
                                      Add choice
                                    </Button>
                                  </Stack>
                                </Box>
                              )}

                              {/* Boolean: True/False labels */}
                              {el.type === "boolean" && (
                                <Box mt="2" p="3" borderWidth="1px" rounded="md">
                                  <Heading as="h4" size="sm" mb="3">
                                    Options
                                  </Heading>
                                  <HStack>
                                    <Box flex="1">
                                      <Text fontSize="sm" color="gray.600" mb="1">
                                        True label
                                      </Text>
                                      <Input
                                        size="sm"
                                        value={el.labelTrue}
                                        onChange={(e) => updateElementFields(el.id, { labelTrue: e.target.value })}
                                      />
                                    </Box>
                                    <Box flex="1">
                                      <Text fontSize="sm" color="gray.600" mb="1">
                                        False label
                                      </Text>
                                      <Input
                                        size="sm"
                                        value={el.labelFalse}
                                        onChange={(e) => updateElementFields(el.id, { labelFalse: e.target.value })}
                                      />
                                    </Box>
                                  </HStack>
                                </Box>
                              )}
                              {/* ======= /NEW ======= */}
                            </Box>
                          </Accordion.ItemBody>
                        </Accordion.ItemContent>
                      </Accordion.Item>
                    );
                  })}
                </Accordion.Root>
              </Box>
            )}

            <Separator />

            {/* Bottom: add question buttons */}
            <HStack
              justify="flex-start"
              wrap="wrap"
              gap="2"
              position="sticky"
              bottom="0"
              bg="white"
              _dark={{ bg: "gray.900" }}
              zIndex="1"
              pt="2"
              pb="2"
              borderTopWidth="1px"
            >
              <Button
                size="sm"
                type="button"
                onClick={() => addElementToCurrentPage("text", `question_${elements.length + 1}`)}
              >
                + Short Text
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => addElementToCurrentPage("comment", `question_${elements.length + 1}`)}
              >
                + Long Text
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => addElementToCurrentPage("radiogroup", `question_${elements.length + 1}`)}
              >
                + Single Choice
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => addElementToCurrentPage("checkbox", `question_${elements.length + 1}`)}
              >
                + Checkboxes
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => addElementToCurrentPage("boolean", `question_${elements.length + 1}`)}
              >
                + Yes / No
              </Button>
            </HStack>
          </Flex>
        )}
      </Box>
    </Flex>
  );
};

export default SurveyBuilder;
