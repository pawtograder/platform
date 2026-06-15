// Compile the exam_questions tree (as returned by the quiz_get_for_student RPC) into a
// SurveyJS model so an in-app quiz can be delivered with the existing <SurveyComponent>.
//
// IMPORTANT: this only ever runs on data from quiz_get_for_student, which strips the
// answer key server-side. Never feed it rows that include correct_answer.

export type StudentQuizQuestion = {
  id: number;
  parent_id: number | null;
  level: number;
  ordinal: number;
  label: string | null;
  prompt: string | null;
  answer_type: string | null;
  choices: unknown;
};

type SurveyElement = Record<string, unknown>;

/** Question name SurveyJS uses; maps back to an exam_question_id on submit. */
export function quizFieldName(examQuestionId: number): string {
  return `q_${examQuestionId}`;
}

/** Parse a SurveyJS field name back to its exam_question_id (null if not a quiz field). */
export function examQuestionIdFromField(name: string): number | null {
  const m = /^q_(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

function asChoices(choices: unknown): string[] {
  if (Array.isArray(choices)) {
    return choices.map((c) =>
      typeof c === "string"
        ? c
        : c && typeof c === "object" && "text" in c
          ? String((c as { text: unknown }).text)
          : String(c)
    );
  }
  return [];
}

/**
 * Escape text bound for a raw-HTML SurveyJS element. label/prompt are instructor- and
 * Gemini-authored and rendered as trusted HTML by the SurveyJS `html` element, so without
 * escaping a `<img src=x onerror=...>` in a question would be stored-XSS in the student's browser.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toElement(q: StudentQuizQuestion): SurveyElement {
  const name = quizFieldName(q.id);
  const title = q.label || q.prompt || `Question ${q.id}`;
  const description = q.label && q.prompt ? q.prompt : undefined;
  switch (q.answer_type) {
    case "multiple_choice":
      return { type: "radiogroup", name, title, description, choices: asChoices(q.choices) };
    case "true_false":
      return { type: "boolean", name, title, description };
    case "numeric":
      return { type: "text", name, title, description, inputType: "number" };
    case "short_answer":
      return { type: "text", name, title, description };
    default:
      return { type: "comment", name, title, description };
  }
}

/**
 * Build a SurveyJS model JSON from the question tree.
 * Level-1 questions become pages, level-2 become panels, leaves become questions.
 * Questions that have children render only their heading (no input).
 */
export function examTreeToSurveyJson(questions: StudentQuizQuestion[]): Record<string, unknown> {
  const childrenOf = new Map<number | null, StudentQuizQuestion[]>();
  for (const q of questions) {
    const key = q.parent_id ?? null;
    (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(q);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.ordinal - b.ordinal);

  const isLeaf = (q: StudentQuizQuestion) => !(childrenOf.get(q.id)?.length ?? 0);

  const renderLeafOrPanel = (q: StudentQuizQuestion): SurveyElement => {
    if (isLeaf(q)) {
      if (q.answer_type) return toElement(q);
      // a leaf with no answer type is just descriptive text
      return {
        type: "html",
        name: `h_${q.id}`,
        html: `<p><strong>${escapeHtml(q.label ?? "")}</strong> ${escapeHtml(q.prompt ?? "")}</p>`
      };
    }
    return {
      type: "panel",
      name: `panel_${q.id}`,
      title: q.label || undefined,
      description: q.prompt || undefined,
      elements: (childrenOf.get(q.id) ?? []).map(renderLeafOrPanel)
    };
  };

  const roots = childrenOf.get(null) ?? [];
  // If there are no level-1 groupings at all, put everything on one page.
  const pages = roots.length
    ? roots.map((root) => ({
        name: `page_${root.id}`,
        title: root.level === 1 ? root.label || undefined : undefined,
        elements: isLeaf(root) ? [renderLeafOrPanel(root)] : (childrenOf.get(root.id) ?? []).map(renderLeafOrPanel)
      }))
    : [];

  return { pages, showQuestionNumbers: "off" };
}
