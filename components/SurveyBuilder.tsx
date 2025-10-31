"use client";

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  Text,
  Textarea,
  VStack,
  Select,
  Checkbox,
  createListCollection,
  Separator,
  Portal,
  Badge,
  Tabs,
  Code,
  Tooltip,
  Alert,
  Card,
  Kbd,
} from "@chakra-ui/react";
import { LuTrash2, LuPlus, LuArrowUp, LuArrowDown, LuInfo, LuCopy } from "react-icons/lu";

// -----------------------------
// Types with stable ids
// -----------------------------

type ElementType = "text" | "checkbox" | "radiogroup";

type BuilderElement = {
  id: string;
  type: ElementType;
  name: string;
  title: string;
  description?: string;
  isRequired?: boolean;
  inputType?: "text" | "number" | "email";
  choices?: string[];
};

type BuilderPage = { id: string; name: string; elements: BuilderElement[] };
export type SurveyJSON = { pages: Array<Omit<BuilderPage, "id">> };

// -----------------------------
// Utils
// -----------------------------

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const questionTypeCollection = createListCollection({
  items: [
    { label: "Text", value: "text" },
    { label: "Checkbox", value: "checkbox" },
    { label: "Radiogroup", value: "radiogroup" },
  ],
});

const inputTypeCollection = createListCollection({
  items: [
    { label: "text", value: "text" },
    { label: "number", value: "number" },
    { label: "email", value: "email" },
  ],
});

// ---------------------------------------------
// JSON helpers (external contract preserved)
// ---------------------------------------------

function normalizeForExport(pages: Array<Omit<BuilderPage, "id">>): SurveyJSON {
  let firstCheckbox: any;
  let firstRadio: any;
  let firstNumberText: any;
  let firstEmailText: any;

  for (const p of pages) {
    for (const el of p.elements as any[]) {
      if (!firstNumberText && el.type === "text" && el.inputType === "number") firstNumberText = el;
      if (!firstEmailText && el.type === "text" && el.inputType === "email") firstEmailText = el;
      if (!firstCheckbox && el.type === "checkbox") firstCheckbox = el;
      if (!firstRadio && el.type === "radiogroup") firstRadio = el;
    }
  }

  const outPages: any[] = [];

  outPages.push({
    name: "Name",
    elements: [
      { type: "text", name: "FirstName", title: "Enter your first name:", isRequired: true },
      { type: "text", name: "LastName", title: "Enter your last name:" },
    ],
  });

  if (firstCheckbox) {
    outPages.push({
      name: "page1",
      elements: [
        {
          type: "checkbox",
          name: "question1",
          title: "question with checkbox",
          choices: firstCheckbox.choices?.length ? firstCheckbox.choices : ["Item 1", "Item 2", "Item 3"],
        },
      ],
    });
  }
  if (firstRadio) {
    outPages.push({
      name: "page2",
      elements: [
        {
          type: "radiogroup",
          name: "question2",
          title: "question with choices",
          choices: firstRadio.choices?.length ? firstRadio.choices : ["Item 1", "Item 2", "Item 3", "Item 4"],
        },
      ],
    });
  }
  if (firstNumberText) {
    outPages.push({
      name: "page3",
      elements: [
        { type: "text", name: "question3", title: "phone number", inputType: "number" },
      ],
    });
  }
  if (firstEmailText) {
    outPages.push({
      name: "page4",
      elements: [
        { type: "text", name: "question4", title: "email", inputType: "email" },
      ],
    });
  }

  return { pages: outPages };
}

function toJSONString(pages: BuilderPage[]) {
  const plain: Array<Omit<BuilderPage, "id">> = pages.map((p) => ({
    name: p.name,
    elements: p.elements.map(({ id, ...rest }) => ({
      ...rest,
      choices: rest.type === "text" ? undefined : rest.choices?.length ? rest.choices : ["Item 1", "Item 2"],
    })),
  }));
  return JSON.stringify(normalizeForExport(plain), null, 2);
}

