/**
 * Unit tests for the control-hop rung of the milestone resync ladder
 * (tools/a11y-judge/agent/replay.ts) and for the optional driver hook it is
 * guarded on (AtDriver.moveToControl, tools/a11y-judge/agent/atHarness.ts).
 *
 * The failure being fixed, from enforce run 30760469666 (the NVDA lane's last
 * red task, discussion__discussion-reply step 11, `act`, milestone "reply"):
 * NVDA coalesces the discussion post's three inline icon buttons onto ONE browse
 * line, "Like (0 likes), button, Edit, button, Reply". The ladder navigates with
 * `next`/`previous` — ArrowDown/ArrowUp — which move by LINE and rest at the
 * line START, so every one of the 75 presses parked the cursor on Like. The
 * speech claimed the milestone (the line names Reply, and
 * nvdaLineSegmentAlternates offers it), the cursor oracle answered "Like (0
 * likes), button", and the gate correctly reported `contradicted` each time. The
 * matcher and the gate were right; the ladder had no gesture that could reach
 * the button.
 *
 * The fake driver below models exactly that asymmetry, and nothing else: a line
 * cursor that lands at the start of a line, a control cursor that walks the
 * controls, an oracle that names the CONTROL, and speech that is the line after
 * a line move and the control after a control hop (which is what NVDA speaks
 * when quick-nav B lands on a button).
 *
 * No NVDA and no Windows needed: only the pure ladder and the pure alternates
 * helper are exercised, and @guidepup/guidepup is imported type-only by the
 * module under test.
 */
import type {
  AtCommand,
  AtDriver,
  AtObservation,
  ControlHopDirection,
  CursorVerdict
} from "@/tools/a11y-judge/agent/atHarness";
import {
  CONTROL_RESYNC_OFFSET,
  CONTROL_SWEEP_LIMIT,
  replayPlan,
  ReplayMilestoneError,
  type ReplayPlan
} from "@/tools/a11y-judge/agent/replay";
import { nvdaLineSegmentAlternates } from "@/tools/a11y-judge/nvda/nvdaHarness";

/** One browse line, as NVDA speaks it, plus the controls it coalesces. */
interface BrowseLine {
  /** What an arrow press onto this line announces. */
  spoken: string;
  /** Each control's own announcement, in document order; [] for prose. */
  controls: string[];
}

/**
 * The thread from run 30760469666. Line 2 is the coalesced button row, quoted
 * verbatim from cmd#164 of that run; its three controls are what NVDA speaks
 * when B lands on each of them.
 */
const THREAD: BrowseLine[] = [
  { spoken: "Discussion, region, heading, level 1, E2E A11y Agent Class", controls: [] },
  { spoken: "A first post from the agent student, with no controls of its own", controls: [] },
  {
    spoken: "Like (0 likes), button, Edit, button, Reply",
    controls: ["Like (0 likes), button", "Edit, button", "Reply, button"]
  },
  { spoken: "Posted {{time}}", controls: [] },
  { spoken: "out of article, clickable, Watch thread, button", controls: ["Watch thread, button"] }
];

/**
 * A driver that can only move by LINE — the shape both real drivers had before
 * this change, and the shape real VoiceOver and the virtual screen reader still
 * have. It implements verifyCursor because that is what makes the failure
 * visible: the speech names Reply, the oracle names the control the cursor is
 * actually on.
 */
class LineDriver implements AtDriver {
  readonly calls: string[] = [];
  protected line: number;
  protected control = 0;
  /** Line moves announce the line; control hops announce the control. */
  protected onControl = false;

  constructor(
    protected readonly lines: BrowseLine[],
    startLine: number
  ) {
    this.line = startLine;
  }

  async run(command: AtCommand): Promise<AtObservation> {
    this.calls.push(command);
    // Arrow keys move by line and rest at the line START — the whole defect.
    if (command === "next" && this.line < this.lines.length - 1) this.moveLine(this.line + 1);
    if (command === "previous" && this.line > 0) this.moveLine(this.line - 1);
    const spoken = this.spokenNow();
    return {
      spokenSinceLastAction: [spoken],
      currentItem: spoken,
      currentItemAlternates: nvdaLineSegmentAlternates(spoken),
      domFocus: null
    };
  }

