/**
 * The recorder mount's flag query. The course layout renders the flag it read on the server
 * into `<BugReportIngestArm>`; with that value off and no recorder running, a navigation
 * between listed routes makes no `classes?select=features` request.
 */
import { render, waitFor } from "@testing-library/react";
import { BugReportIngestArm } from "@/components/bugReport/BugReportIngestArm";
import BugReportRecorder from "@/components/bugReport/BugReportRecorder";
import { setActiveRecorder } from "@/lib/bugReport/activeRecorder";
import { disarmIngest } from "@/lib/bugReport/ingestGate";
import type { BugReportRecorder as Recorder } from "@/lib/bugReport/types";

let pathname = "/course/7/discussion";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));

const classQueries: number[] = [];
jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: number) => ({
          maybeSingle: async () => {
            if (table === "classes") classQueries.push(id);
            return { data: { features: [{ name: "bug-report-recording", enabled: false }] }, error: null };
          }
        })
      })
    })
  })
}));

beforeAll(() => {
  (window as unknown as { fetch: unknown }).fetch = jest.fn();
});

afterEach(() => {
  classQueries.length = 0;
  disarmIngest();
  setActiveRecorder(undefined);
});

function Page({ course, recording }: { course: number; recording: boolean }) {
  return (
    <>
      <BugReportRecorder />
      <BugReportIngestArm courseId={course} recording={recording} />
    </>
  );
}

describe("BugReportRecorder flag query", () => {
  it("makes no flag query on listed routes when the server rendered the flag off", async () => {
    pathname = "/course/7/discussion";
    const view = render(<Page course={7} recording={false} />);
    pathname = "/course/7/assignments/1";
    view.rerender(<Page course={7} recording={false} />);
    pathname = "/course/7/discussion";
    view.rerender(<Page course={7} recording={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(classQueries).toEqual([]);
  });

  it("waits for a course layout that renders after the mount's effect (a streamed full load)", async () => {
    pathname = "/course/11/discussion";
    const view = render(<BugReportRecorder />);
    await new Promise((r) => setTimeout(r, 0));
    view.rerender(<Page course={11} recording={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(classQueries).toEqual([]);
  });

  it("queries the flag before starting when the server rendered it on", async () => {
    pathname = "/course/8/discussion";
    render(<Page course={8} recording />);
    await waitFor(() => expect(classQueries).toEqual([8]));
  });

  it("re-reads the flag while a recorder runs, and stops it when the flag is off (A6)", async () => {
    const stop = jest.fn();
    setActiveRecorder({
      getCourseId: () => 9,
      onNavigate: jest.fn(),
      stop
    } as unknown as Recorder);
    pathname = "/course/9/discussion";
    render(<Page course={9} recording={false} />);
    await waitFor(() => expect(classQueries).toEqual([9]));
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
});
