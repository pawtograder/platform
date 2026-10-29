/**
 * Regression tests for issue #1002.
 *
 * The visual builder writes a placeholder `"title": "Survey Name"` into the survey
 * JSON, and SurveyJS renders that title. The survey list and the preview dialog show
 * the database title, so the opened survey disagreed with the list. Both renderers take
 * the database title as a `title` prop, and it wins over the JSON title.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import SurveyComponent from "@/components/Survey";
import ViewSurveyResponse from "@/components/ViewSurveyResponse";

jest.mock("@/components/ui/color-mode", () => ({
  useColorMode: () => ({ colorMode: "light", setColorMode: jest.fn(), toggleColorMode: jest.fn() })
}));
jest.mock("survey-core/survey-core.css", () => ({}));
jest.mock("survey-core/survey-core.min.css", () => ({}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const DB_TITLE = "Week 3 Check-in";
const JSON_TITLE = "Survey Name";

const builderJson = () => ({
  title: JSON_TITLE,
  pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
});

describe("survey title (issue #1002)", () => {
  it("SurveyComponent shows the database title instead of the JSON title", () => {
    const json = builderJson();
    render(<SurveyComponent surveyJson={json} title={DB_TITLE} />);

    // The survey title is the page's top heading; question titles are h2s below it.
    expect(screen.getByRole("heading", { level: 1, name: DB_TITLE })).toBeInTheDocument();
    expect(screen.queryByText(JSON_TITLE)).not.toBeInTheDocument();
    // The stored definition is left alone.
    expect(json.title).toBe(JSON_TITLE);
  });

  it("SurveyComponent shows the database title when the JSON has none", () => {
    render(<SurveyComponent surveyJson={{ pages: builderJson().pages }} title={DB_TITLE} />);

    expect(screen.getByRole("heading", { name: DB_TITLE })).toBeInTheDocument();
  });

  it("SurveyComponent keeps the JSON title when no database title is given", () => {
    render(<SurveyComponent surveyJson={builderJson()} />);

    expect(screen.getByRole("heading", { name: JSON_TITLE })).toBeInTheDocument();
  });

  it("SurveyComponent renaming the survey mid-answer keeps the answers and focus", () => {
    // An instructor renaming the survey reaches an open student page as a realtime
    // update with a new `title`. Rebuilding the model for it would throw away the
    // answers typed so far, the page position and the focused field.
    const json = builderJson();
    const { rerender } = render(<SurveyComponent surveyJson={json} title={DB_TITLE} />);
    const input = screen.getByRole("textbox", { name: "Question 1" }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "Going well" } });

    rerender(<SurveyComponent surveyJson={json} title="Week 3 Check-in (revised)" />);

    expect(screen.getByRole("heading", { level: 1, name: "Week 3 Check-in (revised)" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Question 1" })).toHaveValue("Going well");
    expect(screen.getByRole("textbox", { name: "Question 1" })).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("ViewSurveyResponse shows the database title instead of the JSON title", () => {
    const json = builderJson();
    render(<ViewSurveyResponse surveyJson={json} responseData={{ q1: "Going well" }} title={DB_TITLE} />);

    // Its callers already show the title as a heading, so this one stays plain text.
    expect(screen.getByText(DB_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(JSON_TITLE)).not.toBeInTheDocument();
    expect(json.title).toBe(JSON_TITLE);
  });
});
