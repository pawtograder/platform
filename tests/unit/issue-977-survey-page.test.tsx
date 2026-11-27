import React from "react";
import { act, render, screen } from "@testing-library/react";
import type { CompleteEvent, Model, ValueChangedEvent } from "survey-core";
import type SurveyComponent from "@/components/Survey";
import SurveyTakingPage from "@/app/course/[course_id]/surveys/[survey_id]/page";

type SurveyProps = React.ComponentProps<typeof SurveyComponent>;
const mockSurvey = jest.fn<React.ReactNode, [SurveyProps]>(() => null);
const mockToast = jest.fn();
const mockPush = jest.fn();
const mockRouter = { push: mockPush };
const mockFrom = jest.fn();
const mockController = {
  courseId: 1,
  // The page waits on readyPromise to tell a failed survey load from a missing survey.
  surveys: { readyPromise: Promise.resolve() },
  client: {
    from: mockFrom,
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: jest.fn() } } }) }
  }
};
const mockSurveyRow = {
  id: "survey",
  class_id: 1,
  status: "published",
  allow_response_editing: true,
  json: {},
  title: "Survey"
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "course", survey_id: "survey" }),
  useRouter: () => mockRouter
}));
jest.mock("next/dynamic", () => ({ __esModule: true, default: () => (props: SurveyProps) => mockSurvey(props) }));
jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ private_profile_id: "student", isReadOnly: false })
}));
jest.mock("@/hooks/useCourseController", () => ({
  useCourseController: () => mockController,
  useSurvey: () => mockSurveyRow
}));
jest.mock("@/lib/TableController", () => ({ useIsTableControllerReady: () => true }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { create: (...args: unknown[]) => mockToast(...args) } }));
jest.mock("@chakra-ui/react", () => {
  const Element = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, role, tabIndex }, ref) => (
      <div ref={ref} role={role} tabIndex={tabIndex}>
        {children}
      </div>
    )
  );
  Element.displayName = "Element";
  return {
    Box: Element,
    Heading: Element,
    Text: Element,
    VStack: Element,
    Button: Element,
    HStack: Element,
    Spinner: Element
  };
});
jest.mock("@/components/ui/alert", () => {
  const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { title: string }>(
    ({ children, title, role, tabIndex }, ref) => (
      <div ref={ref} role={role} tabIndex={tabIndex}>
        {title} {children}
      </div>
    )
  );
  Alert.displayName = "Alert";
  return { Alert };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const row = (answer: string, submitted = true) => ({ response: { q1: answer }, is_submitted: submitted });
const refused = { code: "23514", message: "Already submitted" };
const mockWrite = jest.fn();
const mockRead = jest.fn();
const readSignals: AbortSignal[] = [];
const writeSignals: AbortSignal[] = [];
let loadedRow = row("Earlier");
const props = () => mockSurvey.mock.calls.at(-1)![0];
const model = (answer: string) =>
  ({ data: { q1: answer }, notifier: { active: false }, clear: jest.fn() }) as unknown as Model;
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => jest.advanceTimersByTime(ms));
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  loadedRow = row("Earlier");
  mockSurveyRow.allow_response_editing = true;
  readSignals.length = 0;
  writeSignals.length = 0;
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockWrite.mockResolvedValue({ data: row("New"), error: null });
  mockRead.mockResolvedValue({ data: row("New"), error: null });
  mockFrom.mockImplementation(() => {
    let writing = false;
    const query = {
      select: () => query,
      eq: () => query,
      upsert: (data: unknown) => {
        writing = true;
        mockWriteData.push(data);
        return query;
      },
      abortSignal: (signal: AbortSignal) => {
        (writing ? writeSignals : readSignals).push(signal);
        return query;
      },
      single: () => (writing ? mockWrite() : Promise.resolve({ data: loadedRow, error: null })),
      maybeSingle: () => mockRead()
    };
    return query;
  });
  mockWriteData.length = 0;
});
const mockWriteData: unknown[] = [];
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each(["Earlier", "New"])("reconnect checks Complete's answers against the stored %s answer", async (stored) => {
  render(<SurveyTakingPage />);
  await settle();
  const submit = deferred<{ error: unknown }>();
  mockWrite.mockReturnValueOnce(submit.promise);
  act(() => {
    props().onComplete!(model("New"), {
      showSaveInProgress: jest.fn(),
      clearSaveMessages: jest.fn(),
      showSaveSuccess: jest.fn()
    } as unknown as CompleteEvent);
  });
  await settle();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  submit.resolve({ error: new TypeError("Failed to fetch") });
  await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("may not have been submitted");
  expect(mockWrite).toHaveBeenCalledTimes(1);
  mockRead.mockResolvedValueOnce({ data: row(stored), error: null });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  act(() => window.dispatchEvent(new Event("online")));
  await settle();
  if (stored === "Earlier") {
    expect(screen.getByRole("alert")).toHaveTextContent("Your survey wasn't submitted");
    expect(mockToast).not.toHaveBeenCalled();
  } else {
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockToast).toHaveBeenCalledTimes(1);
  }
  expect(mockWriteData.at(-1)).toMatchObject({ response: { q1: "New" }, is_submitted: true });
});

