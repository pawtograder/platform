"use client";

// Reusable 3-level question-tree editor for the assessment builder.
// Used both by the quiz builder (question-first, with an answer key) and by the
// paper-exam RegionEditor (which also draws regions on uploaded pages).

import { Box, Button, HStack, Input, NativeSelect, Text, Textarea, VStack } from "@chakra-ui/react";
import { useCallback, useMemo } from "react";

export const ANSWER_TYPES = ["free_text", "short_answer", "multiple_choice", "numeric", "true_false"] as const;
export const OBJECTIVE_TYPES = ["multiple_choice", "numeric", "true_false"];

export type BuilderQuestion = {
  /** Persisted exam_questions.id; null/undefined until first save. Echoed back on save so the
   *  upsert UPDATEs in place (stable ids) instead of minting a new row each time. */
  id?: number | null;
  client_id: string;
  parent_client_id: string | null;
  level: 1 | 2 | 3;
  ordinal: number;
  label: string;
  prompt: string;
  answer_type: string;
  /** Multiple-choice options (also drives the correct-choice picker). */
  choices: string[];
  points: number;
  /** Objective answer key: {choice} | {value} | null (free-text => null). */
  correct_answer: unknown;
  grading_tolerance: number | null;
};

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newQuestion(level: 1 | 2 | 3, parent: string | null, ordinal: number): BuilderQuestion {
  return {
    id: null,
    client_id: uid(),
    parent_client_id: parent,
    level,
    ordinal,
    label: `${level === 1 ? "Part" : level === 2 ? "Question" : "Item"} ${ordinal + 1}`,
    prompt: "",
    answer_type: "free_text",
    choices: [],
    points: level === 3 ? 1 : 0,
    correct_answer: null,
    grading_tolerance: null
  };
}

