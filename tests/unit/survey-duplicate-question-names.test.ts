/**
 * Duplicate question names (#1005). SurveyJS keys every answer by question name, so two questions
 * that share a name share one answer. These pin which repeats count as a collision, where each one
 * is reported, and the message the instructor sees.
 */
import {
  duplicateQuestionNamesMessage,
  findDuplicateQuestionNames,
  publishBlockedByDuplicateNames,
  sameSurveyJson
} from "@/components/survey/questionNames";

const q = (name: string, type = "text") => ({ type, name, title: name });

describe("findDuplicateQuestionNames", () => {
  it("returns nothing when every name is unique", () => {
    const json = { pages: [{ elements: [q("a"), q("b")] }, { elements: [q("c")] }] };
    expect(findDuplicateQuestionNames(json)).toEqual([]);
  });

  it("finds a name repeated across pages, which the builder's per-page default names produced", () => {
    const json = {
      pages: [{ elements: [q("question_1"), q("question_2")] }, { elements: [q("question_1", "radiogroup")] }]
    };
    expect(findDuplicateQuestionNames(json)).toEqual([
      {
        name: "question_1",
        locations: [
          { page: 1, question: 1, dynamicPanel: undefined },
          { page: 2, question: 1, dynamicPanel: undefined }
        ]
      }
    ]);
  });

  it("treats names that differ only by surrounding spaces as the same, as SurveyJS does", () => {
    const json = { pages: [{ elements: [q("q1"), q(" q1 ")] }] };
    expect(findDuplicateQuestionNames(json).map((d) => d.name)).toEqual(["q1"]);
  });

  it("is case-sensitive, as SurveyJS answer keys are", () => {
    const json = { pages: [{ elements: [q("Q1"), q("q1")] }] };
    expect(findDuplicateQuestionNames(json)).toEqual([]);
  });

  it("looks inside panels and nested panels, numbering questions in reading order", () => {
    const json = {
      pages: [
        {
          elements: [
            q("intro"),
            {
              type: "panel",
              name: "group",
              elements: [q("x"), { type: "panel", name: "inner", elements: [q("intro")] }]
            }
          ]
        }
      ]
    };
    expect(findDuplicateQuestionNames(json)).toEqual([
      {
        name: "intro",
        locations: [
          { page: 1, question: 1, dynamicPanel: undefined },
          { page: 1, question: 3, dynamicPanel: undefined }
        ]
      }
    ]);
  });

  it("does not count a panel's own name, since a panel holds no answer", () => {
    const json = { pages: [{ elements: [{ type: "panel", name: "team", elements: [q("team")] }] }] };
    expect(findDuplicateQuestionNames(json)).toEqual([]);
  });

  it("gives each dynamic panel template its own scope", () => {
    const json = {
      pages: [
        {
          elements: [
            q("name"),
            { type: "paneldynamic", name: "members", templateElements: [q("name"), q("role")] },
            { type: "paneldynamic", name: "mentors", templateElements: [q("name")] }
          ]
        }
      ]
    };
    // "name" outside the template and inside each template are stored under different keys.
    expect(findDuplicateQuestionNames(json)).toEqual([]);
  });

  it("finds a repeat inside one dynamic panel template, including in a panel within it", () => {
    const json = {
      pages: [
        {
          elements: [
            {
              type: "paneldynamic",
              name: "members",
              templateElements: [q("role"), { type: "panel", name: "p", elements: [q("role")] }]
            }
          ]
        }
      ]
    };
    expect(findDuplicateQuestionNames(json)).toEqual([
      {
        name: "role",
        locations: [
          { page: 1, question: 1, dynamicPanel: "members" },
          { page: 1, question: 2, dynamicPanel: "members" }
        ]
      }
    ]);
  });

  it("counts the dynamic panel's own name in the survey scope", () => {
    const json = {
      pages: [{ elements: [q("members"), { type: "paneldynamic", name: "members", templateElements: [q("a")] }] }]
    };
    expect(findDuplicateQuestionNames(json).map((d) => d.name)).toEqual(["members"]);
  });

  it("reads the older `questions` alias and root-level elements", () => {
    expect(findDuplicateQuestionNames({ pages: [{ questions: [q("a"), q("a")] }] }).map((d) => d.name)).toEqual(["a"]);
    expect(findDuplicateQuestionNames({ elements: [q("a"), q("a")] })).toEqual([
      {
        name: "a",
        locations: [
          { page: null, question: 1, dynamicPanel: undefined },
          { page: null, question: 2, dynamicPanel: undefined }
        ]
      }
    ]);
  });

  it("accepts a JSON string, and a JSON string stored as a jsonb string", () => {
    const json = { pages: [{ elements: [q("a"), q("a")] }] };
    expect(findDuplicateQuestionNames(JSON.stringify(json))).toHaveLength(1);
    expect(findDuplicateQuestionNames(JSON.stringify(JSON.stringify(json)))).toHaveLength(1);
  });

  it("ignores unparseable input and elements without a name", () => {
    expect(findDuplicateQuestionNames("{not json")).toEqual([]);
    expect(findDuplicateQuestionNames(null)).toEqual([]);
    expect(
      findDuplicateQuestionNames({ pages: [{ elements: [{ type: "html" }, { type: "html" }, null, 3] }] })
    ).toEqual([]);
  });
});