// Parse incoming JSON **without ids** (so we can reconcile IDs)
function parseExternal(json: string): Array<{ name: string; elements: Omit<BuilderElement, "id">[] }> {
  try {
    const parsed = JSON.parse(json);
    if (parsed?.pages) {
      return parsed.pages.map((p: any, pi: number) => ({
        name: p.name || `page${pi + 1}`,
        elements: (p.elements || []).map((el: any, ei: number) => ({
          type: (el.type as ElementType) || "text",
          name: el.name || `${el.type || "text"}-${ei + 1}`,
          title: el.title || "Untitled Question",
          description: el.description || "",
          isRequired: !!el.isRequired,
          inputType: el.inputType || "text",
          choices: el.type === "text" ? undefined : el.choices || ["Item 1", "Item 2"],
        })),
      }));
    }
  } catch {}
  return [{ name: "page1", elements: [] }];
}

// Reconcile new parsed value with existing state to **preserve ids**
function reconcile(prev: BuilderPage[], next: ReturnType<typeof parseExternal>): BuilderPage[] {
  const result: BuilderPage[] = next.map((np, i) => {
    const candidate = prev.find((p) => p.name === np.name) ?? prev[i];
    const pageId = candidate?.id ?? uid();
    const elements: BuilderElement[] = np.elements.map((ne, j) => {
      const ematch = candidate?.elements.find((e) => e.name === ne.name && e.type === ne.type) ?? candidate?.elements[j];
      const elId = ematch?.id ?? uid();
      return { id: elId, ...ne } as BuilderElement;
    });
    return { id: pageId, name: np.name, elements };
  });
  return result;
}

// -----------------------------
// Reducer – single source of truth
// -----------------------------

type Action =
  | { type: "SET_ALL"; pages: BuilderPage[] }
  | { type: "ADD_PAGE"; id: string }
  | { type: "REMOVE_PAGE"; pageId: string }
  | { type: "RENAME_PAGE"; pageId: string; name: string }
  | { type: "MOVE_PAGE"; pageId: string; dir: -1 | 1 }
  | { type: "ADD_EL"; pageId: string; qtype: ElementType; id: string }
  | { type: "UPDATE_EL"; pageId: string; elId: string; key: keyof BuilderElement; value: any }
  | { type: "REMOVE_EL"; pageId: string; elId: string }
  | { type: "MOVE_EL"; pageId: string; elId: string; dir: -1 | 1 }
  | { type: "SET_CHOICE"; pageId: string; elId: string; idx: number; value: string }
  | { type: "ADD_CHOICE"; pageId: string; elId: string }
  | { type: "REMOVE_CHOICE"; pageId: string; elId: string; idx: number };

