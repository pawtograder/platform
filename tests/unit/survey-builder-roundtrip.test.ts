/**
 * The Visual Builder used to be the fastest way to destroy a survey: any question type it
 * had no editor for was rewritten as short text on load, and numeric choice values were
 * stringified to "[object Object]". Opening the builder on an existing survey and saving —
 * with no edits at all — was enough, because the builder serializes on mount.
 *
 * These tests pin the property that makes the builder safe: loading a survey and saving it
 * back must not change it. They are written as a subset check (nothing present in the source
 * may be dropped or altered) rather than strict deep equality, because the builder is allowed
 * to add SurveyJS defaults such as an explicit `isRequired: false`.
 */
import { fromJSON, toJSON } from "@/components/survey/serde";
import { cloneChoice, makeElement, nextChoiceValue } from "@/components/survey/factories";
import type { Choice } from "@/components/survey/SurveyBuilderDataTypes";
import { SURVEYJS_TEMPLATES } from "@/scripts/surveyTemplates";
import { TEAM_COLLABORATION_SURVEY } from "@/tests/fixtures/teamCollaborationSurvey";

/** A save is what the builder emits: JSON, so `undefined`-valued keys are already gone. */
function roundTrip(source: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toJSON(fromJSON(source))));
}

/**
 * Assert every value reachable in `expected` survives in `actual`. Extra keys in `actual`
 * are tolerated; missing or changed ones are not.
 */
