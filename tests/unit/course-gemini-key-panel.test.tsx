/**
 * #1126 course Gemini API key settings page: status-read failure handling.
 *
 * - The status read has a deadline, so a request that never answers ends in "unavailable" with
 *   Retry instead of leaving the controls disabled. The credential-writing RPCs get no deadline.
 * - A status read that throws is handled like one that fails, and only the latest request for the
 *   mounted panel may update it, whether it succeeds, fails or throws.
 * - Initial-load and Retry failures are announced once each, assertively. A status failure after a
 *   mutation is not announced, so the mutation's own notice is the only announcement.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import CourseGeminiKeyPage from "@/app/course/[course_id]/manage/course/gemini-api-key/page";
import { GEMINI_KEY_FAILURE_TEXT, GEMINI_KEY_STATUS_TIMEOUT_MS, successText } from "@/lib/courseGeminiKey";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null; status: number };
type RpcName = "get_course_gemini_key_status" | "set_course_gemini_key" | "remove_course_gemini_key";
type Handler = (signal: AbortSignal | undefined) => Promise<RpcResult>;
type Builder = PromiseLike<RpcResult> & { abortSignal: jest.Mock };

const mockAnnounce = jest.fn();
const mockRpc = jest.fn();

jest.mock("next/navigation", () => ({ useParams: () => ({ course_id: "7" }) }));
jest.mock("@/hooks/useClassProfiles", () => ({ useClassProfiles: () => ({ role: { role: "instructor" } }) }));
jest.mock("@/components/ui/live-announcer", () => ({ useAnnouncer: () => mockAnnounce }));
jest.mock("@/utils/supabase/client", () => ({ createClient: () => ({ rpc: mockRpc }) }));

const UNAVAILABLE = "Configuration status is unavailable";
const ready = (configured: boolean): RpcResult => ({
  data: { setup_enabled: true, configured },
  error: null,
  status: 200
});
const failed: RpcResult = { data: null, error: { code: "PGRST000", message: "x" }, status: 503 };

/** Per-RPC queues of handlers; a builder mimics postgrest-js (lazy, thenable, `.abortSignal()`). */
let queues: Record<RpcName, Array<Handler | "throw">>;
let builders: Record<RpcName, Builder[]>;

function respond(result: RpcResult): Handler {
  return () => Promise.resolve(result);
}

/** Resolves only when the caller's abort signal fires, as postgrest-js reports an aborted fetch. */
const neverAnswers: Handler = (signal) =>
  new Promise((resolve) =>
    signal?.addEventListener("abort", () =>
      resolve({ data: null, error: { code: "", message: "AbortError: aborted" }, status: 0 })
    )
  );

function deferred() {
  let resolve!: (r: RpcResult) => void;
  let reject!: (e: unknown) => void;
  const handler: Handler = () =>
    new Promise<RpcResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  return { handler, resolve: (r: RpcResult) => resolve(r), reject: (e: unknown) => reject(e) };
}

beforeEach(() => {
  mockAnnounce.mockReset();
  queues = { get_course_gemini_key_status: [], set_course_gemini_key: [], remove_course_gemini_key: [] };
  builders = { get_course_gemini_key_status: [], set_course_gemini_key: [], remove_course_gemini_key: [] };
  mockRpc.mockReset();
  mockRpc.mockImplementation((name: RpcName) => {
    const next = queues[name].shift();
    if (!next) throw new Error(`unexpected ${name} call`);
    if (next === "throw") throw new Error("rpc threw");
    let signal: AbortSignal | undefined;
    const builder: Builder = {
      abortSignal: jest.fn((s: AbortSignal) => {
        signal = s;
        return builder;
      }),
      then: (onFulfilled, onRejected) => next(signal).then(onFulfilled, onRejected)
    };
    builders[name].push(builder);
    return builder;
  });
});

afterEach(() => {
  jest.useRealTimers();
});

function renderPage() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <CourseGeminiKeyPage />
    </ChakraProvider>
  );
}

const statusCalls = () => builders.get_course_gemini_key_status.length;
const announcements = () => mockAnnounce.mock.calls;

async function saveKey() {
  fireEvent.change(screen.getByTestId("gemini-key-input"), { target: { value: "PAWTO_SYNTH_unit" } });
  fireEvent.click(screen.getByTestId("gemini-key-save"));
}

