/**
 * The plain-HTML report form on app/global-error.tsx: its status and alert live regions are
 * in the page, empty, before the outcome is known, so screen readers announce the text when
 * it arrives; and focus moves to the message instead of falling to <body>.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";

jest.mock("@sentry/nextjs", () => ({
  getClient: () => ({ getDsn: () => ({ host: "sentry.test" }), on: () => () => {} }),
  captureException: () => "e".repeat(32)
}));

type Result =
  | { status: "sent"; feedbackId: string; replay: "none" }
  | { status: "rate_limited" }
  | { status: "error"; message: string };
let resolveSubmit: ((r: Result) => void) | undefined;
let rejectSubmit: ((e: Error) => void) | undefined;
jest.mock("@/lib/bugReport/submitFeedback", () => ({
  submitReport: () =>
    new Promise((resolve, reject) => {
      resolveSubmit = resolve;
      rejectSubmit = reject;
    })
}));

import GlobalError from "@/app/global-error";

let errors: jest.SpyInstance;
beforeEach(() => {
  // GlobalError renders its own <html>; React warns about mounting that inside a div.
  errors = jest.spyOn(console, "error").mockImplementation(() => {});
  resolveSubmit = undefined;
  rejectSubmit = undefined;
});
afterEach(() => errors.mockRestore());

function setup() {
  render(<GlobalError error={new Error("boom")} />);
  const status = screen.getByRole("status");
  const alert = screen.getByRole("alert");
  const button = screen.getByRole("button", { name: "Send report" });
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "It broke" } });
  button.focus();
  fireEvent.submit(screen.getByRole("form", { name: "Report this error" }));
  expect(button).toBeDisabled();
  return { status, alert };
}

it("renders both live regions empty before anything is sent", () => {
  render(<GlobalError error={new Error("boom")} />);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

it("fills the existing status region on success and moves focus to it", async () => {
  const { status } = setup();
  await act(async () => resolveSubmit!({ status: "sent", feedbackId: "f".repeat(32), replay: "none" }));
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Thanks, your report was sent.");
  expect(status).toHaveAttribute("tabindex", "-1");
  expect(document.activeElement).toBe(status);
  expect(screen.queryByRole("form")).toBeNull();
});

it.each([
  ["an error result", () => resolveSubmit!({ status: "error", message: "Something failed." }), "Something failed."],
  ["a rate limit", () => resolveSubmit!({ status: "rate_limited" }), "Too many reports are being sent right now."],
  ["a thrown error", () => rejectSubmit!(new Error("network")), "The report did not go through. Try again."]
])("fills the existing alert region on %s and moves focus to it", async (_name, settle, text) => {
  const { alert, status } = setup();
  await act(async () => settle());
  expect(screen.getByRole("alert")).toBe(alert);
  expect(alert).toHaveTextContent(text);
  expect(document.activeElement).toBe(alert);
  expect(status).toBeEmptyDOMElement();
  // The form stays, so the user can try again.
  expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
});