/** Pre-order traversal so children render directly under their parent. */
function preorder(questions: BuilderQuestion[]): BuilderQuestion[] {
  const childrenOf = new Map<string | null, BuilderQuestion[]>();
  for (const q of questions) {
    const key = q.parent_client_id ?? null;
    (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(q);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.ordinal - b.ordinal);
  const out: BuilderQuestion[] = [];
  const visit = (parent: string | null) => {
    for (const q of childrenOf.get(parent) ?? []) {
      out.push(q);
      visit(q.client_id);
    }
  };
  visit(null);
  return out;
}

export default function QuestionTreeEditor({
  questions,
  onChange,
  showAnswerKey = true
}: {
  questions: BuilderQuestion[];
  onChange: (next: BuilderQuestion[]) => void;
  /** Show the objective answer-key editor (quizzes) vs. plain structure (paper exam). */
  showAnswerKey?: boolean;
}) {
  const ordered = useMemo(() => preorder(questions), [questions]);

  const addQuestion = useCallback(
    (level: 1 | 2 | 3, parent: string | null) => {
      const siblings = questions.filter((q) => (q.parent_client_id ?? null) === parent);
      onChange([...questions, newQuestion(level, parent, siblings.length)]);
    },
    [questions, onChange]
  );

  const updateQuestion = useCallback(
    (cid: string, patch: Partial<BuilderQuestion>) => {
      onChange(questions.map((q) => (q.client_id === cid ? { ...q, ...patch } : q)));
    },
    [questions, onChange]
  );

  const removeQuestion = useCallback(
    (cid: string) => {
      const toRemove = new Set<string>([cid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const q of questions) {
          if (q.parent_client_id && toRemove.has(q.parent_client_id) && !toRemove.has(q.client_id)) {
            toRemove.add(q.client_id);
            grew = true;
          }
        }
      }
      onChange(questions.filter((q) => !toRemove.has(q.client_id)));
    },
    [questions, onChange]
  );

  return (
    <VStack align="stretch" gap={1}>
      <Button size="xs" alignSelf="flex-start" onClick={() => addQuestion(1, null)}>
        + Part (level 1)
      </Button>
      {ordered.map((q) => {
        const isObjective = OBJECTIVE_TYPES.includes(q.answer_type);
        return (
          <Box key={q.client_id} pl={(q.level - 1) * 4} borderLeftWidth={q.level > 1 ? "1px" : 0} borderColor="border">
            <HStack gap={1} align="flex-start" wrap="wrap">
              <Text fontSize="xs" color="fg.muted" pt={2}>
                L{q.level}
              </Text>
              <Input
                size="xs"
                width="180px"
                value={q.label}
                placeholder="Label"
                onChange={(e) => updateQuestion(q.client_id, { label: e.target.value })}
              />
              {q.level < 3 && (
                <Button size="xs" variant="ghost" onClick={() => addQuestion((q.level + 1) as 2 | 3, q.client_id)}>
                  + child
                </Button>
              )}
              <Button size="xs" variant="ghost" colorPalette="red" onClick={() => removeQuestion(q.client_id)}>
                ×
              </Button>
            </HStack>
            {/* leaf-level answer configuration */}
            {questions.every((c) => c.parent_client_id !== q.client_id) && (
              <VStack align="stretch" gap={1} pl={6} pb={2}>
                <Textarea
                  size="xs"
                  rows={1}
                  placeholder="Prompt (shown to students / printed)"
                  value={q.prompt}
                  onChange={(e) => updateQuestion(q.client_id, { prompt: e.target.value })}
                />
                <HStack gap={1} wrap="wrap">
                  <NativeSelect.Root size="xs" width="140px">
                    <NativeSelect.Field
                      value={q.answer_type}
                      onChange={(e) => {
                        const answer_type = e.target.value;
                        // reset the key when the type changes so it stays valid
                        updateQuestion(q.client_id, { answer_type, correct_answer: null });
                      }}
                    >
                      {ANSWER_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Input
                    size="xs"
                    type="number"
                    width="70px"
                    placeholder="pts"
                    value={q.points}
                    onChange={(e) => updateQuestion(q.client_id, { points: Number(e.target.value) })}
                  />
                </HStack>

                {q.answer_type === "multiple_choice" && (
                  <HStack gap={1} wrap="wrap">
                    <Input
                      size="xs"
                      width="260px"
                      placeholder="Choices (comma separated)"
                      value={q.choices.join(", ")}
                      onChange={(e) =>
                        updateQuestion(q.client_id, {
                          choices: e.target.value
                            .split(",")
                            .map((c) => c.trim())
                            .filter(Boolean)
                        })
                      }
                    />
                    {showAnswerKey && (
                      <NativeSelect.Root size="xs" width="160px">
                        <NativeSelect.Field
                          value={(q.correct_answer as { choice?: string } | null)?.choice ?? ""}
                          onChange={(e) =>
                            updateQuestion(q.client_id, {
                              correct_answer: e.target.value ? { choice: e.target.value } : null
                            })
                          }
                        >
                          <option value="">— correct answer —</option>
                          {q.choices.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </NativeSelect.Field>
                      </NativeSelect.Root>
                    )}
                  </HStack>
                )}

                {showAnswerKey && q.answer_type === "true_false" && (
                  <NativeSelect.Root size="xs" width="160px">
                    <NativeSelect.Field
                      value={String((q.correct_answer as { value?: boolean } | null)?.value ?? "")}
                      onChange={(e) =>
                        updateQuestion(q.client_id, {
                          correct_answer: e.target.value ? { value: e.target.value === "true" } : null
                        })
                      }
                    >
                      <option value="">— correct answer —</option>
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                )}

                {showAnswerKey && q.answer_type === "numeric" && (
                  <HStack gap={1}>
                    <Input
                      size="xs"
                      type="number"
                      width="120px"
                      placeholder="correct value"
                      value={(q.correct_answer as { value?: number } | null)?.value ?? ""}
                      onChange={(e) =>
                        updateQuestion(q.client_id, {
                          correct_answer: e.target.value === "" ? null : { value: Number(e.target.value) }
                        })
                      }
                    />
                    <Input
                      size="xs"
                      type="number"
                      width="110px"
                      placeholder="± tolerance"
                      value={q.grading_tolerance ?? ""}
                      onChange={(e) =>
                        updateQuestion(q.client_id, {
                          grading_tolerance: e.target.value === "" ? null : Number(e.target.value)
                        })
                      }
                    />
                  </HStack>
                )}

                {showAnswerKey && !isObjective && (
                  <Text fontSize="2xs" color="fg.muted">
                    Manually graded by rubric.
                  </Text>
                )}
              </VStack>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}