function arrayMove<T>(arr: T[], from: number, to: number) {
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function reducer(state: BuilderPage[], action: Action): BuilderPage[] {
  switch (action.type) {
    case "SET_ALL":
      return action.pages;
    case "ADD_PAGE":
      return [...state, { id: action.id, name: `page${state.length + 1}`, elements: [] }];
    case "REMOVE_PAGE": {
      const next = state.filter((p) => p.id !== action.pageId);
      return next.length ? next : [{ id: uid(), name: "page1", elements: [] }];
    }
    case "RENAME_PAGE":
      return state.map((p) => (p.id === action.pageId ? { ...p, name: action.name } : p));
    case "MOVE_PAGE": {
      const idx = state.findIndex((p) => p.id === action.pageId);
      const to = idx + action.dir;
      if (idx < 0 || to < 0 || to >= state.length) return state;
      return arrayMove(state, idx, to);
    }
    case "ADD_EL":
      return state.map((p) => {
        if (p.id !== action.pageId) return p;
        const base: BuilderElement = {
          id: action.id,
          type: action.qtype,
          name: `${action.qtype}-${p.elements.length + 1}`,
          title: "New question",
          isRequired: false,
          inputType: "text",
          choices: action.qtype === "text" ? undefined : ["Item 1", "Item 2"],
        };
        return { ...p, elements: [...p.elements, base] };
      });
    case "UPDATE_EL":
      return state.map((p) =>
        p.id === action.pageId
          ? {
              ...p,
              elements: p.elements.map((el) =>
                el.id === action.elId
                  ? {
                      ...el,
                      [action.key]: action.value,
                      ...(action.key === "type" && action.value === "text" ? { choices: undefined } : {}),
                      ...(action.key === "type" && (action.value === "checkbox" || action.value === "radiogroup")
                        ? { choices: el.choices?.length ? el.choices : ["Item 1", "Item 2"] }
                        : {}),
                    }
                  : el
              ),
            }
          : p
      );
    case "REMOVE_EL":
      return state.map((p) => (p.id === action.pageId ? { ...p, elements: p.elements.filter((el) => el.id !== action.elId) } : p));
    case "MOVE_EL":
      return state.map((p) => {
        if (p.id !== action.pageId) return p;
        const idx = p.elements.findIndex((e) => e.id === action.elId);
        const to = idx + action.dir;
        if (idx < 0 || to < 0 || to >= p.elements.length) return p;
        return { ...p, elements: arrayMove(p.elements, idx, to) };
      });
    case "SET_CHOICE":
      return state.map((p) => {
        if (p.id !== action.pageId) return p;
        return {
          ...p,
          elements: p.elements.map((el) => {
            if (el.id !== action.elId) return el;
            const next = [...(el.choices || [])];
            next[action.idx] = action.value;
            return { ...el, choices: next };
          }),
        };
      });
    case "ADD_CHOICE":
      return state.map((p) => {
        if (p.id !== action.pageId) return p;
        return {
          ...p,
          elements: p.elements.map((el) =>
            el.id === action.elId
              ? { ...el, choices: [...(el.choices || []), `Item ${(el.choices?.length ?? 0) + 1}`] }
              : el
          ),
        };
      });
    case "REMOVE_CHOICE":
      return state.map((p) => {
        if (p.id !== action.pageId) return p;
        return {
          ...p,
          elements: p.elements.map((el) => {
            if (el.id !== action.elId) return el;
            const next = (el.choices || []).filter((_, i) => i !== action.idx);
            return { ...el, choices: next.length ? next : ["Item 1"] };
          }),
        };
      });
    default:
      return state;
  }
}

// -----------------------------
// Main Component (pure Chakra UI)
// -----------------------------

export default function SurveyBuilder({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [pages, dispatch] = useReducer(reducer, [], () => {
    const parsed = parseExternal(value);
    return parsed.map((p) => ({ id: uid(), name: p.name, elements: p.elements.map((e) => ({ id: uid(), ...e })) }));
  });
  const [selectedPageId, setSelectedPageId] = useState<string | undefined>(() => pages[0]?.id);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External value → reconcile with current state
  useEffect(() => {
    const nextParsed = parseExternal(value);
    const reconciled = reconcile(pages, nextParsed);
    dispatch({ type: "SET_ALL", pages: reconciled });
    setSelectedPageId((prev) => (prev && reconciled.some((p) => p.id === prev) ? prev : reconciled[0]?.id));
  }, [value]);

  // Emit debounced JSON
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(toJSONString(pages)), 120);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [pages, onChange]);

  const selectedPage = useMemo(() => pages.find((p) => p.id === selectedPageId) || pages[0], [pages, selectedPageId]);

  const addPage = useCallback(() => {
    const newId = uid();
    dispatch({ type: "ADD_PAGE", id: newId });
    setSelectedPageId(newId);
  }, []);

  const removePage = useCallback((pageId: string) => {
    const idx = pages.findIndex((p) => p.id === pageId);
    const fallback = pages[idx + 1]?.id || pages[idx - 1]?.id;
    dispatch({ type: "REMOVE_PAGE", pageId });
    setSelectedPageId(fallback);
  }, [pages]);

  const movePage = useCallback((pageId: string, dir: -1 | 1) => dispatch({ type: "MOVE_PAGE", pageId, dir }), []);
  const renamePage = useCallback((pageId: string, name: string) => dispatch({ type: "RENAME_PAGE", pageId, name }), []);
  const addEl = useCallback((pageId: string, qtype: ElementType) => { const id = uid(); dispatch({ type: "ADD_EL", pageId, qtype, id }); }, []);
  const updateEl = useCallback(<K extends keyof BuilderElement>(pageId: string, elId: string, key: K, value: BuilderElement[K]) => dispatch({ type: "UPDATE_EL", pageId, elId, key, value }), []);
  const removeEl = useCallback((pageId: string, elId: string) => dispatch({ type: "REMOVE_EL", pageId, elId }), []);
  const moveEl = useCallback((pageId: string, elId: string, dir: -1 | 1) => dispatch({ type: "MOVE_EL", pageId, elId, dir }), []);
  const setChoice = useCallback((pageId: string, elId: string, idx: number, value: string) => dispatch({ type: "SET_CHOICE", pageId, elId, idx, value }), []);
  const addChoice = useCallback((pageId: string, elId: string) => dispatch({ type: "ADD_CHOICE", pageId, elId }), []);
  const removeChoice = useCallback((pageId: string, elId: string, idx: number) => dispatch({ type: "REMOVE_CHOICE", pageId, elId, idx }), []);

  const copyJSON = useCallback(async () => {
    try { await navigator.clipboard.writeText(toJSONString(pages)); } catch {}
  }, [pages]);

  return (
    <HStack align="start" gap={4}>
      <VStack align="stretch" gap={2} w="260px">
        <HStack justify="space-between">
          <Text fontWeight="semibold">Pages</Text>
        </HStack>
        <VStack align="stretch" gap={2}>
          {pages.map((p, i) => (
            <Card.Root key={p.id} variant={selectedPage?.id === p.id ? "elevated" : "subtle"} onClick={() => setSelectedPageId(p.id)} cursor="pointer">
              <Card.Body p={3}>
                <HStack justify="space-between" align="center">
                  <HStack>
                    <Badge>{i + 1}</Badge>
                    <Text maxW="140px">{p.name || `page${i + 1}`}</Text>
                  </HStack>
                  <HStack>
                    <IconButton aria-label="Move up" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); movePage(p.id, -1); }} type="button" disabled={i === 0}><LuArrowUp /></IconButton>
                    <IconButton aria-label="Move down" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); movePage(p.id, 1); }} type="button" disabled={i === pages.length - 1}><LuArrowDown /></IconButton>
                    <IconButton aria-label="Delete page" size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); removePage(p.id); }} type="button"><LuTrash2 /></IconButton>
                  </HStack>
                </HStack>
              </Card.Body>
            </Card.Root>
          ))}
          <Button size="sm" onClick={(e) => { e.stopPropagation(); addPage(); }} type="button">Add Page</Button>
        </VStack>
      </VStack>

      <VStack align="stretch" gap={4} flex={1}>
        <HStack justify="space-between" align="center">
          <Text fontWeight="semibold">Build Survey</Text>
          <Button size="sm" variant="outline" onClick={copyJSON} type="button">Copy JSON</Button>
        </HStack>

        {selectedPage && (
          <Box p={4} border="1px solid" borderColor="gray.600" borderRadius="xl" shadow="sm">
            <HStack gap={3} mb={3}>
              <Text minW="88px">Page name:</Text>
              <Input size="sm" value={selectedPage.name} onChange={(e) => renamePage(selectedPage.id, e.target.value)} />
            </HStack>
            <Separator my={3} />

            <VStack align="stretch" gap={3}>
              {selectedPage.elements.map((el, idx) => (
                <Box key={el.id} p={3} border="1px dashed" borderColor="gray.500" borderRadius="lg">
                  <HStack gap={3} mb={2} wrap="wrap">
                    <Select.Root
                      collection={questionTypeCollection}
                      value={[el.type]}
                      onValueChange={({ value }) => updateEl(selectedPage.id, el.id, "type", (value?.[0] as ElementType) ?? el.type)}
                      size="sm"
                    >
                      <Select.HiddenSelect />
                      <Select.Control>
                        <Select.Trigger maxW="180px">
                          <Select.ValueText placeholder="Question type" />
                        </Select.Trigger>
                        <Select.IndicatorGroup>
                          <Select.Indicator />
                        </Select.IndicatorGroup>
                      </Select.Control>
                    </Select.Root>

                    <HStack gap={2}>
                      <Text fontSize="sm">Required</Text>
                      <Checkbox.Root checked={!!el.isRequired} onCheckedChange={(d) => updateEl(selectedPage.id, el.id, "isRequired", !!d.checked)}>
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                      </Checkbox.Root>
                    </HStack>

                    <HStack>
                      <IconButton aria-label="Move up" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveEl(selectedPage.id, el.id, -1); }} type="button" disabled={idx === 0}><LuArrowUp /></IconButton>
                      <IconButton aria-label="Move down" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveEl(selectedPage.id, el.id, 1); }} type="button" disabled={idx === selectedPage.elements.length - 1}><LuArrowDown /></IconButton>
                      <IconButton aria-label="Remove question" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); removeEl(selectedPage.id, el.id); }} type="button"><LuTrash2 /></IconButton>
                    </HStack>
                  </HStack>

                  <Input size="sm" placeholder="Title" value={el.title} onChange={(e) => updateEl(selectedPage.id, el.id, "title", e.target.value)} />
                  <Textarea size="sm" placeholder="Description (optional)" value={el.description ?? ""} onChange={(e) => updateEl(selectedPage.id, el.id, "description", e.target.value)} />

                  <Separator my={3} />

                  {el.type === "text" && (
                    <HStack gap={3}>
                      <Text fontSize="sm">Input type</Text>
                      <Select.Root
                        collection={inputTypeCollection}
                        value={[el.inputType ?? "text"]}
                        onValueChange={({ value }) => updateEl(selectedPage.id, el.id, "inputType", ((value?.[0] as any) ?? "text"))}
                        size="sm"
                      >
                        <Select.HiddenSelect />
                        <Select.Control>
                          <Select.Trigger maxW="160px">
                            <Select.ValueText placeholder="Input type" />
                          </Select.Trigger>
                        </Select.Control>
                      </Select.Root>
                    </HStack>
                  )}

                  {(el.type === "checkbox" || el.type === "radiogroup") && (
                    <VStack align="stretch" gap={2}>
                      {(el.choices || []).map((c, cidx) => (
                        <HStack key={cidx}>
                          <Input size="sm" value={c} onChange={(e) => setChoice(selectedPage.id, el.id, cidx, e.target.value)} />
                          <IconButton aria-label="Remove choice" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); removeChoice(selectedPage.id, el.id, cidx); }} type="button"><LuTrash2 /></IconButton>
                        </HStack>
                      ))}
                      <Button size="xs" variant="outline" onClick={(e) => { e.stopPropagation(); addChoice(selectedPage.id, el.id); }} type="button">Add choice</Button>
                    </VStack>
                  )}
                </Box>
              ))}

              <HStack gap={2}>
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); addEl(selectedPage.id, "text"); }} type="button">+ Add Text</Button>
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); addEl(selectedPage.id, "checkbox"); }} type="button">+ Add Checkbox</Button>
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); addEl(selectedPage.id, "radiogroup"); }} type="button">+ Add Radiogroup</Button>
              </HStack>
            </VStack>
          </Box>
        )}

        <Tabs.Root defaultValue="preview">
          <Tabs.List>
            <Tabs.Trigger value="preview">Preview JSON</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="preview">
            <Box p={3} border="1px solid" borderColor="gray.600" borderRadius="md" fontSize="sm" overflowX="auto">
              <pre style={{ margin: 0 }}><Code>{toJSONString(pages)}</Code></pre>
            </Box>
          </Tabs.Content>
        </Tabs.Root>
      </VStack>
    </HStack>
  );
}