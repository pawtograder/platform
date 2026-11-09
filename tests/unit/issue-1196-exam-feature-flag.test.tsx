/**
 * #1196: paper exam grading is behind the `exams` course feature flag.
 *
 * The property that matters is the default. Exam grading lands as one large feature across ten
 * PRs, and the flag only does its job if a course that never opted in reads as "off" -- so the
 * `features` column being absent, empty, or holding some other course's entries must all come
 * back false. Flipping `defaultWhenMissing` to true would turn scanning, OCR and the Gemini
 * calls on for every course at once, and that is what these tests are here to catch.
 *
 * Lives under tests/unit/issue* so the e2e-local lane runs it (lint.yml's jest-unit-tests job
 * runs an explicit file list, not a glob). It needs no database, so it has no
 * RUN_SUPABASE_INTEGRATION_TESTS gate.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { ExamFeatureGate } from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/ExamFeatureGate";
import { COURSE_FEATURES, courseFeatureEnabled, MANAGEABLE_COURSE_FEATURES } from "@/lib/courseFeatures";

const mockUseCourse = jest.fn();

jest.mock("@/hooks/useCourseController", () => ({
  useCourse: () => mockUseCourse()
}));

function mockFeatures(features: { name: string; enabled: boolean }[] | null) {
  mockUseCourse.mockReturnValue({ features });
}

/** The off-branch renders Chakra components, which need a provider in jsdom. */
function renderGate() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <ExamFeatureGate>
        <div>Exam scan upload</div>
      </ExamFeatureGate>
    </ChakraProvider>
  );
}

describe("issue #1196: the exams flag defaults to off", () => {
  it("a course with no features column does not get exam grading", () => {
    expect(courseFeatureEnabled(null, COURSE_FEATURES.EXAMS)).toBe(false);
  });

  it("a course with an empty features array does not get exam grading", () => {
    expect(courseFeatureEnabled([], COURSE_FEATURES.EXAMS)).toBe(false);
  });

  it("other courses' flags don't turn exams on by accident", () => {
    const features = [
      { name: COURSE_FEATURES.SURVEYS, enabled: true },
      { name: COURSE_FEATURES.GRADEBOOK, enabled: true }
    ];
    expect(courseFeatureEnabled(features, COURSE_FEATURES.EXAMS)).toBe(false);
  });

  it("opting in turns it on", () => {
    expect(courseFeatureEnabled([{ name: COURSE_FEATURES.EXAMS, enabled: true }], COURSE_FEATURES.EXAMS)).toBe(true);
  });

  it("the flag is listed for instructors to manage, and declares itself off by default", () => {
    const entry = MANAGEABLE_COURSE_FEATURES.find((f) => f.name === COURSE_FEATURES.EXAMS);
    expect(entry).toBeDefined();
    expect(entry?.defaultWhenMissing).toBe(false);
    // Graders reach the exam pages too, so hiding it from students only would leave the nav entry
    // in place for exactly the people the feature is for.
    expect(entry?.navAffectsStaff).toBe(true);
  });
});

describe("issue #1196: ExamFeatureGate", () => {
  beforeEach(() => {
    mockUseCourse.mockReset();
  });

  it("renders the page when the course opted in", () => {
    mockFeatures([{ name: COURSE_FEATURES.EXAMS, enabled: true }]);
    renderGate();
    expect(screen.getByText("Exam scan upload")).toBeInTheDocument();
  });

  it("replaces the page with a notice when the flag is off", () => {
    mockFeatures([{ name: COURSE_FEATURES.EXAMS, enabled: false }]);
    renderGate();
    expect(screen.queryByText("Exam scan upload")).not.toBeInTheDocument();
    expect(screen.getByText(/not enabled for this course/i)).toBeInTheDocument();
  });

  it("a course that never opted in gets the notice, not the page", () => {
    mockFeatures(null);
    renderGate();
    expect(screen.queryByText("Exam scan upload")).not.toBeInTheDocument();
    expect(screen.getByText(/not enabled for this course/i)).toBeInTheDocument();
  });
});

describe("issue #1196: the nav entry stays behind the flag", () => {
  // The nav builds its items from a module-private array, so there is nothing to import and call.
  // Rendering the whole component would mean standing up the assignment controller, class
  // profiles and the router for one assertion. This reads the source instead: it is coarse, and
  // it only proves the entry is still tagged -- but that is the regression worth catching, since
  // deleting the tag is a one-line change that no other test in the repo would notice.
  const NAV = join(
    __dirname,
    "..",
    "..",
    "app",
    "course",
    "[course_id]",
    "manage",
    "assignments",
    "[assignment_id]",
    "ManageAssignmentNav.tsx"
  );
  const source = readFileSync(NAV, "utf8");

  it("the Exam (Scan & OCR) entry declares the exams feature", () => {
    const examEntry = source.slice(source.indexOf('label: "Exam (Scan & OCR)"'));
    expect(examEntry.slice(0, examEntry.indexOf("},"))).toContain("feature: COURSE_FEATURES.EXAMS");
  });

  it("the nav filters on an item's feature", () => {
    expect(source).toContain("!item.feature || courseFeatureEnabled(courseFeatures, item.feature)");
  });
});

describe("issue #1196: the new-assignment form only offers Paper exam where it works", () => {
  // The assignment type can't be changed after creation, so creating a Paper exam in a course
  // that hasn't opted in leaves an assignment whose every route is the "not enabled" notice,
  // with no way back. This pins that rule.
  //
  // Read as source for the same reason as the nav assertions above: rendering this form means
  // standing up react-hook-form, refine's data provider, the course controller, class profiles
  // and the table controllers. Coarse, and it only proves the wiring is still there -- but
  // dropping either line is a one-line change nothing else would catch.
  const FORM = join(__dirname, "..", "..", "app", "course", "[course_id]", "manage", "assignments", "new", "form.tsx");
  const source = readFileSync(FORM, "utf8");

  it("the exam option is disabled unless the type is available", () => {
    expect(source).toContain('<option value="exam" disabled={!examTypeAvailable}>');
  });

  it("an existing assignment keeps the option, so editing still shows its own type", () => {
    // isEditing has to come first: the select is disabled while editing, and an exam assignment
    // in a course that later turned the flag off must still render its own value.
    expect(source).toContain("const examTypeAvailable = isEditing || examsEnabled;");
  });

  it("the flag is read live, through the course controller", () => {
    expect(source).toContain("useFeatureEnabled(COURSE_FEATURES.EXAMS)");
  });
});
