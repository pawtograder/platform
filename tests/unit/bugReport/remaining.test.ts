/**
 * The remaining-strings list on events from the real rrweb recorder (jsdom): adjacent inline
 * elements are listed with a space between them, in the snapshot and when added later, and
 * rrweb's own placeholder strings are never listed.
 */
import { record } from "@sentry-internal/rrweb";
import { redactBuffer } from "@/lib/bugReport/redaction";
import type { FrozenBuffer, RecordedEvent } from "@/lib/bugReport/types";

async function recordWhile(change: () => void): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [];
  const stop = record<RecordedEvent>({
    emit: (e) => events.push(e),
    maskAllText: true,
    unmaskTextSelector: "[data-report-unmask]",
    maskTextFn: (t: string) => t.replace(/\S/g, "*"),
    slimDOMOptions: "all"
  });
  change();
  // rrweb flushes mutations on a microtask; a timeout is after it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop?.();
  return events;
}

function bufferOf(events: RecordedEvent[]): FrozenBuffer {
  return {
    replayId: "0".repeat(32),
    level: "full",
    segments: [{ events, startTimestamp: 0, endTimestamp: 1, size: 1, level: "full" }],
    startTimestamp: 0,
    endTimestamp: 1,
    urls: [],
    errorIds: [],
    traceIds: [],
    size: 1
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("lists adjacent links with a space, in the snapshot and when added later, and never rrweb placeholders", async () => {
  document.body.innerHTML =
    '<div data-report-unmask=""><a href="mailto:x@example.test">Email the student</a><a href="?s=1">Profile link</a></div>' +
    "<script>void 0;</script>";
  const events = await recordWhile(() => {
    const later = document.createElement("div");
    later.setAttribute("data-report-unmask", "");
    later.innerHTML = '<a href="mailto:x@example.test">Later email</a><a href="?s=1">Later link</a>';
    document.body.appendChild(later);
    // A script added after the snapshot: rrweb records its text as SCRIPT_PLACEHOLDER under an
    // ignored parent.
    const script = document.createElement("script");
    script.textContent = "void 1;";
    document.body.appendChild(script);
  });
  expect(JSON.stringify(events)).toContain("SCRIPT_PLACEHOLDER");
  const { remaining } = await redactBuffer(bufferOf(events), { taintPatterns: [] });
  const texts = remaining.filter((r) => r.kind === "text").map((r) => r.value);
  expect(texts).toEqual(expect.arrayContaining(["Email the student Profile link", "Later email Later link"]));
  expect(texts.some((t) => /studentProfile|emailLater/.test(t))).toBe(false);
  expect(remaining.some((r) => r.value.includes("SCRIPT_PLACEHOLDER"))).toBe(false);
});