  /** The oracle reads the CONTROL, not the speech — real NVDA's navigator
   *  object. Prose collapses to a bare role, which is an abstention. */
  async verifyCursor(milestone: string): Promise<CursorVerdict> {
    const control = this.lines[this.line].controls[this.control];
    if (control === undefined) return "abstained";
    return control.toLowerCase().startsWith(milestone.toLowerCase()) ? "agreed" : "contradicted";
  }

  async unstick(): Promise<void> {
    this.calls.push("unstick");
    this.moveLine(0);
  }

  protected moveLine(line: number): void {
    this.line = line;
    this.control = 0;
    this.onControl = false;
  }

  protected spokenNow(): string {
    const control = this.lines[this.line].controls[this.control];
    return this.onControl && control !== undefined ? control : this.lines[this.line].spoken;
  }
}

/** The same driver plus the hook — real NVDA (browse-mode quick nav B/Shift-B). */
class ControlDriver extends LineDriver {
  async moveToControl(direction: ControlHopDirection): Promise<void> {
    this.calls.push(`moveToControl:${direction}`);
    const stride = direction === "next" ? 1 : -1;
    let line = this.line;
    let control = this.control + stride;
    while (line >= 0 && line < this.lines.length) {
      const controls = this.lines[line].controls;
      if (control >= 0 && control < controls.length) {
        this.line = line;
        this.control = control;
        this.onControl = true;
        return;
      }
      line += stride;
      if (line < 0 || line >= this.lines.length) return; // nothing that way: stay put
      control = stride > 0 ? 0 : this.lines[line].controls.length - 1;
    }
  }
}

const replyPlan: ReplayPlan = {
  generatorVersion: "1",
  sourceTrajectoryHash: "test",
  pageId: "discussion",
  taskId: "discussion-reply",
  taskKind: "write",
  readNeedleKeys: [],
  steps: [{ command: "act", milestone: "reply" }]
};

/** Tiny on purpose: the line-wise sweeps are not what is under test here, and
 *  the real lane's 25 makes for 75 uninteresting presses per case. */
const RESYNC_LIMIT = 3;

const hops = (calls: string[]): string[] => calls.filter((c) => c.startsWith("moveToControl"));

