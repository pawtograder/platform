/**
 * Regression tests for the survey description in response views (issue #1002 follow-up).
 *
 * `ViewSurveyResponse` hides the SurveyJS title because both callers show the database
 * title as their own heading. SurveyJS only renders the survey description inside its
 * title block, so hiding the title also dropped the description: the submission Survey
 * panel showed none at all, and the response page lost a JSON description that differs
 * from the database description it shows itself.
 */
import type { ReactNode } from "react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { render as renderRaw, screen } from "@testing-library/react";
import ViewSurveyResponse from "@/components/ViewSurveyResponse";

jest.mock("@/components/ui/color-mode", () => ({
  useColorMode: () => ({ colorMode: "light", setColorMode: jest.fn(), toggleColorMode: jest.fn() })
}));
jest.mock("survey-core/survey-core.min.css", () => ({}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function render(ui: ReactNode) {
  return renderRaw(<ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>);
}

const JSON_TITLE = "Survey Name";
const JSON_DESCRIPTION = "Answer for the week you just finished.";

const builderJson = () => ({
  title: JSON_TITLE,
  description: JSON_DESCRIPTION,
  pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
});

describe("ViewSurveyResponse description", () => {
  it("shows the JSON description once, without the JSON title", () => {
    // The submission Survey panel passes no description of its own.
    render(<ViewSurveyResponse surveyJson={builderJson()} responseData={{ q1: "Going well" }} />);

    expect(screen.getByRole("textbox", { name: "Question 1" })).toHaveValue("Going well");
    expect(screen.getAllByText(JSON_DESCRIPTION)).toHaveLength(1);
    expect(screen.queryByText(JSON_TITLE)).not.toBeInTheDocument();
  });

  it("does not repeat a description the caller already shows", () => {
    // The response page shows the database description above the response. When the
    // JSON description says the same thing, it must appear once on the page.
    render(
      <>
        <p>{JSON_DESCRIPTION}</p>
        <ViewSurveyResponse
          surveyJson={builderJson()}
          responseData={{ q1: "Going well" }}
          shownDescription={JSON_DESCRIPTION}
        />
      </>
    );

    expect(screen.getAllByText(JSON_DESCRIPTION)).toHaveLength(1);
    expect(screen.queryByText(JSON_TITLE)).not.toBeInTheDocument();
  });

  it("shows a JSON description that differs from the caller's", () => {
    const dbDescription = "Weekly reflection for the team project.";
    render(
      <>
        <p>{dbDescription}</p>
        <ViewSurveyResponse
          surveyJson={builderJson()}
          responseData={{ q1: "Going well" }}
          shownDescription={dbDescription}
        />
      </>
    );

    expect(screen.getAllByText(dbDescription)).toHaveLength(1);
    expect(screen.getAllByText(JSON_DESCRIPTION)).toHaveLength(1);
  });

  it("leaves the caller's description to the caller when the JSON has none", () => {
    render(
      <ViewSurveyResponse
        surveyJson={{ pages: builderJson().pages }}
        responseData={{ q1: "Going well" }}
        shownDescription="Weekly reflection for the team project."
      />
    );

    expect(screen.getByRole("textbox", { name: "Question 1" })).toHaveValue("Going well");
    expect(screen.queryByText("Weekly reflection for the team project.")).not.toBeInTheDocument();
  });
});
