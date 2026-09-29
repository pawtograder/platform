/**
 * "Report this" on error toasts: the toast links to the error event captured in the same
 * task, never to an older one, and captures one on click when there is none.
 */
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Set<Handler>>();
const fakeClient = {
  on(name: string, fn: Handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(fn);
    return () => handlers.get(name)!.delete(fn);
  },
  getDsn: () => ({ host: "sentry.test" })
};
const emit = (name: string, ...args: unknown[]) => handlers.get(name)?.forEach((fn) => fn(...args));
let captureMessageCount = 0;

jest.mock("@sentry/nextjs", () => ({
  getClient: () => fakeClient,
  captureMessage: () => {
    captureMessageCount++;
    return "m".repeat(32);
  }
}));

const opened: { eventId?: string }[] = [];
jest.mock("@/lib/bugReport/reportDialog", () => ({
  openReportDialog: (o: { eventId?: string }) => {
    opened.push(o);
    return true;
  }
}));

import { installErrorEventTracking, resetErrorEventTrackingForTests } from "@/lib/bugReport/errorEventLink";
import { toaster } from "@/components/ui/toaster";

type ToastAction = { label: string; onClick: () => void };
function actionOf(id: string): ToastAction | undefined {
  const toasts = toaster.getVisibleToasts() as { id: string; action?: ToastAction }[];
  return toasts.find((t) => t.id === id)?.action;
}

// zag types `error`/`success` as returning void, but they return the toast id like `create`.
const errorToast = (o: Parameters<typeof toaster.create>[0]) => toaster.error(o) as unknown as string;
const successToast = (o: Parameters<typeof toaster.create>[0]) => toaster.success(o) as unknown as string;

const flushTask = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  handlers.clear();
  opened.length = 0;
  captureMessageCount = 0;
  resetErrorEventTrackingForTests();
  installErrorEventTracking();
});

it("links the error captured in the same task", () => {
  emit("preprocessEvent", { event_id: "a".repeat(32) }, {});
  const t1 = errorToast({ title: "Could not save" });
  const action = actionOf(t1);
  expect(action?.label).toBe("Report this");
  action!.onClick();
  expect(opened).toEqual([{ eventId: "a".repeat(32) }]);
  expect(captureMessageCount).toBe(0);
});

it("does not link an error captured in an earlier task; captures one on click instead", async () => {
  emit("preprocessEvent", { event_id: "b".repeat(32) }, {});
  await flushTask();
  const t2 = errorToast({ title: "Could not load" });
  actionOf(t2)!.onClick();
  expect(opened).toEqual([{ eventId: "m".repeat(32) }]);
  expect(captureMessageCount).toBe(1);
});

it("ignores non-error events such as feedback", () => {
  emit("preprocessEvent", { event_id: "c".repeat(32), type: "feedback" }, {});
  const t3 = errorToast({ title: "x" });
  actionOf(t3)!.onClick();
  expect(opened[0].eventId).toBe("m".repeat(32));
});

it("prefers an explicit meta.sentryEventId and respects opt-outs and custom actions", () => {
  const t4 = errorToast({ title: "x", meta: { sentryEventId: "d".repeat(32) } });
  actionOf(t4)!.onClick();
  expect(opened[0].eventId).toBe("d".repeat(32));

  const t5 = errorToast({ title: "y", meta: { reportable: false } });
  expect(actionOf(t5)).toBeUndefined();

  const mine = { label: "Retry", onClick: jest.fn() };
  const t6 = errorToast({ title: "z", action: mine });
  expect(actionOf(t6)?.label).toBe("Retry");
});

it("adds the action to create({ type: 'error' }) but not to other toasts", () => {
  const t7 = toaster.create({ title: "err", type: "error" });
  expect(actionOf(t7)?.label).toBe("Report this");
  const t8 = successToast({ title: "ok" });
  expect(actionOf(t8)).toBeUndefined();
});