describe("duplicateQuestionNamesMessage", () => {
  it("names the duplicate, where each copy is, and how to fix it", () => {
    const json = { pages: [{ elements: [q("question_1")] }, { elements: [q("question_1")] }] };
    expect(duplicateQuestionNamesMessage(json)).toBe(
      'Each question needs its own name, because answers are saved under it. "question_1" is used by page 1, question 1 and page 2, question 1. Rename one of them.'
    );
  });

  it("lists every repeated name", () => {
    const json = {
      pages: [
        {
          elements: [
            q("a"),
            q("a"),
            q("a"),
            q("b"),
            { type: "paneldynamic", name: "team", templateElements: [q("b"), q("b")] }
          ]
        }
      ]
    };
    expect(duplicateQuestionNamesMessage(json)).toBe(
      'Each question needs its own name, because answers are saved under it. "a" is used by page 1, question 1; page 1, question 2; and page 1, question 3. "b" is used by question 1 of the repeating panel "team" on page 1 and question 2 of the repeating panel "team" on page 1. Rename the repeats so that no two questions share a name.'
    );
  });

  it("is null when there is nothing to fix", () => {
    expect(duplicateQuestionNamesMessage({ pages: [{ elements: [q("a")] }] })).toBeNull();
  });
});

describe("publishBlockedByDuplicateNames", () => {
  const broken = { pages: [{ elements: [q("a"), q("a")] }] };
  const fixed = { pages: [{ elements: [q("a"), q("b")] }] };

  it("allows saving a draft with duplicates", () => {
    expect(publishBlockedByDuplicateNames({ json: broken, status: "draft" })).toBeNull();
  });

  it("blocks publishing with duplicates", () => {
    expect(publishBlockedByDuplicateNames({ json: broken, status: "published" })).toMatch(/"a" is used by/);
  });

  it("allows publishing once the names are unique", () => {
    expect(publishBlockedByDuplicateNames({ json: fixed, status: "published" })).toBeNull();
  });

  it("lets an already-published survey keep its unchanged questions, whatever shape they are stored in", () => {
    const reordered = { pages: [{ elements: [{ title: "a", name: "a", type: "text" }, q("a")] }] };
    expect(
      publishBlockedByDuplicateNames({ json: JSON.stringify(reordered), status: "published", publishedJson: broken })
    ).toBeNull();
  });

  it("blocks a published survey whose questions change while a duplicate remains", () => {
    const edited = { pages: [{ elements: [q("a"), q("a"), q("c")] }] };
    expect(publishBlockedByDuplicateNames({ json: edited, status: "published", publishedJson: broken })).not.toBeNull();
  });
});

describe("sameSurveyJson", () => {
  it("compares content, not key order or encoding", () => {
    expect(sameSurveyJson({ a: 1, b: [1, { c: 2, d: 3 }] }, '{"b":[1,{"d":3,"c":2}],"a":1}')).toBe(true);
    expect(sameSurveyJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameSurveyJson("{bad", { a: 1 })).toBe(false);
  });
});
