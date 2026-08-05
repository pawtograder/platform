/**
 * Regression tests for issue #893.
 *
 * In a mastery/standards-graded course the "suggested" due date is the date that actually governs
 * a student's outcome: submit by it and you get graded and keep the right to resubmit; miss it and
 * you lose the resubmission window even though the hard `due_date` has not passed. The original
 * layout rendered that date smaller and muted above a full-weight hard deadline, which taught
 * students to work to the wrong date.
 *
 * The whole feature is gated on the `suggested-due-date` course flag. Courses that have not opted
 * in must not see the date on any surface — a half-emphasized "Suggested due:" line was the
 * confusing middle ground the flag exists to remove.
 *
 * `DueDateDisplay` stays presentational — the flag is read by the call sites and passed in as
 * `showSuggested` — so these tests drive the prop directly.
 */
import { render, screen, within } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { DueDateDisplay, RESUBMISSION_WINDOW_TOOLTIP } from "@/components/ui/due-date-display";

// The component formats through TimeZoneAwareDate, which reads the browser/course preference
// from a provider the app mounts in the course layout. Pin it so assertions are deterministic.
jest.mock("@/lib/TimeZoneProvider", () => ({
  useTimeZone: () => ({ timeZone: "America/New_York" })
}));

const SUGGESTED = "2026-03-18T23:59:00-04:00";
const HARD_DEADLINE = "2026-04-15T23:59:00-04:00";

function renderDisplay(props: React.ComponentProps<typeof DueDateDisplay>) {
  return render(
    <ChakraProvider value={defaultSystem}>
      <DueDateDisplay {...props} />
    </ChakraProvider>
  );
}

describe("DueDateDisplay", () => {
  describe("course has not enabled suggested due dates", () => {
    it("does not render the suggested date at all, even when the assignment has one", () => {
      renderDisplay({ suggestedDueDate: SUGGESTED, dueDate: HARD_DEADLINE, showDueLabel: true });

      expect(screen.queryByText(/Mar 18/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Suggested/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Resubmit until/)).not.toBeInTheDocument();
      // Only the hard deadline is shown.
      expect(screen.getByText("Due:")).toBeInTheDocument();
      expect(screen.getByText(/Apr 15, 11:59 PM/)).toBeInTheDocument();
    });

    it("renders identically whether or not a suggested date is present", () => {
      // An opted-out course must not be able to tell which assignments carry a suggested date.
      const { container: withSuggested } = renderDisplay({
        suggestedDueDate: SUGGESTED,
        dueDate: HARD_DEADLINE,
        showDueLabel: true
      });
      const { container: without } = renderDisplay({ dueDate: HARD_DEADLINE, showDueLabel: true });

      expect(withSuggested.innerHTML).toEqual(without.innerHTML);
    });

    it("fails safe when a caller forgets the flag", () => {
      // `showSuggested` defaults to false, so an un-gated call site hides the date rather than
      // leaking it into a course that never opted in.
      renderDisplay({ suggestedDueDate: SUGGESTED, dueDate: HARD_DEADLINE });

      expect(screen.queryByText(/Mar 18/)).not.toBeInTheDocument();
    });
  });

  describe("course has enabled suggested due dates", () => {
    it("presents the suggested date as the due date and demotes the hard deadline", () => {
      renderDisplay({
        suggestedDueDate: SUGGESTED,
        dueDate: HARD_DEADLINE,
        showDueLabel: true,
        showSuggested: true
      });

      // "Due:" now labels the suggested date...
      expect(screen.getByText("Due:")).toBeInTheDocument();
      expect(screen.getByText(/Mar 18, 11:59 PM/)).toBeInTheDocument();
      // ...and the hard deadline is reframed as the end of the resubmission window.
      expect(screen.getByText(/Resubmit until/)).toBeInTheDocument();
      expect(screen.getByText(/Apr 15, 11:59 PM/)).toBeInTheDocument();
      // The old advisory framing is gone: this course treats the suggested date as the due date.
      expect(screen.queryByText(/Suggested due:/)).not.toBeInTheDocument();
    });

    it("carries the distinction in text, not just size and color", () => {
      // WCAG 1.4.1: the larger/bolder styling must not be the only thing separating the two dates,
      // so both must remain distinguishable from their accessible names alone.
      renderDisplay({
        suggestedDueDate: SUGGESTED,
        dueDate: HARD_DEADLINE,
        showDueLabel: true,
        showSuggested: true
      });

      expect(screen.getByRole("button", { name: "When do resubmissions close?" })).toBeInTheDocument();
    });

    it("frames the resubmission note as course expectation, not enforcement", () => {
      // Submission enforcement only ever consults the hard `due_date`, so the tooltip must not
      // promise that submitting late forfeits the right to resubmit. Raised in review on PR #896.
      expect(RESUBMISSION_WINDOW_TOOLTIP).toMatch(/your course asks you/i);
      expect(RESUBMISSION_WINDOW_TOOLTIP).not.toMatch(/keep the option to resubmit/i);
    });

    it("is a no-op for assignments with no suggested date", () => {
      // Enabling the course flag must not change assignments that never set a suggested date.
      const { container: enabled } = renderDisplay({
        dueDate: HARD_DEADLINE,
        showDueLabel: true,
        showSuggested: true
      });
      const { container: plain } = renderDisplay({ dueDate: HARD_DEADLINE, showDueLabel: true });

      expect(enabled.innerHTML).toEqual(plain.innerHTML);
    });

    it("keeps trailing content (extension note, late-token button) with the hard deadline", () => {
      // Late tokens extend the hard deadline, not the suggested date, so the affordance has to stay
      // on the resubmission line or it reads as extending the wrong date.
      renderDisplay({
        suggestedDueDate: SUGGESTED,
        dueDate: HARD_DEADLINE,
        showSuggested: true,
        trailing: <button type="button">Extend Due Date</button>
      });

      const resubmitLine = screen.getByText(/Resubmit until/).parentElement as HTMLElement;
      expect(within(resubmitLine).getByRole("button", { name: "Extend Due Date" })).toBeInTheDocument();
    });
  });
});
