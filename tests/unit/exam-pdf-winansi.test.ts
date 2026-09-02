import { generateExamPdf, type GeneratedQuestion } from "@/lib/exam/pdfGenerate";

const q = (over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
  client_id: "c1",
  parent_client_id: null,
  level: 1,
  ordinal: 0,
  label: "Q1",
  prompt: "What is 2+2?",
  answer_type: "numeric",
  ...over
});

describe("generateExamPdf WinAnsi validation", () => {
  it("generates a PDF for ordinary Western text", async () => {
    const { bytes } = await generateExamPdf([q()], { title: "Midterm — Part 1 (café)" });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects un-encodable characters, naming them, instead of throwing from drawText", async () => {
    await expect(generateExamPdf([q({ prompt: "翻译这句话" })], { title: "Quiz" })).rejects.toThrow(
      /cannot render these character\(s\)/
    );
  });

  it("reports the offending character rather than a generic pdf-lib message", async () => {
    await expect(generateExamPdf([q({ label: "Q🎉" })], { title: "Quiz" })).rejects.toThrow(/🎉/);
  });

  it("checks choices too", async () => {
    await expect(
      generateExamPdf([q({ answer_type: "multiple_choice", choices: ["fine", "Кириллица"] })], { title: "Quiz" })
    ).rejects.toThrow(/cannot render these character\(s\)/);
  });
});

describe("generateExamPdf answer-box sizing", () => {
  const q = (over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
    client_id: "c1",
    parent_client_id: null,
    level: 1,
    ordinal: 0,
    label: "Q1",
    prompt: "Pick one",
    answer_type: "multiple_choice",
    ...over
  });

  it("rejects a choice list whose answer box cannot fit on a page", async () => {
    // 18pt per choice: ~40 choices exceeds a 792pt page's printable height.
    const choices = Array.from({ length: 60 }, (_, i) => `Option ${i + 1}`);
    await expect(generateExamPdf([q({ choices })], { title: "Quiz" })).rejects.toThrow(
      /answer block .* needs \d+pt but a page only provides/
    );
  });

  it("still generates a normal-sized choice list", async () => {
    const choices = ["A", "B", "C", "D"];
    const { bytes, regions } = await generateExamPdf([q({ choices })], { title: "Quiz" });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.height).toBeLessThanOrEqual(1);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });
});
