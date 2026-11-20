/**
 * @jest-environment node
 */

import { generateExamPdf, type ExamPdfDrawOp, type GeneratedQuestion } from "@/lib/exam/pdfGenerate";

const TREE: GeneratedQuestion[] = [
  { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
  { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Question 1" },
  {
    client_id: "c1",
    parent_client_id: "q1",
    level: 3,
    ordinal: 0,
    label: "What is 2 + 2?",
    answer_type: "numeric"
  },
  {
    client_id: "c2",
    parent_client_id: "q1",
    level: 3,
    ordinal: 1,
    label: "Capital of France?",
    answer_type: "multiple_choice",
    choices: ["London", "Paris", "Rome"]
  },
  {
    client_id: "c3",
    parent_client_id: "q1",
    level: 3,
    ordinal: 2,
    label: "Explain.",
    answer_type: "free_text"
  }
];

function assertNormalized(r: { x: number; y: number; width: number; height: number }) {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(1.0001);
  expect(r.y + r.height).toBeLessThanOrEqual(1.0001);
  expect(r.width).toBeGreaterThan(0);
  expect(r.height).toBeGreaterThan(0);
}

describe("generateExamPdf", () => {
  it("emits one answer region per leaf plus identity regions, all normalized", async () => {
    const { bytes, regions, numPages } = await generateExamPdf(TREE);

    // it's a real PDF
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(numPages).toBeGreaterThanOrEqual(1);

    const answers = regions.filter((r) => r.kind === "answer");
    const names = regions.filter((r) => r.kind === "name");
    const ids = regions.filter((r) => r.kind === "student_id");

    // one answer per leaf with an answer_type (c1, c2, c3)
    expect(answers.map((a) => a.question_client_id).sort()).toEqual(["c1", "c2", "c3"]);
    // identity boxes once
    expect(names.length).toBe(1);
    expect(ids.length).toBe(1);
    // identity regions carry no question
    expect(names[0].question_client_id).toBeNull();
    expect(ids[0].question_client_id).toBeNull();

    for (const r of regions) {
      assertNormalized(r);
      expect(r.page_number).toBeGreaterThanOrEqual(1);
      expect(r.page_number).toBeLessThanOrEqual(numPages);
    }
  });

  it("omits identity regions when includeIdentity is false", async () => {
    const { regions } = await generateExamPdf(TREE, { includeIdentity: false });
    expect(regions.some((r) => r.kind === "name" || r.kind === "student_id")).toBe(false);
    expect(regions.filter((r) => r.kind === "answer").length).toBe(3);
  });

  it("paginates a long exam across multiple pages with valid region page numbers", async () => {
    const many: GeneratedQuestion[] = [];
    for (let i = 0; i < 40; i++) {
      many.push({
        client_id: `c${i}`,
        parent_client_id: null,
        level: 1,
        ordinal: i,
        label: `Essay question ${i}`,
        answer_type: "free_text"
      });
    }
    const { regions, numPages } = await generateExamPdf(many);
    expect(numPages).toBeGreaterThan(1);
    expect(regions.filter((r) => r.kind === "answer").length).toBe(40);
    const maxPage = Math.max(...regions.map((r) => r.page_number));
    expect(maxPage).toBe(numPages);
  });

  it("reports every box and text run through onDraw, on the page and at the place the regions say", async () => {
    const many: GeneratedQuestion[] = [];
    for (let i = 0; i < 12; i++) {
      many.push({
        client_id: `c${i}`,
        parent_client_id: null,
        level: 1,
        ordinal: i,
        label: `Essay question ${i}`,
        answer_type: "free_text"
      });
    }
    const ops: ExamPdfDrawOp[] = [];
    const { regions, numPages } = await generateExamPdf(many, { title: "Long Exam", onDraw: (op) => ops.push(op) });
    expect(numPages).toBeGreaterThan(1);

    // One rectangle per region (answer and identity boxes), each matching its region exactly.
    const rects = ops.filter((op) => op.kind === "rect");
    expect(rects).toHaveLength(regions.length);
    const [pageW, pageH] = [612, 792];
    for (const region of regions) {
      const match = rects.find(
        (r) =>
          r.page_number === region.page_number &&
          Math.abs(r.x / pageW - region.x) < 1e-9 &&
          Math.abs((pageH - r.y - r.height) / pageH - region.y) < 1e-9 &&
          Math.abs(r.width / pageW - region.width) < 1e-9 &&
          Math.abs(r.height / pageH - region.height) < 1e-9
      );
      expect(match).toBeDefined();
    }

    // Text runs: the title, the identity labels, and each label on its box's page or the page
    // before it (a label that fits at the bottom of a page is not moved with its box).
    const texts = ops.filter((op) => op.kind === "text");
    expect(texts.find((t) => t.text === "Long Exam")).toMatchObject({ page_number: 1, bold: true, size: 18 });
    expect(texts.find((t) => t.text === "Name:")).toMatchObject({ page_number: 1, bold: true });
    expect(texts.find((t) => t.text === "Student ID:")).toMatchObject({ page_number: 1, bold: true });
    for (let i = 0; i < many.length; i++) {
      const label = texts.find((t) => t.text === `Essay question ${i}`);
      const box = regions.find((r) => r.question_client_id === `c${i}`);
      expect([box!.page_number - 1, box!.page_number]).toContain(label!.page_number);
    }
    for (const op of ops) {
      expect(op.page_number).toBeGreaterThanOrEqual(1);
      expect(op.page_number).toBeLessThanOrEqual(numPages);
    }
  });
});
