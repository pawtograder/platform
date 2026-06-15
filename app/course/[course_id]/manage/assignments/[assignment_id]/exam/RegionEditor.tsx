"use client";

import { examExtractTemplate } from "@/lib/edgeFunctions";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Flex, Heading, HStack, Input, NativeSelect, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type NormRect = { x: number; y: number; width: number; height: number };
type TemplatePage = { page_number: number; image_path: string; width: number; height: number };

type EditorQuestion = {
  // Persisted exam_questions.id (null = new). Sent back on save so exam_upsert_questions_and_regions
  // UPDATEs in place and ids stay stable (keeps the rubric back-references matching).
  id: number | null;
  client_id: string;
  parent_client_id: string | null;
  level: 1 | 2 | 3;
  ordinal: number;
  label: string;
  answer_type: string;
  points: number;
  // Carried through (not edited in this region UI) so "Save structure" doesn't wipe the
  // prompt/choices/answer-key authored in the Quiz Builder: the upsert writes every column
  // from this payload, NULLing any field we omit.
  prompt: string;
  choices: string[];
  correct_answer: Json;
  grading_tolerance: number | null;
};
type EditorRegion = {
  client_id: string;
  question_client_id: string | null;
  kind: "answer" | "student_id" | "name";
  page_number: number;
} & NormRect;