function expectNoLoss(expected: unknown, actual: unknown, path = "$"): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArr = actual as unknown[];
    expect(actualArr).toHaveLength(expected.length);
    expected.forEach((item, i) => expectNoLoss(item, actualArr[i], `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    // A bare scalar choice ("Yes", 3) and its object form are interchangeable in SurveyJS.
    expect(typeof actual === "object" && actual !== null).toBe(true);
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      expectNoLoss(e[key], a[key], `${path}.${key}`);
    }
    return;
  }
  // Scalars must match exactly, including their JSON type: 3 and "3" are different answers.
  expect({ path, value: actual }).toEqual({ path, value: expected });
}

function questionsOf(survey: Record<string, unknown>): Record<string, unknown>[] {
  const pages = (survey.pages ?? []) as Record<string, unknown>[];
  return pages.flatMap((p) => (p.elements ?? []) as Record<string, unknown>[]);
}

describe("survey builder round trip", () => {
  const templates = Object.entries(SURVEYJS_TEMPLATES) as [string, Record<string, unknown>][];

  it("ships templates that use rating, so rating must survive", () => {
    const ratingTemplates = templates.filter(([, t]) => questionsOf(t).some((q) => q.type === "rating"));
    expect(ratingTemplates.length).toBeGreaterThan(0);
  });

  it.each(templates)("preserves every question type in the %s template", (_name, template) => {
    const sourceTypes = questionsOf(template).map((q) => q.type);
    const resultTypes = questionsOf(roundTrip(template)).map((q) => q.type);
    expect(resultTypes).toEqual(sourceTypes);
  });

  it.each(templates)("round-trips the %s template without loss", (_name, template) => {
    expectNoLoss(template, roundTrip(template));
  });

  it("round-trips the teamCollaboration fixture's numeric choices", () => {
    const result = roundTrip(TEAM_COLLABORATION_SURVEY);
    expectNoLoss(TEAM_COLLABORATION_SURVEY, result);
    // The specific corruption this replaces: numeric-valued choices became "[object Object]".
    expect(JSON.stringify(result)).not.toContain("[object Object]");
  });

  it("preserves question types the builder has no editor for", () => {
    const source = {
      title: "Unsupported types",
      pages: [
        {
          name: "page1",
          elements: [
            {
              type: "matrix",
              name: "q_matrix",
              title: "Rate each",
              columns: [1, 2, 3],
              rows: [{ value: "a", text: "Item A" }]
            },
            { type: "ranking", name: "q_rank", choices: ["one", "two"] },
            { type: "dropdown", name: "q_drop", choices: [{ value: 2, text: "Two" }] },
            { type: "nouislider", name: "q_slider", rangeMin: 0, rangeMax: 10 }
          ]
        }
      ]
    };
    expectNoLoss(source, roundTrip(source));
  });

  it("preserves a rating question's scale, both as a range and as explicit values", () => {
    const source = {
      pages: [
        {
          name: "page1",
          elements: [
            {
              type: "rating",
              name: "q_range",
              title: "How was it?",
              rateMin: 1,
              rateMax: 7,
              minRateDescription: "Bad",
              maxRateDescription: "Good"
            },
            {
              type: "rating",
              name: "q_values",
              rateValues: [
                { value: 1, text: "Strongly disagree" },
                { value: 5, text: "Strongly agree" }
              ]
            }
          ]
        }
      ]
    };
    expectNoLoss(source, roundTrip(source));
  });

  it("keeps properties the builder cannot edit, such as visibleIf and validators", () => {
    const source = {
      pages: [
        {
          name: "page1",
          elements: [
            {
              type: "text",
              name: "q_text",
              visibleIf: "{q_other} = 'yes'",
              validators: [{ type: "numeric", minValue: 0 }],
              maxLength: 40
            }
          ]
        }
      ]
    };
    expectNoLoss(source, roundTrip(source));
  });

  it("writes choices created in the builder in object form", () => {
    // surveys.test.tsx reads the saved JSON directly and maps choices to `c.value`, so a
    // choice the builder created must not be written as a bare string. Only choices that
    // ARRIVED as bare scalars keep that shape.
    const built = fromJSON({ pages: [{ name: "page1", elements: [] }] });
    built.pages[0].elements.push(makeElement("radiogroup", "q_colors"));
    const saved = JSON.parse(JSON.stringify(toJSON(built)));
    const choices = saved.pages[0].elements[0].choices;
    expect(choices.length).toBeGreaterThan(0);
    for (const c of choices) {
      expect(typeof c).toBe("object");
      expect(typeof c.value).toBe("string");
    }
  });

  describe("editing a choice value", () => {
    /** The choice a Likert template yields after import: numeric value, remembered type. */
    const numeric = (): Choice => ({ value: 3, text: "Neutral", raw: {}, valueType: "number" });

    it("keeps a numeric value numeric when retyped", () => {
      expect(nextChoiceValue(numeric(), "4")).toBe(4);
    });

    it("keeps the type across a transient empty input", () => {
      // What the instructor actually does: select-all, delete, then type. The intermediate
      // empty value must not erase the fact that this choice holds a number.
      const cleared = { ...numeric(), value: nextChoiceValue(numeric(), "") };
      expect(cleared.value).toBe("");
      expect(nextChoiceValue(cleared, "4")).toBe(4);
    });

    it("keeps boolean choices boolean", () => {
      const bool: Choice = { value: true, valueType: "boolean" };
      const cleared = { ...bool, value: nextChoiceValue(bool, "") };
      expect(nextChoiceValue(cleared, "false")).toBe(false);
    });

    it("leaves string choices as strings, including numeric-looking ones", () => {
      const str: Choice = { value: "Item 1" };
      expect(nextChoiceValue(str, "3")).toBe("3");
    });

    it("falls back to the typed text when it is not a number", () => {
      expect(nextChoiceValue(numeric(), "n/a")).toBe("n/a");
    });

    it("carries the remembered type through cloneChoice", () => {
      expect(cloneChoice(numeric()).valueType).toBe("number");
    });
  });

  it("preserves a source choice property that happens to be named raw", () => {
    const source = {
      pages: [
        {
          name: "page1",
          elements: [
            {
              type: "radiogroup",
              name: "q",
              choices: [{ value: "yes", raw: { source: "legacy" }, imageLink: "x.png" }]
            }
          ]
        }
      ]
    };
    expectNoLoss(source, roundTrip(source));
  });

  it("preserves localized choice labels instead of stringifying them", () => {
    // SurveyJS allows `text` to be a per-locale object. Coercing it with String() yields
    // "[object Object]" and destroys every translation -- the same corruption this PR fixes
    // for choice values.
    const source = {
      pages: [
        {
          name: "page1",
          elements: [
            {
              type: "radiogroup",
              name: "q",
              choices: [
                { value: "yes", text: { default: "Yes", fr: "Oui" } },
                { value: "no", text: "No" }
              ]
            }
          ]
        }
      ]
    };
    const result = roundTrip(source);
    expectNoLoss(source, result);
    expect(JSON.stringify(result)).not.toContain("[object Object]");
  });

  it("never writes the internal valueType hint into saved JSON", () => {
    const source = {
      pages: [
        {
          name: "page1",
          elements: [
            { type: "radiogroup", name: "q", choices: [{ value: 1, text: "Low" }, 2, { value: true, text: "Yes" }] }
          ]
        }
      ]
    };
    expect(JSON.stringify(roundTrip(source))).not.toContain("valueType");
    expect(JSON.stringify(roundTrip(source))).not.toContain("scalar");
  });

  it("is idempotent: saving twice changes nothing the first save did not", () => {
    for (const [, template] of templates) {
      const once = roundTrip(template);
      expect(roundTrip(once)).toEqual(once);
    }
  });
});
