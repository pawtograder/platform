import { formatResponseValue, getValueLabelsFromSurveyJson } from "@/components/survey/analytics/utils";
import { TEAM_COLLABORATION_SURVEY } from "@/tests/fixtures/teamCollaborationSurvey";
import type { Json } from "@/utils/supabase/SupabaseTypes";

describe("formatResponseValue", () => {
  const likert: Record<number, string> = {
    1: "Strongly disagree",
    2: "Disagree",
    3: "Neither agree nor disagree",
    4: "Agree",
    5: "Strongly agree"
  };

  it("maps numeric choice values through valueLabels", () => {
    expect(formatResponseValue(4, likert)).toBe("Agree");
  });

  it("maps string choice values through valueLabels (JSON / SurveyJS string storage)", () => {
    expect(formatResponseValue("4", likert)).toBe("Agree");
  });

  it("maps { value } objects through valueLabels when text is absent", () => {
    expect(formatResponseValue({ value: 4 }, likert)).toBe("Agree");
  });

  it("prefers obj.text when present", () => {
    expect(formatResponseValue({ value: 4, text: "Custom" }, likert)).toBe("Custom");
  });

  it("leaves free-text strings unchanged when valueLabels is empty", () => {
    expect(formatResponseValue("We collaborated well this week.", {})).toBe("We collaborated well this week.");
  });

  it("formats checkbox arrays with string and numeric elements", () => {
    const q1Labels: Record<number, string> = {
      1: "Completed all my assigned tasks",
      2: "Asked a teammate for help"
    };
    expect(formatResponseValue(["1", 2], q1Labels)).toBe("Completed all my assigned tasks, Asked a teammate for help");
  });

  it("renders null and undefined as em dash", () => {
    expect(formatResponseValue(null, likert)).toBe("—");
    expect(formatResponseValue(undefined, likert)).toBe("—");
  });

  it("falls back to raw value when label is missing", () => {
    expect(formatResponseValue(99, likert)).toBe("99");
    expect(formatResponseValue({ value: 99 }, likert)).toBe("99");
  });
});

describe("getValueLabelsFromSurveyJson", () => {
  const json = TEAM_COLLABORATION_SURVEY as unknown as Json;

  it("extracts Likert labels for TEAM_COLLABORATION_SURVEY q3 via Model", () => {
    const labels = getValueLabelsFromSurveyJson(json, "q3");
    expect(labels[4]).toBe("Agree");
    expect(labels[1]).toBe("Strongly disagree");
    expect(Object.keys(labels).length).toBe(5);
  });

  it("extracts checkbox labels for q1 (unordered choice values)", () => {
    const labels = getValueLabelsFromSurveyJson(json, "q1");
    expect(labels[1]).toBe("Completed all my assigned tasks");
    expect(labels[4]).toBe("Completed some of my assigned tasks");
  });

  it("returns {} for comment questions", () => {
    expect(getValueLabelsFromSurveyJson(json, "q15")).toEqual({});
  });
});
