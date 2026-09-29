/**
 * The pre-start fetch buffer arms only when the server rendered the course flag as on and the
 * route is listed. With the flag off nothing is armed, so no response is ever cloned.
 */
import { render } from "@testing-library/react";
import { armFromRecordingMarker, BugReportIngestArm } from "@/components/bugReport/BugReportIngestArm";
import { disarmIngest, isIngestArmed } from "@/lib/bugReport/ingestGate";

let pathname = "/course/7/discussion";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));

beforeAll(() => {
  // jsdom has no fetch; the hook wraps whatever is there.
  (window as unknown as { fetch: unknown }).fetch = jest.fn();
});

afterEach(() => disarmIngest());

describe("BugReportIngestArm", () => {
  it("does nothing with the flag off, even on a listed route", () => {
    pathname = "/course/7/discussion";
    render(<BugReportIngestArm courseId={7} recording={false} />);
    expect(isIngestArmed()).toBe(false);
  });

  it("arms with the flag on and a listed route", () => {
    pathname = "/course/7/discussion";
    render(<BugReportIngestArm courseId={7} recording />);
    expect(isIngestArmed()).toBe(true);
  });

  it("arms from the server marker only when it is present and names this path's course", () => {
    window.history.replaceState(null, "", "/course/7/discussion");
    armFromRecordingMarker();
    expect(isIngestArmed()).toBe(false);
    document.body.innerHTML = `<div data-bug-report-recording="8"></div>`;
    armFromRecordingMarker();
    expect(isIngestArmed()).toBe(false);
    document.body.innerHTML = `<div data-bug-report-recording="7"></div>`;
    armFromRecordingMarker();
    expect(isIngestArmed()).toBe(true);
    document.body.innerHTML = "";
  });

  it("does not arm on an unlisted route or another course's path", () => {
    pathname = "/course/7/manage/course/lti";
    render(<BugReportIngestArm courseId={7} recording />);
    expect(isIngestArmed()).toBe(false);
    pathname = "/course/8/discussion";
    render(<BugReportIngestArm courseId={7} recording />);
    expect(isIngestArmed()).toBe(false);
  });
});
