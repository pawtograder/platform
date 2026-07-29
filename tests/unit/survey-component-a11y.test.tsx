/**
 * Regression tests for issue #881 findings 1 + 2.
 *
 * Real-VoiceOver soak testing found that text answers on the survey-taking page
 * could not be entered: with `document.activeElement` verified as the correct
 * `<input>`, both per-character typing and paste ended up with `value=""`.
 *
 * Both findings trace back to <SurveyComponent>:
 *
 *   1. The SurveyJS `Model` was memoized on the *identity* of the `surveyJson`
 *      prop. That prop is a JSONB column on a TableController row, so a no-op
 *      realtime refetch produced a new object and rebuilt the whole model,
 *      remounting every question and discarding focus / the screen-reader
 *      cursor.
 *   2. `initialData` was applied on every identity change with
 *      `survey.data = initialData`, which is destructive in survey-core
 *      (`valuesHash = {}` then re-seed). Because SurveyJS text inputs are
 *      uncontrolled and get written back imperatively, that silently replaced
 *      whatever the user had typed into the focused field.
 */
import { render, fireEvent } from "@testing-library/react";
import SurveyComponent from "@/components/Survey";

// The component only needs a color mode; the real hook pulls in next-themes.
jest.mock("@/components/ui/color-mode", () => ({
  useColorMode: () => ({ colorMode: "light", setColorMode: jest.fn(), toggleColorMode: jest.fn() })
}));

// survey-core ships its stylesheet as a side-effect import.
jest.mock("survey-core/survey-core.css", () => ({}));

// survey-core's scroll view model observes its root element on mount; jsdom has
// no ResizeObserver.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SURVEY_JSON = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "text", name: "q1", title: "What is your name?", isRequired: true },
        {
          type: "radiogroup",
          name: "q2",
          title: "How is the course pace?",
          choices: ["Too slow", "Just right", "Too fast"]
        }
      ]
    }
  ]
};

/** The <input> survey-core rendered for q1. */
function q1Input(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="text"]');
  if (!input) throw new Error("q1 text input not rendered");
  return input as HTMLInputElement;
}

describe("SurveyComponent (issue #881)", () => {
  it("does not rebuild the model when surveyJson changes identity but not content", () => {
    const { container, rerender } = render(<SurveyComponent surveyJson={SURVEY_JSON} />);
    const idBefore = q1Input(container).id;

    // Exactly what a TableController refetch hands down: a structurally equal
    // but freshly-allocated object.
    rerender(<SurveyComponent surveyJson={JSON.parse(JSON.stringify(SURVEY_JSON))} />);

    expect(q1Input(container).id).toBe(idBefore);
  });

  it("rebuilds the model when the survey definition actually changes", () => {
    const { container, rerender } = render(<SurveyComponent surveyJson={SURVEY_JSON} />);
    const idBefore = q1Input(container).id;

    const edited = JSON.parse(JSON.stringify(SURVEY_JSON));
    edited.pages[0].elements[0].title = "What is your full name?";
    rerender(<SurveyComponent surveyJson={edited} />);

    expect(q1Input(container).id).not.toBe(idBefore);
  });

  it("seeds a saved draft into the form", () => {
    const { container } = render(<SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "Ada Lovelace" }} />);
    expect(q1Input(container).value).toBe("Ada Lovelace");
  });

  it("re-applying a value-equal draft does not disturb the field", () => {
    const { container, rerender } = render(
      <SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "Ada Lovelace" }} />
    );
    const input = q1Input(container);
    input.focus();

    // Same content, new object — the shape every refetch produces.
    rerender(<SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "Ada Lovelace" }} />);

    expect(q1Input(container).value).toBe("Ada Lovelace");
    expect(document.activeElement).toBe(input);
  });

  it("does not overwrite in-progress typing when a saved draft arrives late", () => {
    // The page renders the survey before the student's saved response has been
    // fetched, so `initialData` starts undefined and lands a moment later.
    const { container, rerender } = render(<SurveyComponent surveyJson={SURVEY_JSON} initialData={undefined} />);

    const input = q1Input(container);
    input.focus();
    fireEvent.change(input, { target: { value: "Ada Lovelace" } });
    expect(input.value).toBe("Ada Lovelace");

    // Draft fetch resolves with the older server-side value.
    rerender(<SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "STALE-SERVER-VALUE" }} />);

    expect(q1Input(container).value).toBe("Ada Lovelace");
    expect(document.activeElement).toBe(input);
  });

  it("applies a genuinely different draft when the user has not edited anything", () => {
    // The guard protects in-progress answers, not every later assignment: a
    // viewer swapping between saved responses must still update.
    const { container, rerender } = render(
      <SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "Ada Lovelace" }} />
    );
    expect(q1Input(container).value).toBe("Ada Lovelace");

    rerender(<SurveyComponent surveyJson={SURVEY_JSON} initialData={{ q1: "Grace Hopper" }} />);

    expect(q1Input(container).value).toBe("Grace Hopper");
  });

  it("commits typed text to the model without waiting for a blur", () => {
    // Under the SurveyJS default (textUpdateMode "onBlur") typed text stays out
    // of `survey.data`, so autosave never sees it and any model->DOM sync wipes
    // it. onValueChanged firing while the field is still focused is what makes
    // the answer durable for AT users who navigate away without a blur.
    const onValueChanged = jest.fn();
    const { container } = render(<SurveyComponent surveyJson={SURVEY_JSON} onValueChanged={onValueChanged} />);

    const input = q1Input(container);
    input.focus();
    fireEvent.change(input, { target: { value: "Ada" } });

    expect(onValueChanged).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
