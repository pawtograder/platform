/**
 * The recorder (package 1) with rrweb replaced by a stub that emits Meta + FullSnapshot on start
 * and turns `addCustomEvent` into a type-5 event: console breadcrumbs, the taint-block watcher,
 * pausing, and what `freeze()` keeps.
 */
import { redactBuffer, taintSnapshot } from "@/lib/bugReport/redaction";
import { getTaintSet } from "@/lib/bugReport/taint";
import type { BugReportRecorder, FrozenBuffer, RecordedEvent } from "@/lib/bugReport/types";

type Emit = (event: RecordedEvent) => void;
const rrweb = { emit: null as Emit | null, snapshotHook: null as (() => void) | null };

function snapshot(emit: Emit): void {
  emit({ type: 4, timestamp: Date.now(), data: { href: window.location.href, width: 1, height: 1 } } as RecordedEvent);
  // rrweb logs from inside its snapshot now and then; tests set this to do the same.
  rrweb.snapshotHook?.();
  emit({
    type: 2,
    timestamp: Date.now(),
    data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }
  } as unknown as RecordedEvent);
}

jest.mock("@sentry-internal/rrweb", () => ({
  record: Object.assign(
    (options: { emit: Emit }) => {
      rrweb.emit = options.emit;
      snapshot(options.emit);
      return () => {
        rrweb.emit = null;
      };
    },
    { mirror: { getId: () => 1 } }
  ),
  addCustomEvent: (tag: string, payload: unknown) => {
    if (!rrweb.emit) throw new Error("not recording");
    rrweb.emit({ type: 5, timestamp: Date.now(), data: { tag, payload } } as RecordedEvent);
  },
  takeFullSnapshot: () => {
    if (rrweb.emit) snapshot(rrweb.emit);
  }
}));
jest.mock("@sentry/nextjs", () => ({ getClient: () => undefined }));
jest.mock("@/lib/bugReport/ingest", () => ({
  startIngest: () => ({ stop: () => undefined, stats: () => ({}), idle: async () => undefined })
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { consoleMessage, startRecorder } =
  require("@/lib/bugReport/recorder") as typeof import("@/lib/bugReport/recorder");

type ConsoleCrumb = { category: string; message?: string };

function crumbs(buffer: FrozenBuffer): ConsoleCrumb[] {
  return buffer.segments
    .flatMap((s) => s.events)
    .filter((e) => e.type === 5)
    .map((e) => (e.data as { payload: ConsoleCrumb }).payload)
    .filter((p) => p.category === "console");
}

let recorder: BugReportRecorder | undefined;

function start(path = "/course/1/discussion"): BugReportRecorder {
  window.history.pushState({}, "", path);
  recorder = startRecorder({ courseId: 1, level: "full" });
  return recorder;
}

/* eslint-disable no-console -- console calls are what these tests record */
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  recorder?.stop();
  recorder = undefined;
  rrweb.snapshotHook = null;
  getTaintSet().clear();
  jest.restoreAllMocks();
});

describe("console breadcrumbs", () => {
  it("keeps logged strings unescaped, so taint still matches them", async () => {
    const post = 'I told "Bob" my password is hunter2 please help';
    const tabbed = "line one\tcol hunter3 tabbed text";
    const r = start();
    getTaintSet().add("free_text", post);
    getTaintSet().add("free_text", tabbed);
    console.log({ body: post }, [{ b: tabbed }], "path\\to\\file");
    const frozen = r.freeze();
    const [crumb] = crumbs(frozen);
    expect(crumb.message).toBe(`body: ${post} b: ${tabbed} path\\to\\file`);
    const out = JSON.stringify((await redactBuffer(frozen, { taintPatterns: taintSnapshot() })).buffer);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("hunter3");
  });

  it("walks objects to a bounded depth and number of leaves", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    expect(consoleMessage([deep])).toBe("d: [Object]");
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(consoleMessage([cyclic])).toBe("name: loop\nself: [Object]");
    expect(consoleMessage([new Error("boom"), 42, null, undefined])).toBe("Error: boom 42 null undefined");
    expect(consoleMessage([Array.from({ length: 1000 }, (_, i) => `v${i}`)]).split("\n")).toHaveLength(200);
  });

  it("cuts a long message at a line boundary and drops the line that doesn't fit", async () => {
    const post = "My grade appeal: the TA ignored my regrade secretcanary about question four";
    const r = start();
    getTaintSet().add("free_text", post);
    console.log(`${"x".repeat(1970)}\n${post}`);
    const frozen = r.freeze();
    const [crumb] = crumbs(frozen);
    expect(crumb.message).toBe(`${"x".repeat(1970)}\n[truncated]`);
    expect(crumb.message!.length).toBeLessThanOrEqual(2000);
    // One long line that doesn't fit is dropped whole.
    expect(consoleMessage([`${"y".repeat(1990)} ${post}`])).toBe("[truncated]");
    const out = JSON.stringify((await redactBuffer(frozen, { taintPatterns: taintSnapshot() })).buffer);
    expect(out).not.toContain("secretcan");
  });
});

