/**
 * "Report this" on a toast with no error event behind it: the dialog captures a stand-in event on
 * Submit, never when it opens, so Cancel sends nothing (spec package 5).
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockEnsure = jest.fn((id?: string) => id ?? "s".repeat(32));
jest.mock("@/lib/bugReport/errorEventLink", () => ({
  ensureEventIdForReport: (id?: string) => mockEnsure(id)
}));
const mockSubmit = jest.fn(async (input: { eventId?: string }) => {
  void input;
  return { status: "sent" as const, feedbackId: "f".repeat(32), replay: "none" as const };
});
jest.mock("@/lib/bugReport/submitFeedback", () => ({
  submitReport: (input: { eventId?: string }) => mockSubmit(input)
}));
jest.mock("@/components/ui/live-announcer", () => ({ useAnnouncer: () => () => {} }));

import { ReportBugDialog } from "@/components/bugReport/ReportBugDialog";

function renderDialog(props: { eventId?: string; linkStandInEvent?: boolean }) {
  const onOpenChange = jest.fn();
  render(
    <ChakraProvider value={defaultSystem}>
      <ReportBugDialog open onOpenChange={onOpenChange} {...props} />
    </ChakraProvider>
  );
  return { onOpenChange };
}

beforeEach(() => {
  mockEnsure.mockClear();
  mockSubmit.mockClear();
});

it("captures nothing when it opens or is cancelled", async () => {
  const { onOpenChange } = renderDialog({ linkStandInEvent: true });
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(mockEnsure).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});

it("captures the stand-in on Submit and links the report to it", async () => {
  renderDialog({ linkStandInEvent: true });
  fireEvent.change(await screen.findByRole("textbox", { name: /What happened/ }), {
    target: { value: "the save button did nothing" }
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  });
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  expect(mockEnsure).toHaveBeenCalledTimes(1);
  expect(mockSubmit.mock.calls[0][0].eventId).toBe("s".repeat(32));
});

it("links a real event without capturing a stand-in", async () => {
  renderDialog({ eventId: "e".repeat(32) });
  fireEvent.change(await screen.findByRole("textbox", { name: /What happened/ }), { target: { value: "x" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  });
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  expect(mockEnsure).not.toHaveBeenCalled();
  expect(mockSubmit.mock.calls[0][0].eventId).toBe("e".repeat(32));
});