test("a refused save arriving after its timeout does not start another read-back", async () => {
  loadedRow = row("Draft", false);
  render(<SurveyTakingPage />);
  await settle();
  const save = deferred<{ error: unknown }>();
  mockWrite.mockReturnValueOnce(save.promise);
  act(() => props().onValueChanged!(model("New"), {} as ValueChangedEvent));
  await advance(1000);
  await advance(10_000);
  await advance(1000);
  expect(mockWrite).toHaveBeenCalledTimes(2);
  save.resolve({ error: refused });
  await settle();
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});

test("a read-back shares the save deadline and cannot reconcile after a retry", async () => {
  loadedRow = row("Draft", false);
  render(<SurveyTakingPage />);
  await settle();
  const read = deferred<{ data: ReturnType<typeof row>; error: null }>();
  mockWrite.mockResolvedValueOnce({ error: refused }).mockResolvedValueOnce({ error: refused });
  mockRead.mockReturnValueOnce(read.promise);
  act(() => props().onValueChanged!(model("New"), {} as ValueChangedEvent));
  await advance(1000);
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(readSignals[0] === writeSignals[0]).toBe(true);
  await advance(10_000);
  expect(readSignals[0].aborted).toBe(true);
  await advance(1000);
  expect(mockWrite).toHaveBeenCalledTimes(3);
  expect(mockToast).toHaveBeenCalledTimes(1);
  read.resolve({ data: row("New"), error: null });
  await settle();
  expect(mockToast).toHaveBeenCalledTimes(1);
});

test("a submit in flight shows a banner and asks before the page closes", async () => {
  render(<SurveyTakingPage />);
  await settle();
  const submit = deferred<{ data: unknown; error: unknown }>();
  mockWrite.mockReturnValueOnce(submit.promise);
  const leave = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(leave()).toBe(false);
  act(() => {
    props().onComplete!(model("New"), {
      showSaveInProgress: jest.fn(),
      clearSaveMessages: jest.fn(),
      showSaveSuccess: jest.fn()
    } as unknown as CompleteEvent);
  });
  await settle();
  expect(screen.getByText(/Submitting your survey/)).toHaveTextContent("Keep this page open");
  expect(leave()).toBe(true);
  submit.resolve({ data: row("New"), error: null });
  await settle();
  expect(screen.queryByText(/Submitting your survey/)).toBeNull();
  expect(leave()).toBe(false);
});

test("a reconnect read that started before a later Complete doesn't decide that Complete", async () => {
  render(<SurveyTakingPage />);
  await settle();
  const complete = (answer: string) =>
    act(() => {
      props().onComplete!(model(answer), {
        showSaveInProgress: jest.fn(),
        clearSaveMessages: jest.fn(),
        showSaveSuccess: jest.fn()
      } as unknown as CompleteEvent);
    });
  const goOnline = (online: boolean) =>
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  // Complete A is sent, then the connection drops before the reply.
  const submitA = deferred<{ error: unknown }>();
  mockWrite.mockReturnValueOnce(submitA.promise);
  complete("New");
  await settle();
  goOnline(false);
  submitA.resolve({ error: new TypeError("Failed to fetch") });
  await settle();
  // Back online: the check for A starts reading, and its reply is held.
  const staleRead = deferred<{ data: unknown; error: unknown }>();
  mockRead.mockReturnValueOnce(staleRead.promise);
  goOnline(true);
  act(() => window.dispatchEvent(new Event("online")));
  await settle();
  // Complete B is pressed and fails offline while that read is still out.
  goOnline(false);
  mockWrite.mockResolvedValueOnce({ data: null, error: new TypeError("Failed to fetch") });
  complete("Newer");
  await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("may not have been submitted");
  // The read started before B lands. It must not clear B's alert or report a submit.
  staleRead.resolve({ data: row("New"), error: null });
  await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("may not have been submitted");
  expect(mockToast).not.toHaveBeenCalled();
  // The next reconnect reads again and decides from that.
  mockRead.mockResolvedValueOnce({ data: row("New"), error: null });
  goOnline(true);
  act(() => window.dispatchEvent(new Event("online")));
  await settle();
  expect(mockRead).toHaveBeenCalledTimes(2);
  expect(mockToast).toHaveBeenCalledTimes(1);
});
