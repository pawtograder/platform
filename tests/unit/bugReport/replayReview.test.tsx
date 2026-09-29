/**
 * `useReplayReview` (package 5b): the replay slot the report dialog gets. The safety rules:
 * a replay is offered only while the recorder is recording at open; the upload sends the
 * redacted copy, never the frozen buffer; a failed redaction attaches nothing.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { setActiveRecorder } from "@/lib/bugReport/activeRecorder";
import type { BugReportRecorder, FrozenBuffer, RecorderState } from "@/lib/bugReport/types";

const redactBuffer = jest.fn();
const createReplayUpload = jest.fn();

jest.mock("@/lib/bugReport/redaction", () => ({
  redactBuffer: (...args: unknown[]) => redactBuffer(...args),
  taintSnapshot: () => [{ kind: "name", pattern: "jane doe" }]
}));
jest.mock("@/lib/bugReport/upload", () => ({
  createReplayUpload: (...args: unknown[]) => createReplayUpload(...args)
}));
// The preview pulls in the player chunk only when rendered; the hook test never renders it.
jest.mock("@/components/bugReport/ReplayPreview", () => ({ ReplayPreview: () => null }));

import { TAINT_SATURATED_WARNING, useReplayReview } from "@/components/bugReport/ReplayReview";

function frozen(tag: string): FrozenBuffer {
  return {
    replayId: "a".repeat(32),
    level: "full",
    segments: [
      {
        events: [{ type: 4, timestamp: 1, data: { href: tag, width: 1, height: 1 } }] as never,
        startTimestamp: 1,
        endTimestamp: 2,
        size: 10,
        level: "full"
      }
    ],
    startTimestamp: 1,
    endTimestamp: 2,
    urls: [],
    errorIds: [],
    traceIds: [],
    size: 10
  };
}

function fakeRecorder(state: RecorderState = "recording", saturated = false) {
  const buffer = frozen("original");
  const recorder = {
    freeze: jest.fn(() => buffer),
    getState: () => state,
    isTaintSaturated: () => saturated,
    stop: jest.fn()
  } as unknown as BugReportRecorder & { freeze: jest.Mock; stop: jest.Mock };
  return { recorder, buffer };
}

beforeEach(() => {
  redactBuffer.mockReset();
  createReplayUpload.mockReset();
  setActiveRecorder(undefined);
});

describe("useReplayReview", () => {
  it("offers no replay without a recorder, or while it is paused", () => {
    const { result, rerender } = renderHook(({ open }) => useReplayReview(open), { initialProps: { open: true } });
    expect(result.current).toBeNull();
    const { recorder } = fakeRecorder("paused");
    act(() => setActiveRecorder(recorder));
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current).toBeNull();
    expect(recorder.freeze).not.toHaveBeenCalled();
  });

  it("freezes once at open and uploads the redacted copy, not the frozen buffer", async () => {
    const { recorder, buffer } = fakeRecorder();
    setActiveRecorder(recorder);
    const redacted = frozen("redacted");
    redactBuffer.mockResolvedValue({
      buffer: redacted,
      remaining: [],
      stats: { textNodes: 0, redactedSpans: 0, ms: 1 }
    });
    const upload = jest.fn().mockResolvedValue({ ok: true, replayId: buffer.replayId });
    createReplayUpload.mockReturnValue({ upload });

    const { result } = renderHook(() => useReplayReview(true));
    await waitFor(() => expect(redactBuffer).toHaveBeenCalledTimes(1));
    expect(recorder.freeze).toHaveBeenCalledTimes(1);
    expect(redactBuffer.mock.calls[0][0]).toBe(buffer);
    expect(redactBuffer.mock.calls[0][1]).toMatchObject({ taintPatterns: [{ kind: "name", pattern: "jane doe" }] });
    expect(result.current?.upload).not.toBeNull();

    const outcome = await act(() => result.current!.upload!.upload({ contact_ok: "false" }));
    expect(outcome).toEqual({ ok: true, replayId: buffer.replayId });
    expect(createReplayUpload).toHaveBeenCalledWith(redacted);
    expect(createReplayUpload).not.toHaveBeenCalledWith(buffer);
    expect(upload).toHaveBeenCalledWith({ contact_ok: "false" });
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it("attaches nothing when redaction fails, and never uploads the frozen buffer", async () => {
    const { recorder } = fakeRecorder();
    setActiveRecorder(recorder);
    redactBuffer.mockRejectedValue(new Error("worker crashed"));
    const { result } = renderHook(() => useReplayReview(true));
    await waitFor(() => expect(result.current?.upload).toBeNull());
    expect(result.current?.review).toBeTruthy();
    expect(createReplayUpload).not.toHaveBeenCalled();
  });

  it("drops the replay when the dialog closes, and keeps the recorder running", async () => {
    const { recorder } = fakeRecorder();
    setActiveRecorder(recorder);
    redactBuffer.mockResolvedValue({
      buffer: frozen("r"),
      remaining: [],
      stats: { textNodes: 0, redactedSpans: 0, ms: 1 }
    });
    const { result, rerender } = renderHook(({ open }) => useReplayReview(open), { initialProps: { open: true } });
    await waitFor(() => expect(redactBuffer).toHaveBeenCalled());
    rerender({ open: false });
    expect(result.current).toBeNull();
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(createReplayUpload).not.toHaveBeenCalled();
  });

  describe("taint set saturation", () => {
    function Review() {
      return <>{useReplayReview(true)?.review}</>;
    }

    async function renderReview(saturated: boolean) {
      const { recorder } = fakeRecorder("recording", saturated);
      setActiveRecorder(recorder);
      redactBuffer.mockResolvedValue({
        buffer: frozen("r"),
        remaining: [{ value: "Some page text", kind: "text", count: 1 }],
        stats: { textNodes: 1, redactedSpans: 0, ms: 1 }
      });
      render(
        <ChakraProvider value={defaultSystem}>
          <Review />
        </ChakraProvider>
      );
      await screen.findByText("Some page text");
    }

    it("warns in a status region with the review when the taint set is saturated", async () => {
      await renderReview(true);
      const warning = screen.getByTestId("report-bug-taint-saturated");
      expect(warning).toHaveTextContent(TAINT_SATURATED_WARNING);
      expect(warning).toHaveAttribute("role", "status");
      expect(screen.getByTestId("report-bug-replay-review")).toContainElement(warning);
    });

    it("shows no warning when it isn't", async () => {
      await renderReview(false);
      expect(screen.queryByTestId("report-bug-taint-saturated")).toBeNull();
    });
  });
});