describe("control-hop rung of the resync ladder", () => {
  it("reaches a control the line-wise ladder cannot: run 30760469666's Reply button", async () => {
    // Cursor on the coalesced button row, at the line start — i.e. on Like,
    // exactly where every arrow press in that run left it.
    const harness = new ControlDriver(THREAD, 2);
    const result = await replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT });
    // Like → Edit → Reply, three hops from the top of the thread the backward
    // sweep left the cursor on.
    expect(result.resyncs).toEqual([{ stepIndex: 0, presses: CONTROL_RESYNC_OFFSET + 3, milestone: "reply" }]);
    expect(harness.calls).toContain("act");
  });

  it("gets there without unstick — the rung sits in front of it", async () => {
    const harness = new ControlDriver(THREAD, 2);
    await replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT });
    expect(harness.calls).not.toContain("unstick");
  });

  it("does not hop at all when the milestone is already satisfied", async () => {
    const harness = new ControlDriver(THREAD, 2);
    // Start ON Reply: the speech matches and the oracle agrees, so the ladder
    // never runs and neither does this rung.
    await harness.moveToControl("next");
    await harness.moveToControl("next");
    harness.calls.length = 0;
    const result = await replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT });
    expect(result.resyncs).toEqual([]);
    expect(hops(harness.calls)).toEqual([]);
  });

  it("walks back when the control is behind the cursor, and records it negative", async () => {
    // Nothing but prose ahead of the cursor, so the forward hops find no control
    // and the backward pass is the only way to the button row.
    const trailing: BrowseLine[] = [
      ...THREAD.slice(0, 3),
      ...["one", "two", "three", "four"].map((n) => ({ spoken: `A trailing paragraph, ${n}`, controls: [] }))
    ];
    const harness = new ControlDriver(trailing, 5);
    const result = await replayPlan(harness, replyPlan, {}, { resyncLimit: 1 });
    expect(result.resyncs).toEqual([{ stepIndex: 0, presses: -(CONTROL_RESYNC_OFFSET + 1), milestone: "reply" }]);
    expect(hops(harness.calls).slice(0, CONTROL_SWEEP_LIMIT)).toEqual(
      new Array(CONTROL_SWEEP_LIMIT).fill("moveToControl:next")
    );
  });

  it("reads every hop back through an ordinary observe", async () => {
    const harness = new ControlDriver(THREAD, 2);
    await replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT });
    // The hook reports nothing (AtDriver.moveToControl); the observe after each
    // hop is where the ladder learns where it landed, and the only path by which
    // the milestone gate — speech AND oracle — judges the hop.
    const tail = harness.calls.slice(harness.calls.indexOf("moveToControl:next"));
    expect(tail).toEqual([
      "moveToControl:next",
      "observe",
      "moveToControl:next",
      "observe",
      "moveToControl:next",
      "observe",
      "act"
    ]);
  });

  it("spends a small, bounded budget and then falls through to unstick", async () => {
    const harness = new ControlDriver(THREAD, 2);
    const unreachable: ReplayPlan = { ...replyPlan, steps: [{ command: "act", milestone: "no such control" }] };
    await expect(replayPlan(harness, unreachable, {}, { resyncLimit: RESYNC_LIMIT })).rejects.toThrow(
      ReplayMilestoneError
    );
    expect(hops(harness.calls)).toHaveLength(CONTROL_SWEEP_LIMIT * 3); // N forward, 2N back
    // Before unstick, which restarts from the content top and re-walks everything.
    expect(harness.calls.indexOf("unstick")).toBeGreaterThan(harness.calls.lastIndexOf("moveToControl:previous"));
  });

  it("names the rung in the exhaustion message", async () => {
    const harness = new ControlDriver(THREAD, 2);
    const unreachable: ReplayPlan = { ...replyPlan, steps: [{ command: "act", milestone: "no such control" }] };
    await expect(replayPlan(harness, unreachable, {}, { resyncLimit: RESYNC_LIMIT })).rejects.toThrow(
      /control hops forward/
    );
  });
});

describe("control-hop rung on a driver without the hook", () => {
  // The guard is `if (!found && harness.moveToControl)`. Neither
  // vo/voHarness.ts (real VoiceOver, 9/9 in enforce) nor agent/atHarness.ts (the
  // virtual screen reader) declares moveToControl, so for both of them this rung
  // does not exist and the ladder is the one they have always run.
  it("skips the rung entirely and keeps the old ladder", async () => {
    const harness = new LineDriver(THREAD, 2);
    await expect(replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT })).rejects.toThrow(
      ReplayMilestoneError
    );
    expect(hops(harness.calls)).toEqual([]);
    // unstick still runs, in the same place, with the same budget.
    expect(harness.calls).toContain("unstick");
    expect(harness.calls.filter((c) => c === "next")).toHaveLength(RESYNC_LIMIT + RESYNC_LIMIT * 3);
    expect(harness.calls.filter((c) => c === "previous")).toHaveLength(RESYNC_LIMIT * 2);
  });

  it("does not mention control hops in the exhaustion message", async () => {
    const harness = new LineDriver(THREAD, 2);
    await expect(replayPlan(harness, replyPlan, {}, { resyncLimit: RESYNC_LIMIT })).rejects.toThrow(
      /not found within 3 presses forward or 3 back \(nor 9 after unstick\)/
    );
  });
});

describe("control-hop resync encoding", () => {
  it("cannot collide with a line-press resync", () => {
    // presses is already three bands: `press` forward, `resyncLimit - press`
    // back, `resyncLimit + press` after unstick — all bounded by 3 × resyncLimit
    // in magnitude. The NVDA lane runs resyncLimit 25 (nvda/run.ts), so the
    // widest line band is ±75.
    expect(CONTROL_RESYNC_OFFSET).toBeGreaterThan(3 * 25);
    // And the control band's own magnitudes stay inside their decade.
    expect(CONTROL_SWEEP_LIMIT * 2).toBeLessThan(CONTROL_RESYNC_OFFSET);
  });
});