describe("course Gemini key page: status read", () => {
  it("ends a status read that never answers at the deadline, with Retry", async () => {
    jest.useFakeTimers();
    queues.get_course_gemini_key_status.push(neverAnswers, respond(ready(false)));
    renderPage();
    expect(screen.getByTestId("gemini-key-loading")).toBeInTheDocument();
    expect(builders.get_course_gemini_key_status[0].abortSignal).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(GEMINI_KEY_STATUS_TIMEOUT_MS - 1);
    });
    expect(screen.getByTestId("gemini-key-loading")).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(await screen.findByTestId("gemini-key-unavailable")).toBeInTheDocument();
    expect(announcements()).toEqual([[UNAVAILABLE, { priority: "assertive" }]]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("recovers when the status read after a save throws, and puts no deadline on the save", async () => {
    queues.get_course_gemini_key_status.push(respond(ready(false)), "throw", respond(ready(true)));
    queues.set_course_gemini_key.push(respond({ data: { outcome: "saved" }, error: null, status: 200 }));
    renderPage();
    expect(await screen.findByText("Not configured")).toBeInTheDocument();

    await saveKey();
    expect(await screen.findByTestId("gemini-key-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("gemini-key-notice")).toHaveTextContent("Key saved");
    expect(builders.set_course_gemini_key[0].abortSignal).not.toHaveBeenCalled();
    // Only the mutation's own notice is announced.
    expect(announcements()).toEqual([[successText("saved"), { priority: "polite" }]]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Configured (not validated)")).toBeInTheDocument();
    expect(screen.getByTestId("gemini-key-input")).toBeEnabled();
  });

  it("ignores a late status response from a superseded request", async () => {
    const a = deferred();
    const b = deferred();
    queues.get_course_gemini_key_status.push(respond(failed), a.handler, b.handler);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(statusCalls()).toBe(3));

    await act(async () => b.resolve(ready(false)));
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    await act(async () => a.resolve(ready(true)));
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByText("Configured (not validated)")).not.toBeInTheDocument();
  });

  it("ignores a late throw from a superseded request", async () => {
    const a = deferred();
    const b = deferred();
    queues.get_course_gemini_key_status.push(respond(failed), a.handler, b.handler);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(statusCalls()).toBe(3));

    await act(async () => b.resolve(ready(false)));
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    await act(async () => a.reject(new Error("late failure")));
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByTestId("gemini-key-unavailable")).not.toBeInTheDocument();
    // Only the initial failure was announced; the superseded failure was not.
    expect(announcements()).toEqual([[UNAVAILABLE, { priority: "assertive" }]]);
  });
});

describe("course Gemini key page: announcements", () => {
  it("announces initial-load and Retry failures once each, and a mutation failure once", async () => {
    queues.get_course_gemini_key_status.push(respond(failed), respond(failed), respond(ready(false)), respond(failed));
    queues.set_course_gemini_key.push(respond({ data: null, error: { code: "55P03", message: "x" }, status: 409 }));
    renderPage();

    expect(await screen.findByTestId("gemini-key-unavailable")).toBeInTheDocument();
    await waitFor(() => expect(announcements()).toHaveLength(1));
    expect(statusCalls()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(announcements()).toHaveLength(2));
    expect(announcements()[1]).toEqual([UNAVAILABLE, { priority: "assertive" }]);

    // A successful Retry adds nothing.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(announcements()).toHaveLength(2);

    // A mutation failure is announced by finish() only; the status failure that follows is not.
    await saveKey();
    expect(await screen.findByTestId("gemini-key-unavailable")).toBeInTheDocument();
    expect(announcements()).toEqual([
      [UNAVAILABLE, { priority: "assertive" }],
      [UNAVAILABLE, { priority: "assertive" }],
      [GEMINI_KEY_FAILURE_TEXT.busy, { priority: "assertive" }]
    ]);
    expect(statusCalls()).toBe(4);
  });

  it("announces a forbidden initial load with the alert's text", async () => {
    queues.get_course_gemini_key_status.push(
      respond({ data: null, error: { code: "42501", message: "x" }, status: 403 })
    );
    renderPage();
    expect(await screen.findByTestId("gemini-key-forbidden")).toBeInTheDocument();
    await waitFor(() =>
      expect(announcements()).toEqual([[GEMINI_KEY_FAILURE_TEXT.forbidden, { priority: "assertive" }]])
    );
  });
});