describe("taint blocks", () => {
  const block = (names: string[]) => JSON.stringify({ v: 1, values: { name: names } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads a block that mounts after the start, and one whose text changes in place", async () => {
    const r = start();
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "report-taint";
    el.textContent = block(["Mounted Quellmar"]);
    document.body.appendChild(el);
    await tick();
    expect(getTaintSet().has("Mounted Quellmar")).toBe(true);

    // The same text node, new data (React updating the block's text).
    (el.firstChild as Text).data = block(["Updated Vrexholm"]);
    await tick();
    expect(getTaintSet().has("Updated Vrexholm")).toBe(true);

    // The text node swapped for another.
    el.textContent = block(["Replaced Tazmerin"]);
    await tick();
    expect(getTaintSet().has("Replaced Tazmerin")).toBe(true);
    expect(r.getState()).toBe("recording");
  });
});

describe("linked errors", () => {
  type WithNoteError = BugReportRecorder & { noteError(eventId?: string, traceId?: string): void };

  it("links only errors inside the kept window, and caps the list", async () => {
    let now = 0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    window.history.pushState({}, "", "/course/1/discussion");
    const r = startRecorder({ courseId: 1, level: "full", limits: { maxAgeMs: 10_000, checkoutEveryMs: 5_000 } });
    recorder = r;
    const rec = r as WithNoteError;
    now = 1_000;
    rec.noteError("e-old", "t-old");
    // A checkout 20 s in: the first segment is past the age limit and is dropped.
    now = 20_000;
    (jest.requireMock("@sentry-internal/rrweb") as { takeFullSnapshot(): void }).takeFullSnapshot();
    now = 21_000;
    rec.noteError("e-new", "t-new");
    rec.noteError("e-new", "t-new");
    const frozen = r.freeze();
    expect(frozen.startTimestamp).toBe(20_000);
    expect(frozen.errorIds).toEqual(["e-new"]);
    expect(frozen.traceIds).toEqual(["t-new"]);

    for (let i = 0; i < 150; i++) rec.noteError(`e${i}`, `t${i}`);
    expect(r.getErrorIds()).toHaveLength(100);
    expect(r.getErrorIds()[99]).toBe("e149");
  });

  it("keepLastMs drops the errors before the trimmed start", async () => {
    const seg = (t: number) => ({
      events: [
        { type: 4, timestamp: t, data: { href: "http://localhost/course/1/x", width: 1, height: 1 } },
        {
          type: 2,
          timestamp: t,
          data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }
        }
      ] as unknown as RecordedEvent[],
      startTimestamp: t,
      endTimestamp: t + 1,
      size: 1,
      level: "full" as const
    });
    const buffer: FrozenBuffer = {
      replayId: "0".repeat(32),
      level: "full",
      segments: [seg(0), seg(60_000)],
      startTimestamp: 0,
      endTimestamp: 60_001,
      urls: ["http://localhost/course/1/x"],
      errorIds: ["e-old", "e-new"],
      traceIds: ["t-old", "t-new"],
      errors: [
        { eventId: "e-old", traceId: "t-old", at: 10 },
        { eventId: "e-new", traceId: "t-new", at: 60_000 }
      ],
      size: 2
    };
    const { buffer: trimmed } = await redactBuffer(buffer, { taintPatterns: [], keepLastMs: 30_000 });
    expect(trimmed.errorIds).toEqual(["e-new"]);
    expect(trimmed.traceIds).toEqual(["t-new"]);
  });
});

describe("snapshots", () => {
  it("keeps the segment when rrweb logs from inside a checkout snapshot", () => {
    const r = start();
    rrweb.snapshotHook = () => console.warn("rrweb: something inside takeFullSnapshot");
    // rrweb's own periodic checkout (checkoutEveryNms).
    (jest.requireMock("@sentry-internal/rrweb") as { takeFullSnapshot(): void }).takeFullSnapshot();
    const frozen = r.freeze();
    expect(frozen.segments).toHaveLength(2);
    expect(frozen.segments[1].events.map((e) => e.type)).toEqual([4, 2, 5]);
    expect(crumbs(frozen)[0].message).toBe("rrweb: something inside takeFullSnapshot");
  });
});

describe("paused", () => {
  it("doesn't walk console arguments on an unlisted route, and still takes taint", () => {
    const r = start();
    window.history.pushState({}, "", "/course/1/manage/course/lti");
    r.onNavigate(window.location.pathname);
    expect(r.getState()).toBe("paused");
    let reads = 0;
    const logged = {
      get body() {
        reads++;
        return "read while paused";
      }
    };
    console.log(logged);
    expect(reads).toBe(0);
    // Values that reach the page while paused can be rendered after resuming.
    r.addTaint("name", ["Paused Quellmar"]);
    window.history.pushState({}, "", "/course/1/discussion");
    r.onNavigate(window.location.pathname);
    expect(r.getState()).toBe("recording");
    console.log(logged);
    expect(reads).toBe(1);
    expect(getTaintSet().has("Paused Quellmar")).toBe(true);
  });
});
/* eslint-enable no-console */