const ANSWER_TYPES = ["free_text", "multiple_choice", "numeric", "true_false", "short_answer"];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function RegionEditor({ examId, gradingRubricId }: { examId: number; gradingRubricId: number | null }) {
  const [pages, setPages] = useState<TemplatePage[]>([]);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [questions, setQuestions] = useState<EditorQuestion[]>([]);
  const [regions, setRegions] = useState<EditorRegion[]>([]);
  const [draftKind, setDraftKind] = useState<"answer" | "student_id" | "name">("answer");
  const [draftQuestion, setDraftQuestion] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const drawing = useRef<{ page: number; startX: number; startY: number } | null>(null);
  const [preview, setPreview] = useState<(NormRect & { page: number }) | null>(null);

  // load template pages + existing questions/regions
  useEffect(() => {
    const supabase = createClient();
    async function load() {
      const { data: pageRows, error: pageErr } = await supabase
        .from("exam_template_pages")
        .select("page_number, image_path, width, height")
        .eq("exam_id", examId)
        .order("page_number");
      if (pageErr) throw pageErr;
      const ps = (pageRows ?? []) as TemplatePage[];
      const next: Record<number, string> = {};
      for (const p of ps) {
        const { data: signed, error: signErr } = await supabase.storage
          .from("exam-templates")
          .createSignedUrl(p.image_path, 60 * 60 * 12);
        if (signErr) throw signErr;
        if (signed?.signedUrl) next[p.page_number] = signed.signedUrl;
      }

      const { data: qRows, error: qErr } = await supabase
        .from("exam_questions")
        .select(
          "id, parent_id, level, ordinal, label, prompt, answer_type, choices, points, correct_answer, grading_tolerance"
        )
        .eq("exam_id", examId)
        .order("level")
        .order("ordinal");
      if (qErr) throw qErr;
      const idToClient = new Map<number, string>();
      const qs: EditorQuestion[] = (qRows ?? []).map((q) => {
        const cid = uid();
        idToClient.set(q.id, cid);
        const rawChoices = q.choices as unknown;
        return {
          id: q.id,
          client_id: cid,
          parent_client_id: null,
          level: (q.level as 1 | 2 | 3) ?? 1,
          ordinal: Number(q.ordinal ?? 0),
          label: q.label ?? "",
          answer_type: q.answer_type ?? "free_text",
          points: Number(q.points ?? 0),
          prompt: q.prompt ?? "",
          choices: Array.isArray(rawChoices) ? rawChoices.map((c) => String(c)) : [],
          correct_answer: q.correct_answer ?? null,
          grading_tolerance: q.grading_tolerance == null ? null : Number(q.grading_tolerance)
        };
      });
      // resolve parents
      (qRows ?? []).forEach((q, i) => {
        if (q.parent_id != null) qs[i].parent_client_id = idToClient.get(q.parent_id) ?? null;
      });

      const { data: rRows, error: rErr } = await supabase
        .from("exam_question_regions")
        .select("exam_question_id, kind, page_number, x, y, width, height")
        .eq("exam_id", examId);
      if (rErr) throw rErr;
      const rs: EditorRegion[] = (rRows ?? []).map((r) => ({
        client_id: uid(),
        question_client_id: r.exam_question_id != null ? (idToClient.get(r.exam_question_id) ?? null) : null,
        kind: (r.kind as EditorRegion["kind"]) ?? "answer",
        page_number: r.page_number,
        x: Number(r.x),
        y: Number(r.y),
        width: Number(r.width),
        height: Number(r.height)
      }));

      // only hydrate state once every query succeeded
      setPages(ps);
      setUrls(next);
      setQuestions(qs);
      setRegions(rs);
    }
    load().catch((e) => {
      toaster.error({
        title: "Failed to load exam structure",
        description: e instanceof Error ? e.message : String(e)
      });
    });
  }, [examId]);

  const addQuestion = useCallback((level: 1 | 2 | 3, parent: string | null) => {
    setQuestions((qs) => [
      ...qs,
      {
        id: null,
        client_id: uid(),
        parent_client_id: parent,
        level,
        ordinal: qs.filter((q) => q.level === level).length,
        label: `${level === 1 ? "Part" : level === 2 ? "Question" : "Item"} ${qs.filter((q) => q.level === level).length + 1}`,
        answer_type: "free_text",
        points: level === 3 ? 1 : 0,
        prompt: "",
        choices: [],
        correct_answer: null,
        grading_tolerance: null
      }
    ]);
  }, []);

  const updateQuestion = useCallback((cid: string, patch: Partial<EditorQuestion>) => {
    setQuestions((qs) => qs.map((q) => (q.client_id === cid ? { ...q, ...patch } : q)));
  }, []);

  const removeQuestion = useCallback((cid: string) => {
    setQuestions((qs) => {
      // collect the question and all of its transitive descendants
      const toRemove = new Set<string>([cid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const q of qs) {
          if (q.parent_client_id && toRemove.has(q.parent_client_id) && !toRemove.has(q.client_id)) {
            toRemove.add(q.client_id);
            grew = true;
          }
        }
      }
      setRegions((rs) => rs.filter((r) => !(r.question_client_id && toRemove.has(r.question_client_id))));
      return qs.filter((q) => !toRemove.has(q.client_id));
    });
  }, []);

  const normFromEvent = (e: React.PointerEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    };
  };

  const onPointerDown = (page: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = normFromEvent(e, e.currentTarget);
    drawing.current = { page, startX: x, startY: y };
    setPreview({ page, x, y, width: 0, height: 0 });
  };
  const onPointerMove = (page: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing.current || drawing.current.page !== page) return;
    const { x, y } = normFromEvent(e, e.currentTarget);
    const sx = drawing.current.startX;
    const sy = drawing.current.startY;
    setPreview({ page, x: Math.min(sx, x), y: Math.min(sy, y), width: Math.abs(x - sx), height: Math.abs(y - sy) });
  };
  const onPointerUp = (page: number) => () => {
    if (!drawing.current || !preview || preview.width < 0.01 || preview.height < 0.01) {
      drawing.current = null;
      setPreview(null);
      return;
    }
    setRegions((rs) => [
      ...rs,
      {
        client_id: uid(),
        question_client_id: draftKind === "answer" ? draftQuestion || null : null,
        kind: draftKind,
        page_number: page,
        x: preview.x,
        y: preview.y,
        width: preview.width,
        height: preview.height
      }
    ]);
    drawing.current = null;
    setPreview(null);
  };

  const removeRegion = (cid: string) => setRegions((rs) => rs.filter((r) => r.client_id !== cid));

  const leafQuestions = useMemo(() => {
    const hasChildren = new Set(questions.map((q) => q.parent_client_id).filter((p): p is string => p != null));
    return questions.filter((q) => !hasChildren.has(q.client_id));
  }, [questions]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("exam_upsert_questions_and_regions", {
        p_exam_id: examId,
        p_questions: questions.map((q) => ({
          id: q.id ?? null,
          client_id: q.client_id,
          parent_client_id: q.parent_client_id,
          level: q.level,
          ordinal: q.ordinal,
          label: q.label,
          prompt: q.prompt,
          answer_type: q.answer_type,
          choices: q.choices,
          points: q.points,
          correct_answer: q.correct_answer,
          grading_tolerance: q.grading_tolerance
        })),
        p_regions: regions.map((r) => ({
          question_client_id: r.question_client_id,
          kind: r.kind,
          page_number: r.page_number,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height
        }))
      });
      if (error) throw error;
      toaster.success({ title: "Saved exam structure" });
    } catch (e) {
      toaster.error({ title: "Save failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [examId, questions, regions]);

  const autoExtract = useCallback(async () => {
    try {
      const supabase = createClient();
      const proposal = await examExtractTemplate({ exam_id: examId }, supabase);
      if (!proposal.questions?.length && !proposal.regions?.length) {
        toaster.info({ title: "No structure proposed", description: "Draw regions manually." });
        return;
      }
      setQuestions(
        proposal.questions.map((q) => {
          const rawChoices = q.choices as unknown;
          return {
            id: null,
            client_id: q.client_id,
            parent_client_id: q.parent_client_id ?? null,
            level: q.level,
            ordinal: q.ordinal,
            label: q.label ?? "",
            answer_type: q.answer_type ?? "free_text",
            points: q.points ?? 0,
            prompt: q.prompt ?? "",
            choices: Array.isArray(rawChoices) ? rawChoices.map((c) => String(c)) : [],
            correct_answer: null,
            grading_tolerance: null
          };
        })
      );
      setRegions(
        proposal.regions.map((r) => ({
          client_id: uid(),
          question_client_id: r.question_client_id ?? null,
          kind: r.kind,
          page_number: r.page_number,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height
        }))
      );
      toaster.success({ title: "Imported proposed structure — review and save" });
    } catch (e) {
      toaster.error({ title: "Auto-extract failed", description: e instanceof Error ? e.message : String(e) });
    }
  }, [examId]);

  const buildRubric = useCallback(async () => {
    if (!gradingRubricId) {
      toaster.error({ title: "No grading rubric", description: "Create a grading rubric for this assignment first." });
      return;
    }
    const supabase = createClient();
    const { error } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId,
      p_rubric_id: gradingRubricId
    });
    if (error) toaster.error({ title: "Build rubric failed", description: error.message });
    else toaster.success({ title: "Rubric built from exam structure" });
  }, [examId, gradingRubricId]);

  return (
    <VStack align="stretch" gap={4}>
      <HStack>
        <Button size="sm" colorPalette="green" onClick={save} loading={saving}>
          Save structure
        </Button>
        <Button size="sm" variant="outline" onClick={autoExtract}>
          Auto-extract (Gemini)
        </Button>
        <Button size="sm" variant="outline" onClick={buildRubric}>
          Build rubric from exam
        </Button>
      </HStack>

      <Flex gap={6} align="flex-start" wrap="wrap">
        {/* Question tree editor */}
        <Box minW="320px" flex="1">
          <Heading size="sm" mb={2}>
            Question structure (3 levels)
          </Heading>
          <Button size="xs" mb={2} onClick={() => addQuestion(1, null)}>
            + Part (level 1)
          </Button>
          <VStack align="stretch" gap={1}>
            {questions.map((q) => (
              <HStack key={q.client_id} pl={(q.level - 1) * 4} gap={1}>
                <Text fontSize="xs" color="fg.muted">
                  L{q.level}
                </Text>
                <Input
                  size="xs"
                  value={q.label}
                  onChange={(e) => updateQuestion(q.client_id, { label: e.target.value })}
                  width="140px"
                />
                {q.level === 3 && (
                  <>
                    <NativeSelect.Root size="xs" width="120px">
                      <NativeSelect.Field
                        value={q.answer_type}
                        onChange={(e) => updateQuestion(q.client_id, { answer_type: e.target.value })}
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
                      width="60px"
                      value={q.points}
                      onChange={(e) => updateQuestion(q.client_id, { points: Number(e.target.value) })}
                    />
                  </>
                )}
                {q.level < 3 && (
                  <Button size="xs" variant="ghost" onClick={() => addQuestion((q.level + 1) as 2 | 3, q.client_id)}>
                    + child
                  </Button>
                )}
                <Button size="xs" variant="ghost" colorPalette="red" onClick={() => removeQuestion(q.client_id)}>
                  ×
                </Button>
              </HStack>
            ))}
          </VStack>
        </Box>

        {/* Drawing controls */}
        <Box minW="260px">
          <Heading size="sm" mb={2}>
            Draw a region
          </Heading>
          <Text fontSize="xs" color="fg.muted" mb={1}>
            Pick what the next drawn box represents, then drag on a page.
          </Text>
          <NativeSelect.Root size="sm" mb={2}>
            <NativeSelect.Field value={draftKind} onChange={(e) => setDraftKind(e.target.value as typeof draftKind)}>
              <option value="answer">Answer region</option>
              <option value="name">Student name region</option>
              <option value="student_id">Student ID region</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
          {draftKind === "answer" && (
            <NativeSelect.Root size="sm">
              <NativeSelect.Field value={draftQuestion} onChange={(e) => setDraftQuestion(e.target.value)}>
                <option value="">— unassigned —</option>
                {leafQuestions.map((q) => (
                  <option key={q.client_id} value={q.client_id}>
                    L{q.level} {q.label}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          )}
        </Box>
      </Flex>

      {/* Pages with overlays */}
      <VStack align="stretch" gap={6}>
        {pages.map((p) => (
          <Box key={p.page_number}>
            <Text fontSize="sm" mb={1}>
              Page {p.page_number}
            </Text>
            <Box
              position="relative"
              maxW="800px"
              userSelect="none"
              onPointerDown={onPointerDown(p.page_number)}
              onPointerMove={onPointerMove(p.page_number)}
              onPointerUp={onPointerUp(p.page_number)}
              borderWidth="1px"
              borderColor="border.emphasized"
            >
              {urls[p.page_number] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={urls[p.page_number]}
                  alt={`Template page ${p.page_number}`}
                  draggable={false}
                  style={{ width: "100%", display: "block", pointerEvents: "none" }}
                />
              ) : (
                <Box h="400px" bg="bg.subtle" />
              )}
              {regions
                .filter((r) => r.page_number === p.page_number)
                .map((r) => (
                  <Box
                    key={r.client_id}
                    position="absolute"
                    left={`${r.x * 100}%`}
                    top={`${r.y * 100}%`}
                    width={`${r.width * 100}%`}
                    height={`${r.height * 100}%`}
                    borderWidth="2px"
                    borderColor={r.kind === "answer" ? "green.500" : "purple.500"}
                    bg={r.kind === "answer" ? "green.500/10" : "purple.500/10"}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRegion(r.client_id);
                    }}
                    title="Click to remove"
                  >
                    <Text fontSize="2xs" bg="bg.panel" px={1}>
                      {r.kind === "answer"
                        ? (questions.find((q) => q.client_id === r.question_client_id)?.label ?? "answer")
                        : r.kind}
                    </Text>
                  </Box>
                ))}
              {preview && preview.page === p.page_number && (
                <Box
                  position="absolute"
                  left={`${preview.x * 100}%`}
                  top={`${preview.y * 100}%`}
                  width={`${preview.width * 100}%`}
                  height={`${preview.height * 100}%`}
                  borderWidth="2px"
                  borderStyle="dashed"
                  borderColor="blue.500"
                  pointerEvents="none"
                />
              )}
            </Box>
          </Box>
        ))}
      </VStack>
    </VStack>
  );
}
