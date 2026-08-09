/**
 * NvdaHarness — real Windows NVDA implementation of the AtDriver command
 * surface (agent/atHarness.ts), backed by @guidepup/guidepup. The Windows/NVDA
 * counterpart of vo/voHarness.ts; lets replayPlan re-drive the promoted
 * ReplayPlans through real NVDA + real Chromium, cross-validating the
 * virtual-screen-reader (and VoiceOver) results.
 *
 * NVDA vs VoiceOver differences that shape this port:
 *  - NVDA has browse mode vs focus mode instead of VO's nested interaction
 *    levels: `interact` toggles into focus mode, `stopInteracting` = exitFocusMode.
 *    `interact` is a TOGGLE, not a descent, and toggling focus mode onto a
 *    non-focusable CONTAINER (a landmark) wedges NVDA: it then speaks nothing at
 *    all, so itemText() returns "" — and itemText() is what milestone matching
 *    AND the read-needle sweep both read, so the whole replay goes blind while
 *    still costing ~2.25s per command. `case "interact"` therefore guards the
 *    gesture (before and after), and run() detects the silence, tries the
 *    documented recovery once and then throws NvdaSpeechLostError instead of
 *    issuing hundreds of blind commands (run 30455293803: ~270 of them, ~10
 *    minutes per attempt, ending in a misleading `readNext hung for 30000ms`).
 *  - Structural navigation uses NVDA's native single-letter quick-nav
 *    (moveToNextHeading, moveToNextLink, moveToNextFormField, moveToNextLandmark)
 *    — no Commander/`@guidepup/setup` step is needed (VO's landmark gap).
 *  - NVDA announces the ROLE as a PREFIX ("heading, level 1, Title";
 *    "link, next link") rather than VO's trailing suffix, so stripNvdaBoilerplate
 *    strips leading role tokens. These pattern lists are the calibration knob
 *    for VSR→real-NVDA phrasing drift — tune with `a11y:nvda --calibrate`.
 *  - Foregrounding: under a CI job the runner console holds the OS foreground,
 *    so SetForegroundWindow is blocked; the browser is brought to NVDA's focus
 *    via NVDA-driven Alt+Esc app-switching (verified via reportTitle), and a
 *    transient PickerHost "Windows Security" dialog is dismissed. (See
 *    ops/ripley-cluster.md → Windows screen-reader runner.)
 *  - Typing is the sharp edge of this port, for two reasons VoiceOver has no
 *    analogue of. (1) NVDA's itemText() is an ALIAS for lastSpokenPhrase()
 *    (guidepup lib/windows/NVDA/NVDA.js:527) — NOT a cursor-item read like VO's
 *    — so the label used to route focus must NOT come from it: the step before
 *    every `type` in the write plans is `interact`, whose only announcement is
 *    "focus mode", which stripNvdaBoilerplate correctly discards, leaving an
 *    empty label. The plan step's own milestone (AtStepContext.milestone, passed
 *    by replayPlan) is the label source that does not depend on NVDA speaking,
 *    so resolveFieldLabelCandidates ranks it first and keeps the speech-derived
 *    ones as fallbacks. (2) In BROWSE mode a plain letter is QUICK-NAV (h/k/e/f/b…),
 *    so a mis-routed 68-character string is not "text that went nowhere" but 68
 *    caret jumps across the document. `case "type"` therefore walks an explicit
 *    ladder, every rung of which debug()s its outcome — WHICH rung fired is
 *    itself an accessibility finding:
 *      −1  foreground guard (OS-level SendKeys needs Chromium foreground)
 *       0a probe: is DOM focus already a usable text field? → type immediately
 *       0b AT-native focus routing (moveToReviewPosition, then a SYMMETRIC
 *          browse/focus-mode toggle that undoes itself if it did not help)
 *       0c single-character safety valve (never spray 68 quick-nav keys)
 *       1  pure-AT type of the remaining characters
 *       2  host-assisted field focus + Control+a + retype
 *       3  atomic clipboard paste
 *       4  host value set (degraded fidelity — logged loudly, and recorded in
 *          typeFidelity, on which run.ts fails the task in enforce mode)
 *    WHICH rung carried each step, and the final landed verdict, leave this file
 *    as TypeStepFidelity records (takeTypeFidelity) — debug() alone let a
 *    keyboard-bypassing step report as a clean pass.
 *    Every rung is also deadline-gated: run() abandons a command that overruns
 *    its budget but cannot cancel it, and run.ts then retries the task on a
 *    fresh page — an un-gated ladder would keep typing into that page.
 *  - The CURSOR ORACLE (corroborateCursor) is the other half of the itemText()
 *    problem. Because itemText() is the speech TAIL, replayPlan's milestone
 *    check can pass on a phrase NVDA happened to say earlier while the review
 *    cursor sits somewhere else entirely — proven in run 30483480823, where an
 *    `act` step with milestone "reply" fired with the cursor on the page title
 *    and the task reported 0 RESYNCS, because the word "reply" was still in the
 *    log from reading the thread. NVDA can be ASKED where it is:
 *    reportCurrentObject (NVDA-NumPad5) speaks the navigator object on demand,
 *    and probe run 30681006352 measured that the answer tracks the cursor,
 *    repeats itself when the cursor holds still, and survives a poisoned speech
 *    tail. So before every state-changing command that carries a milestone, this
 *    driver asks — and every answer is recorded as an NvdaCursorCheck
 *    (takeCursorChecks) with one of five verdicts, because "the oracle can't
 *    say" and "the oracle disagrees" are different findings.
 *    The oracle is also a GATE, not only a record: verifyCursor implements
 *    AtDriver's optional cursor-verification hook, so replayPlan can ask before
 *    it accepts a milestone and keep resyncing when NVDA's cursor disagrees.
 *    Recording alone was not enough — run 30682097759 recorded 11 of 14
 *    state-changing steps firing on unrecorded elements and passed all three
 *    tasks anyway, because nothing consulted the record in time to act on it.
 */
// Type-only: @guidepup/guidepup resolves its platform implementation at import
// time and THROWS off-Windows, so the value import happens lazily in start().
import type { WindowsKeyCodes as WinKeys, WindowsModifiers as WinMods } from "@guidepup/guidepup";
import { execFile } from "node:child_process";
import {
  buildObservation,
  DEFAULT_NOISE_PATTERNS,
  READ_NEXT_MAX,
  type AtCommand,
  type AtDriver,
  type AtObservation,
  type AtStepContext,
  type AtStepRecord,
  type ControlHopDirection,
  type CursorVerdict
} from "../agent/atHarness";
// The cursor oracle guards exactly the commands replayPlan already calls
// state-changing. Imported rather than re-listed: a second copy of that set here
// would drift, and the whole point is to check the steps whose effect depends on
// what the cursor is on.
import { STATE_CHANGING_COMMANDS } from "../agent/replay";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

type Nvda = (typeof import("@guidepup/guidepup"))["nvda"];

/** NVDA announcements that carry no content: mode changes, load chrome. */
export const NVDA_BOILERPLATE_PATTERNS: RegExp[] = [
  /^browse mode$/i,
  /^focus mode$/i,
  /^loading/i,
  /^document$/i,
  /^web content$/i,
  /^busy/i,
  /^blank$/i
];

/**
 * The landmark roles NVDA names, as one alternation. ONE list: it builds both
 * the leading-landmark strip in NVDA_ITEM_PREFIX_PATTERNS and the container test
 * the `interact` guard uses (NVDA_CONTAINER_ITEM), so the two notions of "this
 * item is a landmark, not a control" cannot drift apart.
 */
const NVDA_LANDMARK_ROLES = "banner|navigation|main|complementary|content info|region|article|form";

/**
 * Leading role/state tokens NVDA prefixes onto an item ("heading, level 1, X";
 * "link, X"; "button, X"; "check box, not checked, X"). Stripped iteratively
 * from the START until stable; the label (which may itself end in "link" etc.)
 * is preserved.
 */
export const NVDA_ITEM_PREFIX_PATTERNS: RegExp[] = [
  /^heading,?\s*(level \d+,?\s*)?/i,
  /^(link|visited link|same page link),?\s*/i,
  /^button,?\s*/i,
  /^(graphic|image),?\s*/i,
  /^clickable,?\s*/i,
  /^(list|list box)(\s*with \d+ items)?,?\s*/i,
  /^(check box|checkbox),?\s*(checked|not checked|half checked),?\s*/i,
  /^radio button,?\s*(\d+ of \d+,?\s*)?/i,
  /^(edit|edit box),?\s*(multiline,?\s*)?(has auto complete,?\s*)?/i,
  /^combo box,?\s*/i,
  /^menu item,?\s*/i,
  /^tab,?\s*(\d+ of \d+,?\s*)?/i,
  new RegExp(`^(${NVDA_LANDMARK_ROLES}),?\\s*landmark,?\\s*`, "i")
];

/** Trailing state/position descriptors NVDA appends. */
export const NVDA_ITEM_SUFFIX_PATTERNS: RegExp[] = [
  /,?\s*\d+ of \d+$/i,
  /,?\s*(selected|not selected|expanded|collapsed|checked|not checked|current page|visited|clickable|pressed|not pressed)$/i,
  /,?\s*(button|link|heading|graphic|image|edit|combo box|check box|radio button|menu item|tab)$/i
];

/** VO's "Reply… Reply… Reply… text entry area" style — one chunk repeated. */
const NVDA_REPEATED_CHUNK = /^(.{3,}?)([,\s]+\1)+$/i;

/**
 * Role words that can also legitimately END a label ("Sign in with magic
 * link") — never stripped from the primary item; they feed currentItemAlternates
 * so milestone matching accepts either rendering.
 */
const NVDA_AMBIGUOUS_ROLE_SUFFIX = /\s+(button|link|tab|image|list|table|group|heading|main|article|banner)$/i;

/** Items meaning NVDA has left the page's web content for browser chrome. */
const NVDA_CURSOR_ESCAPED =
  /^(address and search bar|.* address and search|new tab|reload|.*- google chrome.*|toolbar|tab strip|bookmarks)$/i;
const MAX_ESCAPE_RECOVERIES = 8;

/** A modal credential dialog (title "Windows Security") that can seize the
 *  foreground on the CI desktop; NVDA then reads only it. */
const NVDA_SECURITY_DIALOG = /(windows security|credential|smart card|pick an account)/i;

const TRAPPED_MOVE_LIMIT = 4;
const MAX_TRAP_POPS = 3;
const NVDA_TEXT_ENTRY_CONTEXT = /(edit|multiline|text area|text field|combo box)/i;

/**
 * An item NVDA renders as a landmark: the role word plus the literal word
 * "landmark", with the accessible name either after it ("banner landmark") or
 * before it ("Skip links, navigation landmark").
 */
const NVDA_CONTAINER_ITEM = new RegExp(`(^|[,\\s])(${NVDA_LANDMARK_ROLES})\\s+landmark\\b`, "i");

/**
 * Does this item text describe a landmark CONTAINER rather than a control?
 * There is nothing for focus mode to enter on one, and NVDA+Space on one is the
 * wedge this driver's `interact` guard exists to avoid: "banner landmark",
 * "main landmark" and "Skip links, navigation landmark" are the exact items NVDA
 * reported at the `interact` step of the three write tasks in run 30455293803,
 * every one of which then went silent.
 *
 * Deliberately narrow, because `interact` is a legitimate step before every
 * `type` in the write plans and over-matching here would leave the caret in
 * browse mode where a letter is quick-nav: the literal word "landmark" is
 * required (so a label merely containing "main"/"form" is not a container), and
 * any text-entry wording anywhere in the phrase wins — NVDA announces the
 * landmark AND the field in one phrase when it enters one ("main landmark,
 * Search help requests edit"), and that IS a field to interact with.
 */
export function isNvdaContainerItem(item: string): boolean {
  const phrase = item.trim();
  return NVDA_CONTAINER_ITEM.test(phrase) && !NVDA_TEXT_ENTRY_CONTEXT.test(phrase);
}

/**
 * Consecutive commands that produced NO speech before we treat NVDA as wedged.
 *
 * A blank item is not "a quiet element": guidepup appends exactly one spoken-log
 * entry per captured gesture, and that entry is "" only when NVDA said nothing
 * at all inside the entry's 1s debounce window (NVDAClient.#processQueue →
 * `spokenPhrases.join(". ")`, SPEAK_DEBOUNCE_TIMEOUT) — and itemText() is an
 * alias for that log's tail. So a blank means the keystroke went in and NVDA
 * stayed silent, at a cost of ~2.25s (the #stopReading drain plus the full
 * debounce) to find out.
 *
 * Six, because a healthy run does produce short blank runs — an `act`/`press`
 * that activates something NVDA does not announce, followed by the `observe` of
 * the next milestone re-reading that same empty log tail, is already two — while
 * six in a row has no benign reading. Six also bounds the detection cost at
 * ~13s, against the ~10 minutes run 30455293803 spent blind.
 */
const BLANK_OBSERVATION_LIMIT = 6;

/**
 * Speech-loss recoveries allowed per task attempt.
 *
 * Three, not one, because silence has one BENIGN cause as well: NVDA announces
 * nothing when the review cursor cannot move at all, so a resync sweep or the
 * read-needle sweep that runs off the end of a short page produces a long blank
 * run in an otherwise healthy task. That case always recovers on the first try
 * (recovery ends in Control+Home, which re-announces), so it costs one detection
 * (~13s) and never fails the task — and re-entering the content top mid-sweep is
 * exactly what replayPlan's own last-resort unstick does anyway.
 *
 * The hard failure is therefore "recovery did not restore speech" (a real wedge),
 * plus this cap for the pathological middle: three separate blind stretches in
 * one attempt is flailing, not sweeping, and ~1 minute is where it stops being
 * worth another try. run.ts's per-task retry is the next chance.
 */
const MAX_SPEECH_RECOVERIES = 3;

/**
 * Field role/state tokens NVDA mixes INTO a form field's item text ("Search
 * help requests edit blank", "Reply… edit multiline required"). Unlike
 * NVDA_ITEM_SUFFIX_PATTERNS — which anchor at `$`, so a trailing "blank" blocks
 * the "edit" strip entirely — these are removed from ANYWHERE in the string.
 * Longest/multi-word first so "edit box" is consumed before bare "edit".
 */
const NVDA_FIELD_STATE_TOKENS = [
  "has auto complete",
  "has autocomplete",
  "invalid entry",
  "read only",
  "edit box",
  "multiline",
  "editable",
  "required",
  "blank",
  "edit"
];

/**
 * Role, state and structure words NVDA speaks AROUND an accessible name. Used
 * for exactly one question — does a phrase carry a NAME at all, or is it nothing
 * but role words? — which is the difference between "the oracle disagrees" and
 * "the oracle can't say". Probe run 30681006352 measured that plain text
 * collapses to a bare role ("Your pawsome course companion" → "paragraph"; "or"
 * → "paragraph"), so only 1 of 4 replies agreed with the speech tail; treating
 * the other three as disagreement would be pure noise.
 *
 * A separate list is unavoidable, and it does NOT duplicate the matching
 * pipeline. NVDA_ITEM_PREFIX_PATTERNS/NVDA_ITEM_SUFFIX_PATTERNS are anchored at
 * ^ and $ for SPEECH order (role first: "button, Continue with Microsoft"),
 * while reportCurrentObject answers in OBJECT order (name first, role after:
 * "Continue with Microsoft, button") — the anchors simply miss. Those strips and
 * nvdaFieldLabelVariants still run FIRST (see nvdaCursorTokens); this set only
 * sweeps up the single role words that survive them in the other word order.
 *
 * Erring long is the SAFE direction: an extra word here can only make a check
 * abstain, whereas a MISSING role word lets a bare-role reply look like a real
 * name and produces a false contradiction. Words that plausibly stand alone as a
 * control label ("complete", "post", "send", "search") are therefore NOT here,
 * even when NVDA also uses them inside a longer state phrase.
 *
 * Live run 30682097759 proved the cost of a gap. NVDA answered a bare "label"
 * on the survey page (step 1092), the word survived as a "content" token, and a
 * milestone of "just right" was reported CONTRADICTED — "nothing in common" —
 * when the oracle had in fact said nothing at all. The generic-container group
 * below closes that class: every entry is a bare NVDA controlTypes role name
 * that carries no accessible name with it ("label", "pane", "panel",
 * "unknown", "object"…), so a reply that reduces to only these now yields
 * `abstained`. None of them is plausible on its own as a Pawtograder control
 * label, which is the admission test this list has always applied.
 */
const NVDA_ROLE_TOKENS: ReadonlySet<string> = new Set([
  // structure
  "paragraph",
  "section",
  "heading",
  "level",
  "landmark",
  "banner",
  "navigation",
  "complementary",
  "region",
  "article",
  "form",
  "main",
  "document",
  "frame",
  "application",
  "group",
  "grouping",
  "separator",
  "toolbar",
  "dialog",
  "alert",
  "status",
  "header",
  "footer",
  "web",
  "content",
  "info",
  // controls
  "button",
  "link",
  "edit",
  "box",
  "combo",
  "list",
  "item",
  "items",
  "listbox",
  "menu",
  "menubar",
  "tab",
  "tabs",
  "checkbox",
  "check",
  "radio",
  "slider",
  "spinbutton",
  "spin",
  "progress",
  "bar",
  "tree",
  "treeview",
  "view",
  "grid",
  "table",
  "row",
  "column",
  "cell",
  "image",
  "graphic",
  "icon",
  "text",
  "textbox",
  "field",
  // generic containers and wrappers — what NVDA falls back to when the object
  // under the cursor has no accessible name of its own. These are the replies
  // that say NOTHING about where the cursor is, so they must reduce to zero
  // content tokens and abstain (run 30682097759: a bare "label" did not, and a
  // milestone of "just right" was called a contradiction on that basis).
  "label",
  "pane",
  "panel",
  "container",
  "window",
  "unknown",
  "object",
  "embedded",
  "viewport",
  "static",
  "whitespace",
  "filler",
  "generic",
  "presentation",
  "iframe",
  "scroll",
  "split",
  "tooltip",
  "popup",
  "submenu",
  "listitem",
  "menuitem",
  "treegrid",
  "blockquote",
  // states and positions
  "checked",
  "unchecked",
  "not",
  "half",
  "selected",
  "unselected",
  "expanded",
  "collapsed",
  "pressed",
  "visited",
  "clickable",
  // "linked" is what NVDA appends to an object inside a link, observed verbatim
  // in run 30682097759 ("E 2E A 11y Agent Class, link, linked").
  "linked",
  "unavailable",
  "grayed",
  "hidden",
  "offscreen",
  "modal",
  "indeterminate",
  "mixed",
  "current",
  "page",
  "required",
  "invalid",
  "entry",
  "readonly",
  "read",
  "only",
  "disabled",
  "blank",
  "busy",
  "loading",
  "editable",
  "multiline",
  "has",
  "auto",
  "autocomplete",
  "focusable",
  "focused",
  "sorted",
  "ascending",
  "descending",
  "of",
  "out",
  "with"
]);

/**
 * Post-gesture settle before reading the cursor oracle's answer. The harness's
 * proven pattern (focusBrowserWindow performs reportTitle, sleeps, then reads
 * the tail) and the exact one probe run 30681006352 measured — capture
 * "initial" resolves on the FIRST phrase, but a multi-phrase object report is
 * still arriving.
 */
const CURSOR_ORACLE_SETTLE_MS = 400;

/**
 * Ceiling for the oracle's own gesture, and (halved) for the log reads either
 * side of it. Worst case per checked step is therefore 2 + 4 + 0.4 + 2 ≈ 8.4s
 * against replayPlan's 30s per-command budget, on a command (`act`, `interact`)
 * that normally costs ~2.25s — measured cost is ~1.5-2.5s. `type` is
 * deliberately NOT checked (see corroborateCursor), so the length-scaled type
 * budget and its deadline gate are untouched.
 */
const CURSOR_ORACLE_TIMEOUT_MS = 4_000;
const CURSOR_ORACLE_LOG_TIMEOUT_MS = 2_000;

/**
 * Longest milestone, in content words, still treated as a CONTROL LABEL worth
 * asking the oracle about. Beyond it the milestone is prose — a paragraph the
 * agent's cursor rested on — and the oracle would answer "paragraph", which is
 * not evidence of anything. Eight because every milestone in the promoted plans
 * today is ≤ 4 words ("submit request", "what is your name?"), so this only ever
 * fires on genuinely sentence-shaped templates. Skipping is always safe;
 * contradicting wrongly is not.
 */
const CURSOR_ORACLE_MAX_MILESTONE_WORDS = 8;

/**
 * How long to wait before probing DOM focus after a focus-routing gesture.
 * NVDA's automatic browse→focus mode switch (plus the app's own focus handlers)
 * is slower than macOS VoiceOver cursor tracking — the 250ms inherited from the
 * VO port was short enough to read focus BEFORE it moved.
 */
const NVDA_FOCUS_SETTLE_MS = 400;

/** Per-gesture ceiling for the internal focus-routing rungs. Small on purpose:
 *  these sit inside the type command's own budget (see the deadline in
 *  `case "type"`), and guidepup's client queue is serial, so a gesture that
 *  overruns delays every later rung rather than being skipped. */
const FOCUS_RUNG_TIMEOUT_MS = 4_000;

/** itemText() budget when called from inside the type ladder (vs the 30s
 *  default used by the setup paths). */
const ITEM_TEXT_PROBE_MS = 2_000;

/** Per-gesture ceiling for a control hop (AtDriver.moveToControl). Same size and
 *  same reasoning as FOCUS_RUNG_TIMEOUT_MS: it is one quick-nav keystroke, the
 *  caller applies no timeout of its own (see the hook's contract), and replayPlan
 *  may spend up to CONTROL_SWEEP_LIMIT * 3 of them on one milestone (32 forward
 *  plus 64 back, after run 30775582313 showed 8 was consumed by page chrome). */
const CONTROL_HOP_TIMEOUT_MS = 4_000;

/**
 * Post-hop settle, for the same reason CURSOR_ORACLE_SETTLE_MS and the
 * `interact` post-check exist: capture "initial" resolves on the FIRST phrase,
 * and NVDA announces a button as name-then-role. The `observe` that replayPlan
 * runs next is what has to see the whole announcement, because that string is
 * what the milestone is matched against.
 */
const CONTROL_HOP_SETTLE_MS = 400;

/**
 * How long to wait before RE-READING a field we just host-cleared. The clear is
 * a native-setter write plus a bubbling `input` event, so a controlled React
 * field is only really empty once its own re-render lands — reading back inside
 * the same eval would report "cleared" while component state still holds the old
 * text, which is precisely the false confidence this whole change is about.
 * 250ms matches the first rung-0c append probe wait, which is empirically enough
 * for this app's re-render.
 */
const HOST_CLEAR_CONFIRM_MS = 250;

/** Alt+Esc window-switch attempts in the type path's foreground guard. Four,
 *  not twelve: each costs ~0.9s and the whole guard sits inside the type
 *  budget. The setup path (focusWebArea) keeps its longer, speech-verified
 *  search. */
const FOREGROUND_ATTEMPTS = 4;

/** Tighter than FOCUS_RUNG_TIMEOUT_MS: four attempts at the focus-rung ceiling
 *  would be 19s of a 42s budget on their own. An Alt+Esc that takes >2s means
 *  guidepup is wedged, and the deadline gate is the real protection then. */
const FOREGROUND_SWITCH_TIMEOUT_MS = 2_000;

/** Shortest usable label candidate, measured after clean(). Two characters
 *  substring-matches "Notes" and "Phone number". */
const MIN_LABEL_CANDIDATE_CHARS = 3;

/** A normalize.ts placeholder ({{number}}, {{date}}, {{studentName}}) inside a
 *  plan milestone. Removed before the milestone is used as a field label: it
 *  stands for seed-specific content, and clean() would otherwise turn the braces
 *  into whitespace and leave "number" as if the field were named that. What is
 *  left of the milestone still has to clear MIN_LABEL_CANDIDATE_CHARS. */
const MILESTONE_PLACEHOLDER = /\{\{[^}]*\}\}/g;

/**
 * `input` types that cannot accept typed text. ONE list, used both to build the
 * query selector (so we never .focus() something) and by the focus probe (so we
 * never reject something we just focused) — they drifted apart before.
 */
const NON_TEXT_INPUT_TYPES = [
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "hidden",
  "range",
  "color",
  "date",
  "datetime-local",
  "month",
  "time",
  "week"
];

const FIELD_SELECTOR = `input${NON_TEXT_INPUT_TYPES.map((t) => `:not([type=${t}])`).join("")}, textarea, [contenteditable="true"]`;

/**
 * Controls whose VALUE an arrow key changes when NVDA is in focus mode — the
 * reason `next`/`previous` are not the pure reading commands this driver treats
 * them as.
 *
 * `next` is ArrowDown (see moveToControl's preamble). In BROWSE mode that moves
 * the review caret by line and changes nothing. In FOCUS mode the keystroke goes
 * to the control, and for a radio group ArrowDown does not merely move — it
 * MOVES AND SELECTS, because that is native radio-group behaviour on every
 * platform. So a sweep looking for a milestone rewrites the answer it is
 * reading, once per press.
 *
 * That is the whole of issue #913, which was filed against the app as "NVDA
 * announces all three survey options as checked". NVDA was right every time.
 * Driving the seeded survey's q2 group in focus mode and reading the DOM back
 * after each press:
 *
 *   press#1 spoken="Just right, radio button, checked, 2 of 3"  DOM=Just right
 *   press#2 spoken="Too fast,   radio button, checked, 3 of 3"  DOM=Too fast
 *   press#3 spoken="Too slow,   radio button, checked, 1 of 3"  DOM=Too slow
 *
 * Every named radio says "checked" because the arrow that reached it also
 * checked it; the only "not checked" in the run is the first announcement, which
 * focus (not an arrow) arrived at. VoiceOver never showed this because VO+arrow
 * moves the VO cursor without activating, which is why the same commit read
 * correctly on macOS and made the divergence look like an app bug.
 *
 * A browse-mode sweep over the same markup announces "not checked / checked /
 * not checked", identical to plain `<input type=radio>` — so this list is about
 * the DRIVER's gestures, not about any markup the app can fix.
 *
 * `checkbox` is deliberately absent: Space toggles a checkbox, arrows do not.
 */
/**
 * Does a browse LINE announce a control of its own?
 *
 * The discriminator retargetActToControl turns on. NVDA renders a control the
 * user can activate with its role in the line ("Privacy (Optional), check box,
 * checked, ..."), whereas the SurveyJS choice defect leaves a line of pure label
 * text with no role word at all ("Just right") while the control sits on the
 * previous line, nameless. Enter works on the first and is a dead key on the
 * second, and nothing else in the observation distinguishes them — both report a
 * bare `label` navigator object.
 */
export const ACT_LINE_NAMES_A_CONTROL =
  /\b(check ?box|radio button|button|link|edit|combo box|list box|slider|spin button|menu item|tab|tree view|graphic)\b/i;

const ARROW_MUTABLE_SELECTOR = [
  "input[type=radio]",
  "input[type=range]",
  "input[type=number]",
  "input[type=date]",
  "input[type=datetime-local]",
  "input[type=month]",
  "input[type=time]",
  "input[type=week]",
  "select"
].join(", ");

/** Page-side globals: the element hostFocusField routed to (so verification can
 *  tell "the text landed" from "the text landed SOMEWHERE"), and the element the
 *  rung 0c probe measured (so before/after are the same element). Namespaced,
 *  and cleared/overwritten on every use — a page navigation drops them anyway. */
const FOCUS_TARGET_KEY = "__a11yJudgeFocusTarget";
const PROBE_ELEMENT_KEY = "__a11yJudgeProbeElement";
/** The arrow-mutable control a sweep step is about to arrow past, remembered so
 *  the after-reading and any restore address the SAME element (see hostFieldValue,
 *  which learned the same lesson: a focus change mid-probe otherwise reads as a
 *  successful move). */
const SWEEP_ELEMENT_KEY = "__a11yJudgeSweepElement";

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Host-eval results are "verdict|detail"; detail may itself contain "|". */
function splitHostResult(raw: string): [string, string] {
  const at = raw.indexOf("|");
  return at < 0 ? [raw, ""] : [raw.slice(0, at), raw.slice(at + 1)];
}

/**
 * Page-side expression that ASSIGNS `text` to document.activeElement through the
 * element's own native value setter (React's value tracker swallows a plain
 * `el.value = ...`), then dispatches bubbling input/change so the app's state
 * follows. Assignment, never insertion: the whole previous value goes.
 *
 * ONE builder for both DOM writes in this file — rung 4's hostSetValue and the
 * pre-retype hostClearField — because a clear that took a different path from the
 * set would prove nothing about the set. (NON_TEXT_INPUT_TYPES carries the same
 * warning: these two drifted apart once already.)
 *
 * Guards on the ELEMENT, not the prototype: the original picked
 * HTMLInputElement.prototype's value setter whenever the tag was not TEXTAREA and
 * only checked that the setter existed, so calling it on MAIN/BODY/DIV threw
 * "TypeError: Illegal invocation" every single time it was reached. Returns a
 * diagnostic instead of throwing: 'wrote|WHERE|<value read straight back>', or
 * 'no-active|' / 'not-a-field|' / 'no-setter|' / 'setter-threw|'.
 */
function hostFieldWriteJs(text: string): string {
  return `(() => {
    const el = document.activeElement;
    const text = ${JSON.stringify(text)};
    if (!el || el === document.body) return 'no-active|' + (el ? el.tagName : 'none');
    const where = el.tagName + (el.id ? '#' + el.id : '');
    if (el.isContentEditable) { el.textContent = text; }
    else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc || !desc.set) return 'no-setter|' + where;
      try { desc.set.call(el, text); } catch (e) { return 'setter-threw|' + where + '|' + String((e && e.message) || e); }
    } else {
      return 'not-a-field|' + where;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const back = el.isContentEditable ? (el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value);
    return 'wrote|' + where + '|' + back;
  })()`;
}

/**
 * Page-side expression reading the ANSWER the focused arrow-mutable control
 * carries, as a comparable string. Returns 'none|', 'safe|<TAG>' (focus is not
 * on such a control — the overwhelmingly common case, and the cheap exit), or
 * '<kind>|<key>|<value>'.
 *
 * For a radio the value is the group's CHECKED member, not the focused one:
 * focus and selection are different things in a radio group, and it is the
 * selection a sweep must not disturb. Everything else reports its own value.
 *
 * `remember` stashes the element so the reading taken after the arrow, and any
 * restore, address the same node.
 */
function sweepSignatureJs(remember: boolean): string {
  return `(() => {
    const el = ${remember ? "document.activeElement" : `window[${JSON.stringify(SWEEP_ELEMENT_KEY)}] || document.activeElement`};
    ${remember ? `window[${JSON.stringify(SWEEP_ELEMENT_KEY)}] = el;` : ""}
    if (!el || el === document.body || !el.matches) return 'none|';
    if (!el.matches(${JSON.stringify(ARROW_MUTABLE_SELECTOR)})) return 'safe|' + el.tagName;
    if (el.tagName === 'INPUT' && el.type === 'radio') {
      if (!el.name) return 'radio|<unnamed>|' + (el.checked ? el.value : '<none>');
      const picked = el.form
        ? [...el.form.querySelectorAll('input[type=radio]')].find((r) => r.name === el.name && r.checked)
        : [...document.querySelectorAll('input[type=radio]')].find((r) => r.name === el.name && r.checked);
      return 'radio|' + el.name + '|' + (picked ? picked.value : '<none>');
    }
    return 'value|' + (el.name || el.id || el.tagName) + '|' + String(el.value == null ? '' : el.value);
  })()`;
}

/**
 * Page-side expression putting back the selection a sweep step changed, through
 * the same native-setter-plus-bubbling-events path hostFieldWriteJs uses (a
 * plain assignment is swallowed by React's value tracker).
 *
 * This is a DOM write, and like rung 4's hostSetValue it is recorded rather than
 * hidden — see SweepMutation. Restoring is nevertheless the right default: the
 * alternative is that whatever the sweep last landed on gets submitted and then
 * reported as the screen-reader user's answer, which is precisely how #913
 * stayed invisible for as long as it did.
 */
function sweepRestoreJs(kind: string, key: string, value: string): string {
  return `(() => {
    const kind = ${JSON.stringify(kind)}, key = ${JSON.stringify(key)}, want = ${JSON.stringify(value)};
    const el = window[${JSON.stringify(SWEEP_ELEMENT_KEY)}];
    if (!el || !el.isConnected) return 'no-element|';
    const fire = (n) => { n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); };
    if (kind === 'radio') {
      const scope = el.form || document;
      const group = [...scope.querySelectorAll('input[type=radio]')].filter((r) => r.name === key);
      if (!group.length) return 'no-group|' + key;
      const target = group.find((r) => r.value === want);
      if (!target) { group.forEach((r) => { r.checked = false; }); fire(el); return 'cleared|' + key; }
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) { desc.set.call(target, true); } else { target.checked = true; }
      fire(target);
      return 'restored|' + key + '|' + target.value;
    }
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || !desc.set) return 'no-setter|' + key;
    try { desc.set.call(el, want); } catch (e) { return 'setter-threw|' + key + '|' + String((e && e.message) || e); }
    fire(el);
    return 'restored|' + key + '|' + String(el.value == null ? '' : el.value);
  })()`;
}

/**
 * Page-side "did that Enter change an ANSWER?" signature.
 *
 * Checkable state only — deliberately not focus, and not location. Run
 * 31312543653 is why: this began as checked-state plus activeElement plus href,
 * and Enter on a SurveyJS label moves focus to BODY while changing nothing at
 * all, so the signature differed, the Enter was scored as effective and the
 * retarget never ran. Focus moving is not an answer being given.
 *
 * The `act` retarget only ever engages on a line of bare label text (see
 * retargetActToControl), where Enter either activates the control the label
 * belongs to or does nothing — and every such control in these plans is a
 * checkbox or a radio. Buttons and links never reach this path: their lines name
 * their own role.
 */
/** The prefix keeps "nothing is checked" (a real, common reading — the survey
 *  starts blank) distinguishable from "the host read failed", which hostEval
 *  reports as the empty string. */
const ACT_SIGNATURE_PREFIX = "checked:";

function actStateSignatureJs(): string {
  return `(() => {
    return ${JSON.stringify(ACT_SIGNATURE_PREFIX)} + [...document.querySelectorAll('input[type=checkbox],input[type=radio]')]
      .filter((i) => i.checked)
      .map((i) => (i.name || i.id || '?') + '=' + i.value)
      .join(',');
  })()`;
}

const tidyLabel = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/(?:\s*,\s*)+/g, ", ")
    .replace(/^[\s,]+/, "")
    .replace(/[\s,]+$/, "")
    .trim();

/** Every intermediate rendering as one state token at a time is removed; the
 *  terminal entry is "" when the input was nothing but role/state noise. */
function fieldStateStripChain(item: string): string[] {
  const chain: string[] = [];
  let current = tidyLabel(item);
  for (let guard = 0; guard <= NVDA_FIELD_STATE_TOKENS.length; guard++) {
    const before = current;
    for (const token of NVDA_FIELD_STATE_TOKENS) {
      const next = current.replace(new RegExp(`(^|[,\\s])${token}(?=[,\\s]|$)`, "i"), "$1");
      if (next !== current) {
        current = tidyLabel(next);
        break;
      }
    }
    if (current === before) break;
    chain.push(current);
  }
  return chain;
}

/**
 * Progressively strip NVDA_FIELD_STATE_TOKENS, returning every intermediate
 * rendering (least-stripped first) so hostFocusField can try the most specific
 * label before the most permissive one: "Reply… edit multiline blank" →
 * ["Reply… edit blank", "Reply… edit", "Reply…"].
 */
export function nvdaFieldLabelVariants(item: string): string[] {
  const variants: string[] = [];
  for (const variant of fieldStateStripChain(item)) {
    if (variant.length > 0 && !variants.includes(variant)) variants.push(variant);
  }
  return variants;
}

/** True when a string is nothing BUT role/state noise ("blank", "edit blank"):
 *  such a "label" would match arbitrary fields, so it is never a candidate. */
function isPureFieldState(item: string): boolean {
  const chain = fieldStateStripChain(item);
  return chain.length > 0 && chain[chain.length - 1].length === 0;
}

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function stripNvdaBoilerplate(phrase: string): string | null {
  if (NVDA_BOILERPLATE_PATTERNS.some((re) => re.test(phrase.trim()))) return null;
  let p = phrase.trim();
  let previous;
  do {
    previous = p;
    for (const re of NVDA_ITEM_PREFIX_PATTERNS) p = p.replace(re, "").trim();
    for (const re of NVDA_ITEM_SUFFIX_PATTERNS) p = p.replace(re, "").trim();
    p = p.replace(NVDA_REPEATED_CHUNK, "$1").trim();
  } while (p !== previous && p.length > 0);
  return p.length > 0 ? p : null;
}

/**
 * Tokenize a phrase for ORDER-INSENSITIVE cursor matching, through the same
 * normalization the rest of this file uses rather than a parallel pipeline:
 * stripNvdaBoilerplate for the role words NVDA anchors at the start/end of a
 * phrase, nvdaFieldLabelVariants for the field-state words it mixes into the
 * middle ("Reply… edit multiline required"), then clean() for case and
 * punctuation — which is what lets the recorded "reply..." and NVDA's "Reply…"
 * (U+2026) meet, exactly as hostFocusField already relies on.
 *
 * Word order is discarded on purpose. reportCurrentObject answers name-first
 * where speech is role-first — measured pair from run 30681006352: tail "button,
 * Continue with Microsoft (Northeastern Login)" vs reply "Continue with
 * Microsoft (Northeastern Login), button" — so string equality misses on
 * identical content. Sets of words do not care.
 *
 * `content` drops role words and bare numbers, and is the only side of the
 * comparison that means anything: two phrases sharing nothing but "button" have
 * nothing in common.
 */
export function nvdaCursorTokens(phrase: string): { tokens: string[]; content: string[] } {
  const stripped = stripNvdaBoilerplate(phrase) ?? phrase;
  // .at(-1) is the MOST stripped rendering (fieldStateStripChain pushes one
  // token removal per entry); [] means there was no field-state noise at all.
  const reduced = nvdaFieldLabelVariants(stripped).at(-1) ?? stripped;
  const tokens = clean(reduced).split(" ").filter(Boolean);
  const content = tokens.filter((token) => !NVDA_ROLE_TOKENS.has(token) && !/^\d+$/.test(token));
  return { tokens, content };
}

/**
 * Most comma-aligned suffixes of one item offered as currentItemAlternates. Six
 * is pure headroom: across run 30702006927's 193 distinct items, 68 produce any
 * at all and none produces more than 2 (mean 1.31). The cap exists only to bound
 * a pathological line — NVDA renders a table row as one, and "row 2, Due Date
 * (America slash New York), column 1, through 5, …" is already 5 segments — and
 * it keeps the SHORTEST suffixes, which are the ones that name a single control.
 */
export const NVDA_MAX_LINE_ALTERNATES = 6;

/**
 * Comma-aligned SUFFIXES of an item, offered as alternate renderings of what the
 * cursor is on (AtObservation.currentItemAlternates, the same channel the
 * announced/role-free renderings below already use).
 *
 * NVDA speaks a browse-mode LINE as one comma-joined run of segments: the
 * containers it entered or left ("out of grouping", "Office Hours, region"), the
 * role and state words ("clickable", "heading, level 2"), and the accessible
 * NAME — and when a line holds several inline controls it speaks ALL of them in
 * that one utterance. The plans were recorded on the virtual screen reader,
 * which walks one CONTROL at a time, so a milestone names ONE segment. Milestone
 * matching is anchored at the HEAD of the phrase (normalize.ts templateMatches /
 * templatePrefixMatches), so a milestone NVDA speaks anywhere but first can
 * never match, however often the resync sweep walks over it.
 *
 * Run 30702006927 exhausted all 125 resync presses twice on items that CONTAINED
 * their own milestone, and the milestone gate never fired once in either sweep
 * because nothing ever claimed a match:
 *   survey-complete,  "any other feedback?"
 *     cmd#1442 item="out of grouping, clickable, heading, level 2, Any other feedback?"
 *     cmd#1359 item="out of edit, clickable, heading, level 2, Any other feedback?"
 *   discussion-reply, "reply"
 *     cmd#164  item="Like (0 likes), button, Edit, button, Reply"
 *     cmd#78   item="Discussion, region, button, Like (0 likes), button, Edit, button, Reply"
 *
 * SUFFIXES, not arbitrary substrings, because a comma is where NVDA joins
 * segments — and suffixes alone reach INTERIOR segments too, since
 * templatePrefixMatches already matches a template at the head of one ("edit"
 * matches the alternate "Edit, button, Reply"). So this adds exactly one degree
 * of freedom (where the name STARTS), not free-form containment.
 *
 * A suffix that starts on role/state/number words is dropped, reusing
 * NVDA_ROLE_TOKENS rather than a second vocabulary: such a suffix names nothing
 * the head-anchored matcher cannot already reach, and it is the shape that would
 * let a bare "button"/"heading" hijack a sweep. Measured before shipping by
 * replaying every distinct item of run 30702006927 (193 of them) against all 13
 * milestones of the three write plans: the rule flips exactly 9 verdicts, and in
 * every one the suffix is the item's own accessible name.
 */
export function nvdaLineSegmentAlternates(item: string): string[] {
  const segments = item
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const alternates: string[] = [];
  // From 1: segment 0 is already the head of the primary item, which the
  // head-anchored matcher sees without any help.
  for (let index = 1; index < segments.length; index++) {
    const words = clean(segments[index]).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((word) => NVDA_ROLE_TOKENS.has(word) || /^\d+$/.test(word))) continue;
    alternates.push(segments.slice(index).join(", "));
  }
  return alternates.slice(-NVDA_MAX_LINE_ALTERNATES);
}

/**
 * Can the cursor oracle possibly judge this milestone? Asked BEFORE spending the
 * round trip, because an oracle that cannot help must not cost ~2s per step —
 * and, more importantly, because an inconclusive answer must never be mistaken
 * for a contradiction.
 */
export function cursorOracleApplies(milestone: string | undefined): {
  applies: boolean;
  tokens: string[];
  reason: string;
} {
  if (!milestone || !milestone.trim()) return { applies: false, tokens: [], reason: "step carries no milestone" };
  // A milestone is a normalize.ts TEMPLATE: placeholders stand for seed-specific
  // content, and clean() would leave the literal words "number"/"studentname"
  // behind as if they were part of the name (the same reason
  // resolveFieldLabelCandidates strips them before using one as a field label).
  const { content } = nvdaCursorTokens(milestone.replace(MILESTONE_PLACEHOLDER, " "));
  if (content.length === 0) {
    return { applies: false, tokens: [], reason: "milestone is nothing but role/state/number words" };
  }
  if (content.length > CURSOR_ORACLE_MAX_MILESTONE_WORDS) {
    return {
      applies: false,
      tokens: content,
      reason: `milestone is ${content.length} content words — prose, not a control label, so the oracle would answer with a bare role`
    };
  }
  return { applies: true, tokens: content, reason: "milestone looks like a control label" };
}

/**
 * Compare a milestone's content words with what reportCurrentObject just said.
 *
 * "abstained" is the load-bearing verdict: the oracle is decisive for CONTROLS
 * (it speaks name + role) and near-useless for TEXT (it collapses to a bare
 * role), so a reply with no nameable words says nothing about where the cursor
 * is and must never be reported as disagreement.
 *
 * Agreement is deliberately generous — ANY shared content word — and
 * contradiction correspondingly strict: ZERO words in common. Both sides can
 * legitimately be longer than the other (real AT computes a fuller accessible
 * name than the recorder did: "post" vs "Post as Agent Student"; and NVDA adds
 * container context), so a subset test in either direction is already implied,
 * and demanding more than overlap would turn ordinary name drift into a false
 * alarm. Zero overlap is what the proven failure looks like: milestone "reply"
 * against "E 2E A 11y Agent Class Pawtograder" (run 30483480823).
 */
export function judgeCursorOracle(
  milestoneTokens: string[],
  reply: string
): { verdict: "agreed" | "contradicted" | "abstained"; objectTokens: string[]; shared: string[] } {
  const { content: objectTokens } = nvdaCursorTokens(reply);
  if (objectTokens.length === 0) {
    // One nameless answer IS conclusive, and it reuses this file's existing,
    // calibrated notion of a container rather than a second opinion: NVDA named
    // a landmark with no accessible name at all ("banner landmark"), while the
    // milestone names a control. That is not "cannot say" — it is the cursor
    // sitting on a container, which is the state that wedged run 30455293803.
    // isNvdaContainerItem excludes phrases carrying text-entry wording ("main
    // landmark, Search help requests edit"), and such a reply has content
    // tokens anyway, so it never reaches here.
    if (isNvdaContainerItem(reply)) return { verdict: "contradicted", objectTokens, shared: [] };
    return { verdict: "abstained", objectTokens, shared: [] };
  }
  const wanted = new Set(milestoneTokens);
  const shared = [...new Set(objectTokens.filter((token) => wanted.has(token)))];
  return { verdict: shared.length > 0 ? "agreed" : "contradicted", objectTokens, shared };
}

/** Kill the transient PickerHost/credential-broker dialogs (fire and forget). */
function dismissSecurityDialog(): void {
  for (const im of ["PickerHost.exe", "CredentialUIBroker.exe", "consent.exe"]) {
    execFile("taskkill", ["/im", im, "/f"], () => {});
  }
}

export class NvdaCommandTimeoutError extends Error {}
export class NvdaUnsupportedCommandError extends Error {}

/**
 * NVDA has stopped speaking, so every observation is empty and the replay is
 * blind: milestones cannot match, the needle sweep cannot hit, and `type` would
 * fire at whatever the cursor was last parked on. Thrown from run() like
 * NvdaCommandTimeoutError (and, like it, ends the attempt: run.ts fails the
 * attempt, retries the task once on a fresh page, then fails the task with this
 * message). Distinct from a timeout because the failure it names is different —
 * a wedged run 30455293803 surfaced only as `readNext hung for 30000ms`, ~12
 * minutes after the actual cause.
 */
export class NvdaSpeechLostError extends Error {}

/**
 * The most recent observation whose item carried real CONTENT (survived
 * stripNvdaBoilerplate). This — not itemText() — is the label source for
 * focus routing: itemText() is an alias for lastSpokenPhrase(), and the step
 * immediately before every `type` is `interact`, which speaks only "focus
 * mode"/"browse mode" (both boilerplate), so reading it at type time yields "".
 */
interface NvdaContentItem {
  primary: string;
  alternates: string[];
  raw: string;
}

/** Outcome of a focus-routing attempt — WHICH strategy fired, and on what. */
interface FocusRoute {
  strategy: string;
  detail: string;
}

/** Which rung of the pre-type focus ladder ended up carrying the step. */
interface FocusRouting {
  ok: boolean;
  rung: string;
  detail: string;
}

/**
 * Tri-state host answer. "unknown" is NOT "no": ChromeHost.evalJs throws on any
 * CDP hiccup (target detached, page mid-navigation), and treating that as "no"
 * escalates the ladder toward its destructive rungs on the strength of a
 * transient error. Every host probe reports it separately, and the ladder never
 * escalates on it.
 */
type HostVerdict = "yes" | "no" | "unknown";

/** Outcome of the post-type host verification (root cause: the old boolean
 *  conflated "wrong element" with "text missing" and with "check failed").
 *  `skipped-rung-1`, `unclearable-field` and `no-host-channel` are synthesised by
 *  the ladder, not returned by typedTextLanded. */
interface LandedCheck {
  landed: boolean;
  reason:
    | "match"
    | "mismatch"
    /** The field CONTAINS the expected text but also holds content this step
     *  cannot account for — the doubled-write signature from run 30457321723,
     *  which containment matching reported as `match`. */
    | "extra-content"
    | "wrong-field"
    | "not-a-field"
    | "no-active"
    | "inconclusive"
    | "no-host-channel"
    | "skipped-rung-1"
    /** A retype/paste was skipped because the field demonstrably still held its
     *  old content after a host clear: typing there APPENDS, which is how the
     *  doubling happened. */
    | "unclearable-field";
  detail: string;
}

/**
 * Outcome of a pre-retype host clear. Tri-state for the same reason as
 * HostVerdict: "unknown" (the confirming read failed) is NOT "the field still
 * has content", and the ladder must not escalate to its degraded rung on a
 * transient CDP error.
 */
interface HostClearResult {
  verdict: "cleared" | "dirty" | "unknown";
  /** What the confirming read still saw in the field (empty when cleared). */
  residue: string;
  detail: string;
}

/** Reading of the focused field's value for the rung 0c append probe. */
interface FieldValueProbe {
  verdict: "ok" | "nofield" | "unknown";
  value: string;
  /** False when this reading came from a DIFFERENT element than the remembered
   *  one — a focus change mid-probe otherwise reads as a successful append. */
  sameElement: boolean;
  detail: string;
}

/** Which rung of the `type` ladder actually wrote the text into the field. */
export type TypeRung = "1" | "2" | "3" | "4";

/** Verdict recorded for a `type` step: the post-type verification reason, plus
 *  the three exits that never reach a verification at all. */
export type TypeFidelityReason = LandedCheck["reason"] | "unverified" | "budget-expired" | "command-threw";

/**
 * Fidelity record for one `type` step — the machine-readable form of what the
 * ladder's debug() lines already say, and the reason it exists: rung 4
 * (hostSetValue) sets the field's value from the DOM, so a step that reached it
 * "succeeded" with the keyboard bypassed entirely. That is a FINDING about the
 * field (a real screen-reader user could not have typed into it), not a harness
 * detail — but while its only trace was a debug line, such a step recorded as a
 * clean pass and the whole run went green. Same for a final `landed: false`.
 * Trusting that green is the mistake this lane already made once, with
 * `--calibrate` runs that skipped the write predicate.
 *
 * run.ts drains these per task (takeTypeFidelity), prints them, ships them in
 * the artifacts, and in enforce mode fails the task on them.
 */
export interface TypeStepFidelity {
  /** Index of this `type` step in NvdaHarness.steps. */
  stepIndex: number;
  /** The typed text, truncated — enough to identify the step in a report. */
  text: string;
  /** Rung of the pre-type focus ladder that routed focus (FocusRouting.rung). */
  focusRoute: string;
  /** Rung that finally satisfied the step; null when none of them did. */
  carriedBy: TypeRung | null;
  /** Did rung 4 fire? True means the keyboard never got the text in. */
  hostSetValue: boolean;
  /**
   * Did a rung host-clear the field before retyping/pasting, and did the
   * confirming read agree? "none" for the pure-AT path, which never clears.
   *
   * Recorded rather than left in debug() for the same reason hostSetValue is: it
   * is a DOM write. It does NOT make the step degraded — the typing itself is
   * still real keystrokes and rung 2's Control+a always meant "replace the
   * contents" — but a reader of the artifacts must be able to see that the
   * emptying was done for the app rather than by it. "dirty" means we refused to
   * type into a field we could not empty (see LandedCheck.unclearable-field).
   */
  hostClear: HostClearResult["verdict"] | "none";
  /** Final post-type verification verdict (the last typedTextLanded call). */
  landed: boolean;
  reason: TypeFidelityReason;
  detail: string;
  /** rung 4 fired, or verification says the text is not in the field. Either
   *  half is an app finding; enforce mode fails the task on it. Unverifiable
   *  steps ("unverified"/"inconclusive") are NOT degraded — this file's
   *  standing rule is that a lost verification is not a proven failure. */
  degraded: boolean;
}

/**
 * A `next`/`previous` step that changed the page's ANSWERS instead of merely
 * reading them, drained per task by takeSweepMutations().
 *
 * It exists for the same reason TypeStepFidelity and NvdaCursorCheck do: the
 * lane's whole claim is that a screen-reader user can complete the task, and a
 * sweep that rewrites a radio group on its way past makes the recorded answer
 * an artefact of the driver. Issue #913 spent its life as an app accessibility
 * bug ("all three options announce as checked", filed against 4.1.2 Name, Role,
 * Value) because nothing in the run said the sweep had touched anything, and the
 * survey lane asserted only `survey_responses.is_submitted === true`.
 *
 * `restored` is a separate field from `mutated` on purpose: putting the value
 * back keeps the REST of the task honest, but it does not make the step a
 * reading, and run.ts fails the task on `mutated` regardless of whether the
 * repair worked.
 */
export interface SweepMutation {
  /** Index this step has in NvdaHarness.steps. */
  stepIndex: number;
  command: "next" | "previous" | "readNext";
  /** 'radio' or 'value' — which arrow-mutable control was under focus. */
  kind: string;
  /** Radio group name, or the control's name/id. */
  key: string;
  /** The answer before the arrow, and after it. */
  before: string;
  after: string;
  /** Did the pre-emptive exitFocusMode fire before the arrow? */
  leftFocusMode: boolean;
  /** Result of the restore attempt, verbatim ('restored|…', 'no-element|', …). */
  restore: string;
  /** Did a confirming read agree the answer is back? */
  restored: boolean;
}

/**
 * What the cursor oracle said about one state-changing step, and what that
 * means. Five verdicts, because collapsing any two of them re-creates the bug:
 *  - "agreed"       the navigator object shares content words with the milestone;
 *  - "contradicted" the oracle named a DIFFERENT object — the state-changing
 *                   command is about to fire somewhere the plan did not record;
 *  - "abstained"    the oracle answered with a bare role ("paragraph"), which is
 *                   what plain text collapses to: it CANNOT say, which is not
 *                   the same as disagreeing;
 *  - "skipped"      never asked, because the milestone is not a control label
 *                   (see cursorOracleApplies);
 *  - "unavailable"  asked, and NVDA did not answer (gesture threw, or silence).
 */
export type NvdaCursorVerdict = "agreed" | "contradicted" | "abstained" | "skipped" | "unavailable";

/**
 * One cursor corroboration, drained per task by takeCursorChecks().
 *
 * It exists for the same reason TypeStepFidelity does: run 30483480823's `act`
 * fired on the page title and the task reported "0 resyncs" — the run summary
 * carried no signal at all. A debug() line is not a signal a report can be built
 * from, so the verdict is machine-readable and travels into the artifacts.
 */
export interface NvdaCursorCheck {
  /** Index this step will have in NvdaHarness.steps. */
  stepIndex: number;
  command: AtCommand;
  /** The plan's milestone for the step, verbatim. */
  milestone: string;
  verdict: NvdaCursorVerdict;
  /** What reportCurrentObject said, verbatim (truncated) — "" when it did not. */
  reply: string;
  /** Content words compared, after the shared normalization. */
  milestoneTokens: string[];
  objectTokens: string[];
  /** Words in common; empty is precisely what "contradicted" means. */
  shared: string[];
  detail: string;
  /** Round-trip cost, so the budget arithmetic stays auditable in artifacts. */
  elapsedMs: number;
}

/** What one interrogation of the oracle produced. */
interface CursorOracleReply {
  /** The speech tail after the gesture — the answer, verbatim. */
  reply: string;
  /** The tail BEFORE we asked. The interrogation must be invisible to the rest
   *  of the driver, and itemText() is that tail, so anything that reads it after
   *  a silent command has to be handed this back instead (undoOracleEcho). */
  tailBefore: string;
  /** Phrase-log entries consumed by the interrogation (the answer, plus
   *  anything the page happened to say inside the ~400ms window). */
  swallowed: string[];
  elapsedMs: number;
}

export interface NvdaHarnessOptions {
  noisePatterns?: RegExp[];
  commandTimeoutMs?: number;
  fullCapture?: boolean;
  onStep?: (record: AtStepRecord) => void;
  onDebug?: (stage: string, detail?: Record<string, unknown>) => void;
  /** Host-channel JS evaluator (ChromeHost.evalJs) — internal reliability only
   *  (verify typed text landed via document.activeElement.value), never for
   *  content assertions. */
  hostEval?: (js: string) => Promise<string>;
  /** Clipboard writer (ChromeHost.setClipboard) for the paste-based type retry. */
  hostSetClipboard?: (text: string) => Promise<void>;
  /** Page title of the current task — used to confirm the browser has focus. */
  pageTitle?: () => Promise<string>;
}

export class NvdaHarness implements AtDriver {
  readonly steps: AtStepRecord[] = [];
  private spokenLogCursor = 0;
  private itemTextLogCursor = 0;
  private nvdaInstance: Nvda | null = null;
  private keys: typeof WinKeys | null = null;
  private mods: typeof WinMods | null = null;
  private hostFocus: (() => Promise<void>) | null = null;
  private lastContentItem: NvdaContentItem | null = null;
  private typeFidelity: TypeStepFidelity[] = [];
  private cursorChecks: NvdaCursorCheck[] = [];
  private sweepMutations: SweepMutation[] = [];
  /** The interrogation the CURRENT command performed, if any — consumed by
   *  undoOracleEcho and cleared at the top of every run(). */
  private oracleEcho: CursorOracleReply | null = null;
  /**
   * The interrogation the most recent verifyCursor GATE performed, waiting to be
   * handed to the next run(). It survives exactly one command: replayPlan calls
   * verifyCursor and then dispatches the step with no gesture in between (see
   * verifyCursor), so the reading is still true of that command's cursor — but
   * one command later the gesture in between has moved both the cursor and the
   * speech tail on, and it is worthless.
   *
   * `moved` is set when something DID move the cursor in between after all —
   * today only moveToControl, which replayPlan may call between a contradicted
   * gate and the next command. The reading then stays usable as the echo to undo
   * (the speech tail it displaced is still displaced) but must never again be
   * reused AS a cursor reading.
   */
  private cursorGate: { milestone: string; oracle: CursorOracleReply; moved?: boolean } | null = null;
  private escapeRecoveries = 0;
  private lastMoveItem = "";
  private trappedMoves = 0;
  private trapPops = 0;
  private blankObservations = 0;
  private speechRecoveries = 0;
  private readonly noisePatterns: RegExp[];
  private readonly commandTimeoutMs: number;
  private readonly commandOptions: { capture: boolean | "initial" };
  private readonly onStep?: (record: AtStepRecord) => void;
  private readonly debug: (stage: string, detail?: Record<string, unknown>) => void;
  private readonly hostEval?: (js: string) => Promise<string>;
  private readonly hostSetClipboard?: (text: string) => Promise<void>;
  private readonly pageTitle?: () => Promise<string>;

  constructor(options: NvdaHarnessOptions = {}) {
    this.noisePatterns = options.noisePatterns ?? DEFAULT_NOISE_PATTERNS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOptions = { capture: options.fullCapture ? true : "initial" };
    this.onStep = options.onStep;
    this.debug = options.onDebug ?? (() => {});
    this.hostEval = options.hostEval;
    this.hostSetClipboard = options.hostSetClipboard;
    this.pageTitle = options.pageTitle;
  }

  private get nvda(): Nvda {
    if (!this.nvdaInstance) throw new Error("NvdaHarness not started — call start() first");
    return this.nvdaInstance;
  }

  async start(): Promise<void> {
    const guidepup = await import("@guidepup/guidepup");
    this.nvdaInstance = guidepup.nvda;
    this.keys = guidepup.WindowsKeyCodes;
    this.mods = guidepup.WindowsModifiers;
    this.debug("nvda.start", { capture: this.commandOptions.capture });
    await this.nvda.start(this.commandOptions);
    const log = await this.nvda.spokenPhraseLog();
    this.spokenLogCursor = log.length;
    this.itemTextLogCursor = (await this.nvda.itemTextLog()).length;
    this.debug("nvda.started", { initialPhrases: log.length });
  }

  async stop(): Promise<void> {
    await this.nvdaInstance?.stop().catch(() => {});
  }

  /**
   * Bring NVDA's reading into the page's web content — setup only, the NVDA
   * analogue of vo/voHarness.focusWebArea (which mirrors page.goto in the VSR
   * path). Foreground the browser via Alt+Esc (foreground-lock-safe), host-focus
   * #main-content, force browse mode, and move to the top of the document.
   */
  async focusWebArea(focusViaHost: () => Promise<void>): Promise<void> {
    this.hostFocus = focusViaHost;
    this.escapeRecoveries = 0;
    this.trapPops = 0;
    this.trappedMoves = 0;
    this.lastMoveItem = "";
    this.lastContentItem = null;
    // Per-attempt like the counters above: a wedge detected in THIS attempt must
    // not be charged to the next one, and its one recovery must be restored.
    this.blankObservations = 0;
    this.speechRecoveries = 0;
    // Per-task (per-attempt) state, like the counters above: a degraded type
    // step from the previous task must not be reported against this one.
    this.typeFidelity = [];
    this.cursorChecks = [];
    this.sweepMutations = [];
    this.oracleEcho = null;
    this.cursorGate = null;
    await this.enterWebArea();
  }

  /**
   * Hand over — and clear — the `type`-step fidelity records collected since the
   * last reset. Drain rather than read so that every exit from a task's attempt
   * empties the buffer: focusWebArea also clears it, but an attempt that dies
   * BEFORE focusWebArea (a page that never loads) would otherwise report the
   * previous task's degradation as its own.
   */
  takeTypeFidelity(): TypeStepFidelity[] {
    const collected = this.typeFidelity;
    this.typeFidelity = [];
    return collected;
  }

  /**
   * Hand over — and clear — the cursor corroborations collected since the last
   * reset. Drained rather than read, for the same reason takeTypeFidelity is: an
   * attempt that dies before focusWebArea() must not report the previous task's
   * contradictions as its own.
   */
  takeCursorChecks(): NvdaCursorCheck[] {
    const collected = this.cursorChecks;
    this.cursorChecks = [];
    return collected;
  }

  /**
   * Hand over — and clear — the sweep steps that changed the page's answers.
   * Drained rather than read, for the same reason the two above are.
   */
  takeSweepMutations(): SweepMutation[] {
    const collected = this.sweepMutations;
    this.sweepMutations = [];
    return collected;
  }

  private async enterWebArea(): Promise<void> {
    dismissSecurityDialog();
    const focused = await this.focusBrowserWindow();
    this.debug("focusWebArea: browser focused", { focused });
    if (this.hostFocus) await this.hostFocus();
    await new Promise((r) => setTimeout(r, 500));
    // Force browse mode, then align the review to the top of the document so a
    // follow-up linear scan / restartFromTop starts from a deterministic spot.
    await this.withTimeout(
      "focusWebArea:exitFocusMode",
      this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
    ).catch(() => {});
    await this.withTimeout("focusWebArea:top", this.nvda.press("Control+Home")).catch(() => {});
    this.debug("focusWebArea: done", { item: await this.itemTextSafe() });
  }

  /** Cycle windows via Alt+Esc until NVDA reports the Chromium window focused. */
  private async focusBrowserWindow(): Promise<boolean> {
    const want = clean((await this.pageTitle?.().catch(() => "")) ?? "");
    const SWITCH = { keyCode: [this.keys!.Escape], modifiers: [this.mods!.Alt] };
    for (let i = 0; i < 12; i++) {
      await this.withTimeout("reportTitle", this.nvda.perform(this.nvda.keyboardCommands.reportTitle)).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const title = clean(await this.lastSpokenSafe());
      if (title.includes("chrom") || (want.length > 2 && title.startsWith(want))) return true;
      if (NVDA_SECURITY_DIALOG.test(title)) {
        dismissSecurityDialog();
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      await this.withTimeout("altEsc", this.nvda.perform(SWITCH, { capture: false })).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  /**
   * Last-resort recovery for replayPlan (AtDriver.unstick): exit focus mode and
   * re-enter the web area from the top. Called only when a milestone resync
   * exhausts both directions.
   */
  async unstick(): Promise<void> {
    this.debug("unstick: exiting focus mode and re-entering web area");
    await this.withTimeout(
      "unstick:exitFocusMode",
      this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
    ).catch(() => {});
    await this.enterWebArea();
    this.debug("unstick: done", { item: await this.itemTextSafe() });
  }

  /**
   * Control-level cursor hop for replayPlan (AtDriver.moveToControl): browse-mode
   * quick nav, F / Shift-F (guidepup keyCodeCommands.moveToNextFormField /
   * moveToPreviousFormField).
   *
   * WHY a second mover at all. `next`/`previous` are ArrowDown/ArrowUp: they move
   * the browse caret by LINE and leave it at the line START. Run 30760469666's
   * one remaining failure is what that costs — NVDA speaks the discussion post's
   * three inline icon buttons as ONE line, "Like (0 likes), button, Edit, button,
   * Reply", so the milestone "reply" was claimed by the speech on every press
   * (the line names Reply, and nvdaLineSegmentAlternates offers it) and the
   * cursor oracle answered "Like (0 likes), button" every time: `contradicted`,
   * correctly, 75 presses in a row. The matcher and the gate were both right; the
   * ladder simply had no gesture that could reach the button. A quick-nav to the
   * adjacent CONTROL is that gesture, and Reply is two hops from Like.
   *
   * WHY FORM FIELD (F) RATHER THAN BUTTON (B). This started as B, which fixed
   * the discussion case and nothing else: a button hop can only ever reach a
   * button, so a milestone naming a RADIO or a CHECKBOX had no resync gesture at
   * all. That is the survey selection failure — measured on the seeded survey,
   * NVDA's browse buffer splits every SurveyJS choice across two lines, the
   * control's own line carrying role and state but NO name:
   *
   *   line 3  the radio       spoken "radio button, not checked"
   *                           navigatorObject "Just right, radio button, ... 2 of 3"
   *   line 4  the label text  spoken "Just right"    navigatorObject "label"
   *
   * so the milestone "just right" can only ever match line 4 — and Enter there
   * does nothing at all (measured: nothing checked, activeElement BODY). Every
   * line sweep in the ladder lands on text the `act` cannot use.
   *
   * F fixes it because NVDA's form-field quick-nav announces the control the way
   * focus does, name included, and lands the caret on the control itself:
   *
   *   F-hop  spoken "Just right, radio button, not checked"
   *          Enter -> checked=Just right, activeElement=INPUT#q2_1
   *
   * F is also a strict SUPERSET of B — NVDA's form fields are edits, buttons,
   * checkboxes, radio buttons, combo boxes, list boxes and sliders — so the
   * discussion-reply case this rung was built for still resolves, just through a
   * gesture that can also reach the other three-quarters of a form. The cost is
   * hops spent on non-button fields, which the sweep budget already absorbs.
   *
   * Reports nothing on purpose (see the hook's contract): the caller reads where
   * this landed with an ordinary `observe`, so the hop's speech goes through
   * run()'s existing pipeline — step record, boilerplate stripping, line-segment
   * alternates, the blank/speech-loss detector — instead of a second one that
   * would have to re-derive all of it. A quick-nav with no target ahead is not an
   * error either: NVDA says so and stays put, the caller's observe sees the same
   * item, and the sweep budget ends it.
   */
  async moveToControl(direction: ControlHopDirection): Promise<void> {
    const kc = this.nvda.keyboardCommands;
    const gesture = direction === "next" ? kc.moveToNextFormField : kc.moveToPreviousFormField;
    // No "from" reading here on purpose: itemText() is a round trip, replayPlan
    // may spend 24 hops on one milestone, and the observe either side of every
    // hop already records where the cursor was and where it landed.
    this.debug("control hop: quick-nav to the adjacent form control", {
      direction,
      gesture: gesture.representation
    });
    // this.commandOptions, like the structural moves in execute(): the hop's
    // announcement is exactly what the following observe has to read, so it must
    // be captured, not suppressed with capture:false.
    await this.withTimeout(
      `moveToControl:${direction}`,
      this.nvda.perform(gesture, this.commandOptions),
      CONTROL_HOP_TIMEOUT_MS
    ).catch((e) => this.debug("control hop: quick-nav threw", { direction, error: String(e) }));
    await settle(CONTROL_HOP_SETTLE_MS);
    // The cursor has MOVED, so the reading verifyCursor stashed for the next
    // command no longer describes it — the invariant corroborateCursor's reuse
    // rests on ("nothing has moved the cursor between the gate and this command")
    // is exactly what this method breaks. Mark it instead of dropping it: the
    // reply is still needed as the ECHO (undoOracleEcho), because if this hop
    // says nothing the oracle's own answer is still sitting in the speech tail
    // and would otherwise be read as the page speaking.
    if (this.cursorGate) this.cursorGate = { ...this.cursorGate, moved: true };
  }

  /**
   * Try to get NVDA speaking again after a run of blank observations, in the
   * order that risks least, and hand back the observation the recovery produced
   * (a still-empty currentItem means it did not work).
   *
   * Step 1 is unstick(): exit focus mode, re-enter the web area from the top.
   * That is the documented recovery for a displaced/trapped cursor and already
   * the one this driver offers replayPlan, so the wedge gets the same treatment
   * as every other lost cursor before anything more inventive is tried.
   *
   * Step 2 exists because unstick's exitFocusMode is ESCAPE, and NVDA's Escape
   * only "switches back to browse mode if focus mode was previously switched to
   * automatically" (guidepup keyCodeCommands.exitFocusMode) — it cannot undo the
   * MANUAL NVDA+Space that the plan's own `interact` sent, which is exactly how
   * run 30455293803 got into this state. NVDA+Space can. It is a toggle, so if it
   * does not help it is sent again to put the mode back the way we found it
   * (the same symmetry the type ladder's rung 0b.2 uses) — we are about to throw,
   * and the retried attempt should not inherit a mode we flipped on the way out.
   */
  private async recoverFromSpeechLoss(): Promise<{ rawSpoken: string[]; currentItem: string; tried: string }> {
    const collected: string[] = [];
    const toggle = async (why: string): Promise<void> => {
      await this.withTimeout(
        `speechLoss:${why}`,
        this.nvda.perform(this.nvda.keyboardCommands.toggleBetweenBrowseAndFocusMode, { capture: "initial" }),
        FOCUS_RUNG_TIMEOUT_MS
      ).catch((e) => this.debug("speech-loss recovery: toggle threw", { why, error: String(e) }));
    };
    await this.unstick();
    let observation = await this.collect();
    collected.push(...observation.rawSpoken);
    if (observation.currentItem.trim().length > 0) {
      return { rawSpoken: collected, currentItem: observation.currentItem, tried: "unstick" };
    }
    this.debug("speech-loss recovery: unstick did not restore speech — undoing the manual NVDA+Space focus mode");
    await toggle("undoManualFocusMode");
    observation = await this.collect();
    collected.push(...observation.rawSpoken);
    if (observation.currentItem.trim().length > 0) {
      return { rawSpoken: collected, currentItem: observation.currentItem, tried: "unstick + NVDA+Space" };
    }
    this.debug("speech-loss recovery: NVDA+Space did not help either — re-sending it to restore the mode we found");
    await toggle("restoreMode");
    // Only the phrases are taken from this last drain, never a verdict: the
    // restore toggle can itself speak ("focus mode"), and reporting that as
    // recovered would hand the caller a cursor that is still parked in the wedge.
    collected.push(...(await this.collect()).rawSpoken);
    return { rawSpoken: collected, currentItem: "", tried: "unstick + NVDA+Space (+ restore)" };
  }

  /**
   * Ordered label candidates for hostFocusField, most trustworthy first.
   * itemText() is DELIBERATELY last: it is an alias for lastSpokenPhrase(), and
   * the `interact` step that precedes every `type` speaks only "focus mode", so
   * it is the one source guaranteed to be useless at type time. In order:
   *  (0)   the PLAN's own milestone for this step (AtStepContext.milestone) —
   *        the only source that is not NVDA speech, hence the only one that is
   *        not blind here; see the milestone handling below;
   *  (i)   the previous step's observation — for a milestone-bearing step this
   *        is the hop that satisfied the milestone (currentItem + alternates),
   *        plus the tail of its raw spoken phrases;
   *  (ii)  the last item that carried content (tracked in run());
   *  (iii) itemText(), today's behaviour, demoted to last resort.
   * Each source contributes its exact renderings first and its progressively
   * state-token-stripped variants after, so a specific label always outranks a
   * permissive one.
   */
  private async resolveFieldLabelCandidates(milestone?: string): Promise<{ candidates: string[]; sources: string[] }> {
    const exact: string[] = [];
    const variants: string[] = [];
    const sources: string[] = [];
    const pushSource = (source: string, values: (string | undefined)[]): void => {
      for (const value of values) {
        const raw = (value ?? "").trim();
        // Length is measured on the CLEANED form, and 2 chars is too permissive:
        // a 2-character candidate off previous-step-spoken matches "Notes" and
        // "Phone number" by substring.
        if (clean(raw).length < MIN_LABEL_CANDIDATE_CHARS) continue;
        // Pure boilerplate ("focus mode") is exactly what used to collapse the
        // whole ladder to an empty label — drop it at the source.
        const stripped = stripNvdaBoilerplate(raw);
        if (!stripped) continue;
        if (!sources.includes(source)) sources.push(source);
        const keep = (candidate: string): boolean =>
          clean(candidate).length >= MIN_LABEL_CANDIDATE_CHARS && !isPureFieldState(candidate);
        for (const candidate of stripped === raw ? [raw] : [stripped, raw]) {
          if (keep(candidate)) exact.push(candidate);
        }
        for (const variant of [...nvdaFieldLabelVariants(stripped), ...nvdaFieldLabelVariants(raw)]) {
          // "edit multiline blank" strips down to "edit blank" → "edit": both are
          // pure role noise and would happily match "Edit comment".
          if (keep(variant)) variants.push(variant);
        }
      }
    };
    // The plan's milestone goes FIRST because it is the one label that does not
    // come from NVDA's mouth: every speech-derived source below is a reading of
    // lastSpokenPhrase(), and at a `type` step the last thing spoken is the
    // preceding `interact`'s "focus mode" (run 30483480823: the surviving
    // candidates were "Skip to main content", so hostFocusField saw nothing it
    // could match and correctly refused to guess).
    //
    // A milestone is a normalize.ts TEMPLATE, not raw speech: already lowercased
    // and whitespace-collapsed, with seed values and numbers/dates/times replaced
    // by {{placeholders}}. Only the placeholders need handling — clean() would
    // strip the braces and leave the literal words "number"/"studentname" looking
    // like part of a field's name — and what remains is ordinary label text
    // ("what is your name?", "reply...", "help request description"), which the
    // pipeline below role/state-strips and clean()s exactly like a spoken phrase.
    // hostFocusField applies that same clean() to DOM accessible names, so the
    // recorded "reply..." and aria-label="Reply…" meet as "reply". Lowercasing
    // costs nothing here: every comparison on both sides is case-insensitive.
    pushSource("plan-milestone", [milestone?.replace(MILESTONE_PLACEHOLDER, " ")]);
    const previous = this.steps.at(-1);
    pushSource("previous-step-item", [
      previous?.observation.currentItem,
      ...(previous?.observation.currentItemAlternates ?? [])
    ]);
    pushSource("previous-step-spoken", [...(previous?.rawSpoken ?? [])].slice(-3).reverse());
    pushSource("last-content-item", [
      this.lastContentItem?.primary,
      ...(this.lastContentItem?.alternates ?? []),
      this.lastContentItem?.raw
    ]);
    // Short budget: this runs INSIDE the type command's budget, and itemText()
    // is the least valuable source in the list — it must never cost 30s.
    pushSource("item-text", [await this.itemTextSafe(ITEM_TEXT_PROBE_MS)]);
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of [...exact, ...variants]) {
      // Dedupe on the cleaned form so "Reply…" and "Reply..." are one candidate.
      const key = clean(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      if (candidates.length >= 12) break; // bound the host-eval payload
    }
    return { candidates, sources };
  }

  /**
   * Host-assisted DOM focus of the field the NVDA cursor is on; focusing it
   * flips NVDA into focus mode so typing lands. Takes the whole ORDERED
   * candidate list (one host round-trip): a single label was fatal, because the
   * one label we had was usually "" (see resolveFieldLabelCandidates), and a
   * `return` before the debug() call made that no-op completely invisible.
   * Names and candidates are compared through the same clean() normalisation the
   * rest of the file uses, because NVDA speaks "Reply…" (U+2026) where the DOM
   * carries aria-label="Reply..." (components/ui/message-input.tsx:402) — three
   * exact/substring tests that all fail on invisible punctuation.
   *
   * When every candidate misses we guess ONLY where a guess is safe. The
   * heuristic is scoped to a `form`/`[role=dialog]`/`dialog` — deliberately NOT
   * `section`/`main`/`article`, because office-hours/layout-client.tsx:71 wraps
   * the header (which owns INPUT[aria-label="Search help requests"] — the exact
   * element from the original failure) AND the page body in one
   * `<Box as="section">`, so a section-scoped "nearest editable" happily selects
   * the search box; and because Chakra portals dialogs to <body>, outside `main`
   * altogether. Site chrome (header/banner/nav) and anything search-named is
   * never selectable by a guess, and the guess must be UNAMBIGUOUS in its scope
   * (sole editable, or sole unlabelled editable — the discussion reply's
   * MDEditor textarea has no accessible name at all,
   * components/ui/message-input.tsx:715, so label matching can never reach it).
   * Otherwise: none, and rung 4 logs an honest failure. Always debug()s.
   */
  private async hostFocusField(candidates: string[]): Promise<FocusRoute> {
    if (!this.hostEval) {
      this.debug("hostFocusField: SKIPPED — no host channel", { candidates: candidates.length });
      return { strategy: "skipped", detail: "no host channel" };
    }
    const raw = await this.hostEval(
      `(() => {
        const cands = ${JSON.stringify(candidates.map((c) => clean(c)))};
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const usable = (el) => vis(el) && !el.disabled && !el.readOnly && el.getAttribute('aria-hidden') !== 'true';
        const fields = [...document.querySelectorAll(${JSON.stringify(FIELD_SELECTOR)})].filter(usable);
        const tag = (el) => el.tagName + (el.id ? '#' + el.id : '');
        const desc = (el) => tag(el) + '[' + (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + ']';
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
        const nameOf = (el) => {
          const bits = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.labels && [...el.labels].map((l) => l.textContent).join(' ')];
          const labelled = el.getAttribute('aria-labelledby');
          if (labelled) bits.push(labelled.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
          return norm(bits.filter(Boolean).join(' '));
        };
        const take = (el, how, why) => {
          window.${FOCUS_TARGET_KEY} = el;
          el.focus();
          return how + '|' + desc(el) + (why ? ' via ' + why : '');
        };
        delete window.${FOCUS_TARGET_KEY};
        if (!fields.length) return 'none|no visible editable field on the page';
        const names = fields.map(nameOf);
        for (const c of cands) {
          let i = names.indexOf(c), how = 'label-exact';
          if (i < 0) { i = names.findIndex((n) => n.length > 2 && n.indexOf(c) >= 0); how = 'label-contains'; }
          if (i < 0) { i = names.findIndex((n) => n.length > 2 && c.indexOf(n) >= 0); how = 'label-contained-by'; }
          if (i >= 0) return take(fields[i], how, c);
        }
        // No label match: guess, but never into site chrome or a search box.
        const isChrome = (el) =>
          !!(el.closest && el.closest('header, [role=banner], nav, [role=navigation], [role=search], form[role=search]')) ||
          /search/.test(nameOf(el)) ||
          String(el.getAttribute('type') || '').toLowerCase() === 'search';
        const ref = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        let scope = ref && ref.closest ? ref.closest('form, [role=dialog], dialog') : null;
        if (!scope) {
          const dialogs = [...document.querySelectorAll('[role=dialog], dialog[open]')].filter(vis);
          if (dialogs.length === 1) scope = dialogs[0];
        }
        const eligible = fields.filter((el) => !isChrome(el));
        if (scope) {
          const inScope = eligible.filter((el) => scope.contains(el));
          if (inScope.length === 1) return take(inScope[0], 'scope-single', 'sole eligible editable in ' + tag(scope));
          const nameless = inScope.filter((el) => nameOf(el) === '');
          if (nameless.length === 1) return take(nameless[0], 'scope-sole-nameless', 'sole unlabelled editable in ' + tag(scope));
          return 'none|' + inScope.length + ' eligible editables (' + nameless.length + ' unlabelled) in ' + tag(scope) + ' — ambiguous, refusing to guess';
        }
        if (eligible.length === 1) return take(eligible[0], 'only-editable', 'sole eligible editable on the page');
        return 'none|' + fields.length + ' editables (' + eligible.length + ' eligible), none of ' + cands.length + ' candidates matched, no form/dialog scope';
      })()`
    ).catch((e) => `error|${e}`);
    const [strategy, detail] = splitHostResult(String(raw));
    this.debug("hostFocusField", {
      strategy,
      detail: detail.slice(0, 160),
      tried: candidates.length,
      candidates: candidates.slice(0, 6)
    });
    return { strategy, detail };
  }

  /**
   * Degraded-fidelity value entry (rung 4). ASSIGNS the expected text — the
   * native setter replaces the whole value, it never appends — so reaching rung 4
   * cannot itself produce the doubled field of run 30457321723. The step stays
   * degraded whatever comes back: `case "type"` sets hostSetValueFired before
   * calling this and recordFidelity ORs it into `degraded`.
   */
  private async hostSetValue(text: string): Promise<string> {
    if (!this.hostEval) return "no-host-channel";
    const result = await this.hostEval(hostFieldWriteJs(text)).catch((e) => `error|${e}`);
    this.debug("hostSetValue", { result: String(result).slice(0, 120) });
    return String(result);
  }

  /**
   * Empty the focused field and PROVE it is empty — the pre-retype setup that
   * rung 2's bare `Control+a` was pretending to be.
   *
   * Root cause it fixes (run 30457321723, survey feedback textarea): Control+a
   * only selects a field's contents when the field has real DOM focus / NVDA is
   * in focus mode — precisely the condition rung 2 exists to RECOVER from. There
   * it selected nothing, the retype appended, and the field ended up holding the
   * 32-character string twice; containment matching then called that `match`.
   *
   * Deliberate tension, resolved on purpose: this is a DOM write in a lane whose
   * whole point is fidelity. Clearing is SETUP, not the interaction under test —
   * the typing that follows is still real NVDA keystrokes — so it is allowed, but
   * it is logged here and recorded in TypeStepFidelity.hostClear rather than left
   * invisible.
   *
   * Confirmation is a SECOND read after a settle, not the write's own readback: a
   * controlled React field only really empties once its own re-render lands, and
   * an in-eval readback would report "cleared" while state still held the text.
   */
  private async hostClearField(): Promise<HostClearResult> {
    if (!this.hostEval) return { verdict: "unknown", residue: "", detail: "no host channel" };
    const wrote = await this.hostEval(hostFieldWriteJs("")).catch((e) => `error|${e}`);
    await settle(HOST_CLEAR_CONFIRM_MS);
    // sameElement is deliberately ignored: rung 3 re-routes focus before
    // clearing, so "moved" relative to the rung 0c probe element is expected and
    // says nothing about whether THIS field is now empty.
    const probe = await this.hostFieldValue(false);
    const verdict: HostClearResult["verdict"] =
      probe.verdict === "ok" ? (probe.value.trim() === "" ? "cleared" : "dirty") : "unknown";
    const result: HostClearResult = {
      verdict,
      residue: verdict === "dirty" ? probe.value : "",
      detail:
        `write=${String(wrote).slice(0, 60)} read=${probe.verdict}` +
        (verdict === "dirty" ? ` — still holds ${probe.value.length} chars` : "")
    };
    this.debug("type: host clear — DOM WRITE (setup for the keyboard retype, never the interaction under test)", {
      verdict,
      detail: result.detail,
      residue: result.residue.slice(0, 60)
    });
    return result;
  }

  private async describeActiveElement(): Promise<string> {
    if (!this.hostEval) return "?";
    return this.hostEval(
      `(() => {
        const el = document.activeElement;
        if (!el) return 'none';
        const v = el.value !== undefined ? el.value : (el.textContent || '');
        return el.tagName + (el.id ? '#' + el.id : '') + '[' + (el.getAttribute('aria-label') || '') + '] value=' + String(v).slice(0, 60);
      })()`
    ).catch((e) => `error:${e}`);
  }

  /**
   * Did the FULL expected text land in the focused FIELD, and NOTHING ELSE?
   *
   * Four fixes over the ported version, all from live false positives:
   *  - it must be a field. The old check fell back to `el.textContent` whenever
   *    `el.value` was undefined, so with focus on MAIN/BODY it tested the needle
   *    against the whole page's text — "landed" for text that went nowhere.
   *    A non-field now reports its own reason, and counts as NOT landed.
   *  - it compares the WHOLE text (whitespace-normalised, case-insensitive), not
   *    a 20-character prefix: observed live, the prefix matched while the field
   *    actually held "Keyboard-only navigation check: how I rthe ogra locy?" —
   *    garbled, truncated, and reported as success.
   *  - the comparison is EQUALITY, not containment. Containment was the same
   *    class of bug as that prefix check, entered through the other door: in run
   *    30457321723 the survey feedback textarea held the expected 32 characters
   *    TWICE (len=64 — rung 2's Control+a failed to select, so the retype
   *    APPENDED), `indexOf(...) >= 0` said `match`, the step recorded
   *    landed=true, and the task passed with garbage in the field.
   *  - "inconclusive ⇒ assume landed" survives ONLY for genuine host-eval
   *    errors (we must not trigger destructive retries on a broken probe), and
   *    says so loudly, because that is verification LOST, not verification.
   *
   * `expectRoutedTarget` closes the last gap: "is the text in whatever has
   * focus" is not the question — if a fallback focused the site-header search
   * box, retyping into it verifies as `match` and the step records clean. When
   * hostFocusField routed us somewhere, the focused element must still BE that
   * element or the result is `wrong-field`.
   *
   * `allowedPrefill` is the ONE tolerance on that equality, and it is measured
   * rather than assumed: it is the value the rung 0c probe read out of THIS field
   * immediately before the first keystroke ("" / unreadable ⇒ no tolerance at
   * all, and "" again the moment a rung host-clears the field). So a field that
   * legitimately arrived with content — a plan typing into a prefilled field, or
   * typing twice into the same one — still passes, because removing that one
   * measured occurrence leaves exactly the expected text. A doubled write still
   * fails: with a baseline of "" there is nothing to remove, and with a baseline
   * of P, `P + text + text` has a whole extra `text` left over once P is out.
   */
  private async typedTextLanded(text: string, expectRoutedTarget = false, allowedPrefill = ""): Promise<LandedCheck> {
    if (!this.hostEval) return { landed: true, reason: "no-host-channel", detail: "" };
    const raw = await this.hostEval(
      `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'no-active|' + (el ? el.tagName : 'none');
        const where = el.tagName + (el.id ? '#' + el.id : '') + '[' + (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + ']';
        const routed = window.${FOCUS_TARGET_KEY};
        if (${expectRoutedTarget ? "true" : "false"} && routed && routed !== el) {
          return 'wrong-field|focus is ' + where + ' but we routed to ' + routed.tagName + (routed.id ? '#' + routed.id : '');
        }
        const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
        if (!isField) return 'not-a-field|' + where;
        const value = el.isContentEditable ? (el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value);
        const norm = (s) => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
        const want = norm(${JSON.stringify(text)});
        const got = norm(value);
        const pre = norm(${JSON.stringify(allowedPrefill)});
        const sizes = ' want=' + want.length + ' got=' + got.length + ' chars (normalised), raw len=' + value.length;
        if (got === want) return 'match|' + where + sizes;
        // The one tolerated deviation: content the field already held before this
        // step typed anything. Remove exactly ONE occurrence of it — at any
        // position, because a real caret can sit before, after or inside the
        // existing text — and what remains must EQUAL the expected text. The
        // splice re-normalises so a caret at a word boundary does not fail on a
        // doubled space.
        for (let at = pre ? got.indexOf(pre) : -1; at >= 0; at = got.indexOf(pre, at + 1)) {
          if (norm(got.slice(0, at) + ' ' + got.slice(at + pre.length)) === want) {
            return 'match|' + where + sizes + ', prefill of ' + pre.length + ' chars tolerated';
          }
        }
        const detail = where + sizes + ' value=' + JSON.stringify(String(value).slice(0, 120)) +
          (pre ? ' prefill=' + JSON.stringify(String(${JSON.stringify(allowedPrefill)}).slice(0, 60)) : ' prefill=<none>');
        // Distinct reason, so the log says WHY: the text is all there plus
        // something else (the doubled-write signature), versus not there at all.
        if (got.indexOf(want) >= 0) return 'extra-content|' + detail;
        return 'mismatch|' + detail;
      })()`
    ).catch((e) => `error|${e}`);
    const [reason, detail] = splitHostResult(String(raw));
    if (reason === "match") return { landed: true, reason: "match", detail };
    if (
      reason === "mismatch" ||
      reason === "extra-content" ||
      reason === "not-a-field" ||
      reason === "no-active" ||
      reason === "wrong-field"
    ) {
      return { landed: false, reason, detail };
    }
    this.debug("typedTextLanded: HOST CHECK FAILED — assuming landed, verification LOST for this step", {
      result: String(raw).slice(0, 120)
    });
    return { landed: true, reason: "inconclusive", detail: String(raw).slice(0, 120) };
  }

  /**
   * Rung 0a probe: can DOM focus, right now, accept typed text? Cheap, and the
   * single most useful datum in this file — when it says yes we must NOT re-route
   * focus (the discussion reply autofocuses its textarea 100ms after the reply
   * button, so any further routing is pure added risk), and when it says no we
   * know keystrokes are about to become browse-mode quick-nav. Tri-state: a
   * failed probe is "unknown", never "no" — see HostVerdict.
   *
   * `rejectChrome` is set for the rung 0a/0b probes, where the focused element
   * is one we did NOT choose: a site-header search box is text-capable, so an
   * unguarded "yes" would pour a 68-character help request into it — the same
   * bug hostFocusField's heuristic had, entered through the other door. It is
   * NOT set for rung 2's re-probe, where we deliberately routed to that element
   * and a search field may legitimately be the plan's target.
   */
  private async hostFocusCanTakeText(rejectChrome = false): Promise<{ verdict: HostVerdict; detail: string }> {
    if (!this.hostEval) return { verdict: "unknown", detail: "no host channel" };
    const raw = await this.hostEval(
      `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'no|' + (el ? el.tagName : 'none');
        const nonText = ${JSON.stringify(NON_TEXT_INPUT_TYPES)};
        const where = el.tagName + (el.id ? '#' + el.id : '') + '[' + (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + ']';
        const textCapable =
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable === true ||
          (el.tagName === 'INPUT' && nonText.indexOf(String(el.getAttribute('type') || 'text').toLowerCase()) < 0);
        if (!textCapable) return 'no|' + where;
        if (el.disabled) return 'no|' + where + ' disabled';
        if (el.readOnly) return 'no|' + where + ' readOnly';
        if (${rejectChrome ? "true" : "false"}) {
          const name = String((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
          const inChrome = !!(el.closest && el.closest('header, [role=banner], nav, [role=navigation], [role=search], form[role=search]'));
          if (inChrome || /search/.test(name) || String(el.getAttribute('type') || '').toLowerCase() === 'search') {
            return 'no|' + where + ' is site chrome / a search field — refusing to trust pre-existing focus';
          }
        }
        return 'yes|' + where;
      })()`
    ).catch((e) => `error|${e}`);
    const [verdict, detail] = splitHostResult(String(raw));
    if (verdict === "yes" || verdict === "no") return { verdict, detail: detail || verdict };
    return { verdict: "unknown", detail: String(raw).slice(0, 120) };
  }

  /**
   * Value of the focused field for the rung 0c append probe. `remember` stashes
   * the element so the follow-up reading can prove it is the SAME one: a focus
   * change between the two readings (to a field that already holds text) other-
   * wise reads as a successful append and releases the rest of the string.
   */
  private async hostFieldValue(remember: boolean): Promise<FieldValueProbe> {
    if (!this.hostEval) return { verdict: "unknown", value: "", sameElement: false, detail: "no host channel" };
    const raw = await this.hostEval(
      `(() => {
        const el = document.activeElement;
        const previous = window.${PROBE_ELEMENT_KEY};
        if (${remember ? "true" : "false"}) window.${PROBE_ELEMENT_KEY} = el;
        const same = ${remember ? "true" : "false"} ? 'same' : (el && previous === el ? 'same' : 'moved');
        if (!el || el === document.body) return 'nofield|' + same + '|' + (el ? el.tagName : 'none');
        const isCE = el.isContentEditable === true;
        if (isCE || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const v = isCE ? (el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value);
          return 'ok|' + same + '|' + v;
        }
        return 'nofield|' + same + '|' + el.tagName;
      })()`
    ).catch((e) => `error|${e}`);
    const [verdict, rest] = splitHostResult(String(raw));
    const [same, value] = splitHostResult(rest);
    if (verdict === "ok" || verdict === "nofield") {
      return { verdict, value, sameElement: same === "same", detail: `${verdict}/${same}` };
    }
    return { verdict: "unknown", value: "", sameElement: false, detail: String(raw).slice(0, 120) };
  }

  /** Is the Chromium window the OS-focused one? document.hasFocus() is false
   *  unless this document's window has OS focus — the one host-side fact that
   *  answers rung −1 without spending NVDA speech. */
  private async hostHasFocus(): Promise<{ verdict: HostVerdict; detail: string }> {
    if (!this.hostEval) return { verdict: "unknown", detail: "no host channel" };
    const raw = await this.hostEval("String(document.hasFocus())").catch((e) => `error:${e}`);
    if (raw === "true") return { verdict: "yes", detail: "document.hasFocus()" };
    if (raw === "false") return { verdict: "no", detail: "document.hasFocus() === false" };
    return { verdict: "unknown", detail: String(raw).slice(0, 80) };
  }

  /**
   * Rung −1 — foreground guard. NVDA types through OS-level
   * WScript.Shell.SendKeys, so if Chromium is not the FOREGROUND window every
   * character is delivered to whatever is (the runner console) while
   * document.activeElement still looks perfectly plausible from the host side:
   * a silent, invisible total loss.
   *
   * Verified host-side end to end: document.hasFocus() decides whether we are
   * foreground, and it also decides when we have BECOME foreground. This path
   * deliberately does NOT call focusBrowserWindow(): that helper reads NVDA's
   * spoken window title, so its reportTitle perform must keep capture:"initial"
   * (with capture:false guidepup logs an empty phrase and the title check can
   * never pass), and that costs guidepup's #stopReading() drain plus up to a
   * second of speech debounce on every one of its 12 iterations — seconds we do
   * not have inside a 42s type budget. Alt+Esc verified by hasFocus() is the
   * same gesture with none of the speech cost.
   */
  private async ensureBrowserForeground(expired: (where: string) => boolean): Promise<void> {
    const probe = await this.hostHasFocus();
    if (probe.verdict === "yes") {
      this.debug("type: rung -1 foreground guard — Chromium already foreground", { probe: probe.detail });
      return;
    }
    if (probe.verdict === "unknown") {
      // Never escalate on a broken probe: an Alt+Esc cycle we did not need can
      // pull the foreground AWAY from Chromium.
      this.debug("type: rung -1 foreground guard UNKNOWN — host probe failed, NOT touching the foreground", {
        probe: probe.detail
      });
      return;
    }
    this.debug("type: rung -1 foreground guard — Chromium NOT foreground, keystrokes would be LOST", {
      probe: probe.detail
    });
    dismissSecurityDialog();
    const switchWindow = { keyCode: [this.keys!.Escape], modifiers: [this.mods!.Alt] };
    for (let attempt = 1; attempt <= FOREGROUND_ATTEMPTS; attempt++) {
      if (expired("rung -1 foreground guard")) return;
      await this.withTimeout(
        "type:altEsc",
        this.nvda.perform(switchWindow, { capture: false }),
        FOREGROUND_SWITCH_TIMEOUT_MS
      ).catch((e) => this.debug("type: rung -1 Alt+Esc threw", { attempt, error: String(e) }));
      await settle(700);
      const again = await this.hostHasFocus();
      if (again.verdict !== "no") {
        this.debug("type: rung -1 foreground guard done", { attempt, verdict: again.verdict, probe: again.detail });
        return;
      }
    }
    this.debug("type: rung -1 foreground guard FAILED — Chromium never became foreground; typed text will be LOST", {
      attempts: FOREGROUND_ATTEMPTS
    });
  }

  /**
   * Rungs 0a + 0b: get keyboard focus onto the field the NVDA cursor is on,
   * using AT-NATIVE gestures only (host-assisted focus stays demoted to rung 2,
   * so the pure screen-reader path is exercised first and any failure of it is
   * recorded as a finding). VoiceOver's rung 0 — VO+Cmd+F5
   * moveKeyboardFocusToCursor, called unconditionally before every type — had
   * no NVDA counterpart at all; these are it.
   *
   * There is deliberately NO Enter/act() rung. "Enter on an edit field focuses
   * it" is only true if the review cursor IS on an edit field, and we cannot
   * know that: itemText() is lastSpokenPhrase(), and any regex over recent
   * speech is close to always-true (NVDA_TEXT_ENTRY_CONTEXT matches "Edited" on
   * discussion posts and "credit" on grade pages) — and it would describe where
   * the cursor was BEFORE 0b.1 moved it anyway. On the help-request page the
   * plausible Enter targets are the Submit Request button (submits with an empty
   * required description, destroying the DB predicate and the remaining ~23
   * steps) and links (navigate away). Rung 2's host-assisted focus covers the
   * same ground without gambling the task.
   */
  private async routeFocusForTyping(expired: (where: string) => boolean): Promise<FocusRouting> {
    if (!this.hostEval) {
      // No host channel = no probe and no verification; the plan's preceding
      // `interact` is all the focus routing we can honestly claim.
      this.debug("type: no host channel — typing blind, no focus routing and no verification");
      return { ok: false, rung: "no-host", detail: "" };
    }
    let probe = await this.hostFocusCanTakeText(true);
    if (probe.verdict === "yes") {
      this.debug("type: rung 0a — DOM focus already accepts text, SKIPPING focus routing", { field: probe.detail });
      return { ok: true, rung: "0a", detail: probe.detail };
    }
    if (probe.verdict === "unknown") {
      this.debug("type: rung 0a UNKNOWN — host probe failed, NOT escalating to focus routing; rung 0c will decide", {
        probe: probe.detail
      });
      return { ok: false, rung: "0a-unknown", detail: probe.detail };
    }
    this.debug("type: rung 0a — DOM focus cannot accept text, trying AT-native focus routing", {
      activeElement: probe.detail
    });
    const kc = this.nvda.keyboardCommands;
    const gesture = async (name: string, command: Parameters<Nvda["perform"]>[0]): Promise<HostVerdict> => {
      await this.withTimeout(
        `type:${name}`,
        this.nvda.perform(command, { capture: false }),
        FOCUS_RUNG_TIMEOUT_MS
      ).catch((e) => this.debug("type: focus rung threw", { rung: name, error: String(e) }));
      await settle(NVDA_FOCUS_SETTLE_MS);
      probe = await this.hostFocusCanTakeText(true);
      this.debug("type: focus rung result", { rung: name, verdict: probe.verdict, activeElement: probe.detail });
      return probe.verdict;
    };
    // 0b.1 — NVDA+Shift+NumPadMinus: "moves the System focus to the current
    // navigator object", the closest analogue to VO+Cmd+F5.
    if (expired("rung 0b.1")) return { ok: false, rung: "0b-expired", detail: probe.detail };
    const afterMove = await gesture("0b.1 moveToReviewPosition", kc.moveToReviewPosition);
    if (afterMove === "yes") return { ok: true, rung: "0b.1 moveToReviewPosition", detail: probe.detail };
    if (afterMove === "unknown") {
      this.debug("type: rung 0b.1 verdict UNKNOWN — stopping focus routing rather than escalating blind");
      return { ok: false, rung: "0b.1-unknown", detail: probe.detail };
    }
    // 0b.2 — NVDA+Space is a TOGGLE, not an "enter focus mode", and the plan's
    // own `interact` already sent one, so NVDA is probably in focus mode
    // ALREADY and this flips it to browse mode: the worst state for rung 1.
    // Therefore it is symmetric — if it does not help, send it again to restore
    // whatever mode we were in before we meddled.
    if (expired("rung 0b.2")) return { ok: false, rung: "0b-expired", detail: probe.detail };
    const afterToggle = await gesture("0b.2 toggleBetweenBrowseAndFocusMode", kc.toggleBetweenBrowseAndFocusMode);
    if (afterToggle === "yes") return { ok: true, rung: "0b.2 toggleBetweenBrowseAndFocusMode", detail: probe.detail };
    this.debug("type: rung 0b.2 did not help — re-sending NVDA+Space to restore the previous browse/focus mode");
    const afterRestore = await gesture("0b.2r toggle restore", kc.toggleBetweenBrowseAndFocusMode);
    if (afterRestore === "yes") return { ok: true, rung: "0b.2r toggle restore", detail: probe.detail };
    this.debug("type: rung 0b EXHAUSTED — no AT-native gesture put focus in a text field", {
      activeElement: probe.detail,
      verdict: probe.verdict
    });
    return { ok: false, rung: "0b-exhausted", detail: probe.detail };
  }

  private async itemTextSafe(budgetMs = this.commandTimeoutMs): Promise<string> {
    try {
      return await this.withTimeout("itemText", this.nvda.itemText(), budgetMs);
    } catch {
      return "";
    }
  }

  private async lastSpokenSafe(): Promise<string> {
    try {
      return await this.withTimeout("lastSpokenPhrase", this.nvda.lastSpokenPhrase());
    } catch {
      return "";
    }
  }

  /**
   * ASK NVDA where its cursor is, instead of inferring it from what NVDA last
   * happened to say.
   *
   * reportCurrentObject (NVDA-NumPad5) speaks the navigator object on demand.
   * Probe run 30681006352 measured that the answer tracked all 4 cursor moves
   * with 3 distinct replies, repeated itself when the cursor held still, and —
   * the decisive property — kept naming the object after reportTitle had
   * poisoned the speech tail with "Pawtograder - Chromium". That is a cursor
   * read, which itemText() is not.
   *
   * Read exactly the way focusBrowserWindow reads reportTitle, and exactly the
   * way the probe measured it: perform() with NO options, so capture stays the
   * instance default this harness started NVDA with ("initial"), then settle,
   * then take the log tail. lastSpokenPhrase() IS `spokenPhraseLog().at(-1)`
   * (guidepup NVDA.js:496), so the one log read here serves as both the answer
   * and the bookkeeping below — one fewer round trip inside a command budget.
   *
   * The interrogation then ERASES ITSELF from the observation pipeline, which is
   * the subtle half. NVDA's itemTextLog IS its spokenPhraseLog (NVDA.js:621), so
   * without this the harness's own question would (a) land in
   * spokenSinceLastAction and count as a heard phrase, (b) reset the speech-loss
   * detector — the oracle answers even when the page has gone silent, so a wedge
   * would be masked — and (c) become currentItem whenever the command that
   * follows says nothing, silently rewriting what the NEXT milestone check
   * reads. Both log cursors are therefore advanced past the interrogation
   * window, and the pre-interrogation tail is kept for undoOracleEcho. The cost
   * is that a live-region announcement landing inside that ~400ms window is
   * consumed too; it is logged verbatim rather than lost quietly.
   */
  private async askCursorOracle(): Promise<CursorOracleReply> {
    const startedAt = Date.now();
    // ONE read for both the pre-interrogation tail and the log position — the
    // tail IS the log's last entry, and a second round trip here would be pure
    // budget. Snapshot the position as a NUMBER: spokenPhraseLog() hands back
    // the LIVE array (guidepup NVDAClient.js:52-55), so holding the array itself
    // makes every later slice empty — the bug that made probe-cursor v1 report a
    // false negative on every command.
    const { tailBefore, logStart } = await this.withTimeout(
      "cursorOracle:logBefore",
      this.nvda.spokenPhraseLog(),
      CURSOR_ORACLE_LOG_TIMEOUT_MS
    )
      .then((log) => ({ tailBefore: log.at(-1) ?? "", logStart: log.length }))
      .catch(() => ({ tailBefore: "", logStart: this.spokenLogCursor }));
    await this.withTimeout(
      "cursorOracle:reportCurrentObject",
      this.nvda.perform(this.nvda.keyboardCommands.reportCurrentObject),
      CURSOR_ORACLE_TIMEOUT_MS
    ).catch((e) => this.debug("cursor oracle: reportCurrentObject threw", { error: String(e) }));
    // Let a multi-phrase object report finish before sampling the tail.
    await settle(CURSOR_ORACLE_SETTLE_MS);
    let reply = "";
    let swallowed: string[] = [];
    try {
      const log = await this.withTimeout(
        "cursorOracle:logAfter",
        this.nvda.spokenPhraseLog(),
        CURSOR_ORACLE_LOG_TIMEOUT_MS
      );
      reply = (log.at(-1) ?? "").trim();
      swallowed = log.slice(logStart).filter((phrase) => phrase.trim().length > 0);
      this.spokenLogCursor = Math.max(this.spokenLogCursor, log.length);
      this.itemTextLogCursor = Math.max(this.itemTextLogCursor, log.length);
    } catch (e) {
      this.debug("cursor oracle: could not read the answer back", { error: String(e) });
    }
    return { reply, tailBefore, swallowed, elapsedMs: Date.now() - startedAt };
  }

  /**
   * Cursor GATE for replayPlan (AtDriver.verifyCursor) — the same interrogation
   * as corroborateCursor, asked one layer earlier, where the answer can still
   * change what happens.
   *
   * corroborateCursor is a RECORD: by the time it runs, replayPlan has already
   * decided the milestone matched and the gesture is about to fire, so all it
   * can do is write down that the step went to the wrong element. Run
   * 30682097759 is what that looks like at scale — 11 of 14 state-changing steps
   * fired on elements the plan never recorded (discussion-reply 0/4 cursor
   * agreement, office-hours 1/5, survey 2/5) and all three tasks reported
   * success, because milestone matching reads itemText(), itemText() is an alias
   * for lastSpokenPhrase(), and a STALE utterance satisfies a milestone
   * ("reply" matched while the navigator object was "E 2E A 11y Agent Class,
   * link, linked"). The resync ladder therefore never engaged.
   *
   * Called by replayPlan ONLY when milestoneMatches has already returned true,
   * which is what makes a ~1.5-2.5s round trip affordable: the ladder presses up
   * to 25 forward, 50 back and 75 more after unstick, and asking per PRESS would
   * cost minutes per step. replayPlan additionally memoizes per observation and
   * caps consultations per step (createMilestoneGate); nothing here assumes
   * either — this method is a pure question with a bounded cost.
   *
   * "abstained" is returned for every inconclusive outcome, never
   * "contradicted": a milestone the oracle cannot judge (cursorOracleApplies —
   * prose, or nothing but role words), a gesture NVDA did not answer, and a
   * reply that carries a role but no name ("paragraph", "label" — run
   * 30682097759's false contradiction). Only a named object with zero content
   * words in common contradicts.
   *
   * The reading is stashed in this.cursorGate so the command that follows can
   * reuse it instead of paying for a second identical round trip, and so its
   * echo can be undone (see run()).
   */
  async verifyCursor(milestone: string): Promise<CursorVerdict> {
    const stepIndex = this.steps.length;
    const applies = cursorOracleApplies(milestone);
    if (!applies.applies) {
      this.debug("cursor gate: NOT CONSULTED — the oracle cannot judge this milestone", {
        stepIndex,
        milestone,
        why: applies.reason,
        verdict: "abstained"
      });
      return "abstained";
    }
    const oracle = await this.askCursorOracle();
    this.cursorGate = { milestone, oracle };
    if (oracle.swallowed.length > 1) {
      this.debug("cursor gate: phrases consumed by the interrogation", {
        stepIndex,
        swallowed: oracle.swallowed.map((phrase) => phrase.slice(0, 120))
      });
    }
    if (!oracle.reply) {
      this.debug("cursor gate: UNAVAILABLE — NVDA did not answer, so the gate cannot disagree", {
        stepIndex,
        milestone,
        elapsedMs: oracle.elapsedMs,
        verdict: "abstained"
      });
      return "abstained";
    }
    const judged = judgeCursorOracle(applies.tokens, oracle.reply);
    this.debug(`cursor gate: ${judged.verdict.toUpperCase()}`, {
      stepIndex,
      milestone,
      reply: oracle.reply.slice(0, 160),
      milestoneTokens: applies.tokens,
      objectTokens: judged.objectTokens,
      shared: judged.shared,
      elapsedMs: oracle.elapsedMs,
      note:
        judged.verdict === "contradicted"
          ? "the speech tail matched this milestone but NVDA's navigator object shares no content word with it — " +
            "replayPlan will treat the milestone as UNMET and keep resyncing (the failure mode of run 30682097759)"
          : "replayPlan may accept this milestone"
    });
    return judged.verdict;
  }

  /**
   * Corroborate the review cursor against the plan's own milestone before a
   * state-changing command fires — the check whose absence IS the bug in run
   * 30483480823: `{ command: "act", milestone: "reply" }` fired with the cursor
   * on the page title, the milestone "matched" because the word "reply" was
   * still in the speech log from reading the thread, the resync ladder never
   * engaged (the task reported 0 resyncs), Enter hit the wrong element, and the
   * failure only surfaced steps later as "no visible editable field".
   *
   * Scope: the state-changing commands replayPlan enumerates, MINUS `type`.
   * `type` is excluded on purpose — it already has a strictly stronger oracle
   * (the DOM, via hostFieldValue/typedTextLanded, which reads the field the text
   * actually reached), it is the one command whose budget is length-scaled and
   * deadline-gated, and its ladder re-routes focus anyway, so a reading taken
   * before all that would describe a cursor the ladder is about to move.
   *
   * What this can honestly DO is the other half. It cannot resync: replayPlan
   * owns the resync ladder and its bookkeeping, and a driver that quietly walked
   * the cursor here would leave `resyncs` reading 0 — the very number that lied
   * in run 30483480823 — while hiding the drift that count exists to measure. So
   * the gesture still fires (its consequence stays in the artifacts), and the
   * contradiction is surfaced UPWARD three ways: a loud debug() line, an
   * NvdaCursorCheck for takeCursorChecks(), and observation.error on the step
   * record, so it reaches the runner log, the run summary and steps.json.
   *
   * Returns the contradiction message ("" when there is none) for the caller to
   * attach to the observation, plus the interrogation to undo.
   *
   * `gate` is the reading a verifyCursor consultation already paid for
   * immediately before this command, if there was one. Reusing it is not a
   * shortcut for its own sake: NOTHING has moved the cursor between the gate and
   * this command (see verifyCursor), so a second interrogation would ask the
   * same question of the same cursor for another ~1.5-2.5s per state-changing
   * step — roughly a minute across a three-task run, spent to re-derive an
   * answer already in hand. The record written below is identical either way.
   */
  private async corroborateCursor(
    command: AtCommand,
    milestone: string | undefined,
    gate: { milestone: string; oracle: CursorOracleReply; moved?: boolean } | null = null
  ): Promise<{ contradiction: string; echo: CursorOracleReply | null }> {
    const none = { contradiction: "", echo: null };
    if (!STATE_CHANGING_COMMANDS.has(command) || command === "type" || !milestone?.trim()) return none;
    const stepIndex = this.steps.length;
    const record = (check: Omit<NvdaCursorCheck, "stepIndex" | "command" | "milestone">): NvdaCursorCheck => {
      const full = { stepIndex, command, milestone, ...check };
      this.cursorChecks.push(full);
      return full;
    };
    const applies = cursorOracleApplies(milestone);
    if (!applies.applies) {
      // An oracle that cannot help must not be spent, and — far more important —
      // its inconclusive answer must never be read as disagreement.
      this.debug("cursor oracle: SKIPPED — the oracle cannot judge this milestone", {
        stepIndex,
        command,
        milestone,
        why: applies.reason
      });
      record({
        verdict: "skipped",
        reply: "",
        milestoneTokens: applies.tokens,
        objectTokens: [],
        shared: [],
        detail: applies.reason,
        elapsedMs: 0
      });
      return none;
    }
    // `!gate.moved`: a control hop (moveToControl) between the gate and this
    // command invalidates the reading — reusing it would corroborate this step
    // against a cursor position two buttons ago, which is the run 30760469666
    // failure re-created inside the record that is supposed to catch it.
    const reused = gate !== null && !gate.moved && gate.milestone === milestone;
    const oracle = reused ? gate.oracle : await this.askCursorOracle();
    this.oracleEcho = oracle;
    if (reused) {
      this.debug("cursor oracle: reusing the reading the milestone gate just took (no gesture since)", {
        stepIndex,
        command,
        milestone,
        reply: oracle.reply.slice(0, 160)
      });
    } else if (oracle.swallowed.length > 1) {
      // Everything the interrogation consumed, verbatim: the answer itself plus
      // anything the page said inside the settle window, which the observation
      // pipeline will never see (see askCursorOracle).
      this.debug("cursor oracle: phrases consumed by the interrogation", {
        stepIndex,
        swallowed: oracle.swallowed.map((phrase) => phrase.slice(0, 120))
      });
    }
    if (!oracle.reply) {
      this.debug("cursor oracle: UNAVAILABLE — NVDA did not answer, proceeding on the speech tail alone", {
        stepIndex,
        command,
        milestone,
        elapsedMs: oracle.elapsedMs
      });
      record({
        verdict: "unavailable",
        reply: "",
        milestoneTokens: applies.tokens,
        objectTokens: [],
        shared: [],
        detail: "reportCurrentObject produced no phrase",
        elapsedMs: oracle.elapsedMs
      });
      return { contradiction: "", echo: oracle };
    }
    const judged = judgeCursorOracle(applies.tokens, oracle.reply);
    const common = {
      reply: oracle.reply.slice(0, 160),
      milestoneTokens: applies.tokens,
      objectTokens: judged.objectTokens,
      shared: judged.shared,
      elapsedMs: oracle.elapsedMs
    };
    if (judged.verdict === "abstained") {
      // The measured limit of this oracle: plain text collapses to a bare role
      // ("Your pawsome course companion" → "paragraph", run 30681006352). It is
      // decisive for controls and mute for content, and mute is not disagreement.
      this.debug("cursor oracle: ABSTAINED — the navigator object has no name, only a role", {
        stepIndex,
        command,
        milestone,
        ...common
      });
      record({ ...common, verdict: "abstained", detail: "reply carried role words only" });
      return { contradiction: "", echo: oracle };
    }
    if (judged.verdict === "agreed") {
      this.debug("cursor oracle: AGREED — the navigator object matches the milestone", {
        stepIndex,
        command,
        milestone,
        ...common
      });
      record({ ...common, verdict: "agreed", detail: `shared: ${judged.shared.join(", ")}` });
      return { contradiction: "", echo: oracle };
    }
    const contradiction =
      `cursor oracle CONTRADICTS step ${stepIndex} (${command}): milestone ${JSON.stringify(milestone)} but ` +
      `NVDA's navigator object is ${JSON.stringify(oracle.reply.slice(0, 120))} — no content word in common, so this ` +
      `state-changing command is firing on something the plan never recorded (the failure mode of run 30483480823)`;
    this.debug(`cursor oracle: CONTRADICTED — ${contradiction}`, {
      stepIndex,
      command,
      milestone,
      ...common,
      note: "the driver cannot resync from here (replayPlan owns the ladder); the command still fires and this is recorded"
    });
    record({ ...common, verdict: "contradicted", detail: contradiction });
    return { contradiction, echo: oracle };
  }

  /**
   * Undo the oracle's echo. itemText() is the speech TAIL, so after an
   * interrogation any command that says nothing leaves OUR question's answer
   * sitting there looking like the page spoke it. Every reader of the tail gets
   * the pre-interrogation value back instead, so the corroboration changes no
   * decision anywhere else in the driver — the container guard in `interact`,
   * the blank/speech-loss detector, lastContentItem and the next milestone check
   * all keep reading the page's speech, exactly as they did before.
   *
   * If the pre-interrogation tail could not be read at all (a failed log read),
   * this restores "" — "the command itself said nothing", which is the truth
   * about the command and costs at most one tick of the blank-observation
   * counter (limit 6). Leaving our own question standing in as the page's speech
   * would be the worse lie: it also feeds lastContentItem and the NEXT milestone
   * check.
   */
  private undoOracleEcho(item: string): string {
    const echo = this.oracleEcho;
    if (!echo || !echo.reply || item.trim() !== echo.reply) return item;
    this.debug("cursor oracle: restoring the pre-interrogation speech tail", {
      oracleReply: echo.reply.slice(0, 120),
      restored: echo.tailBefore.slice(0, 120)
    });
    return echo.tailBefore;
  }

  async run(command: AtCommand, arg?: string, context?: AtStepContext): Promise<AtObservation> {
    const startedTimestamp = new Date().toISOString();
    let error: string | undefined;
    // BEFORE the gesture, not after: the whole point is to know where the cursor
    // is while it can still be reported honestly, and this is the moment probe
    // run 30681006352 measured (the cursor has just been walked by replayPlan's
    // observe/resync, which is exactly the `next`-move tracking it tested).
    //
    // A verifyCursor GATE consult (if replayPlan just made one) is claimed here
    // and nowhere else, so it is worth exactly one command: its reading feeds
    // corroborateCursor instead of a second identical round trip, and its echo
    // becomes THIS command's echo so undoOracleEcho can put the speech tail back
    // if this command says nothing. A gate left over from an earlier command is
    // impossible — it is cleared unconditionally, whether or not it was used.
    // A gate a control hop has since invalidated (moveToControl sets `moved`)
    // still serves as this command's echo and is refused as a cursor reading by
    // corroborateCursor.
    const gate = this.cursorGate;
    this.cursorGate = null;
    this.oracleEcho = gate?.oracle ?? null;
    const cursor = await this.corroborateCursor(command, context?.milestone, gate);
    try {
      const budget = command === "type" ? this.commandTimeoutMs + (arg?.length ?? 0) * 1000 : this.commandTimeoutMs;
      await this.withTimeout(command, this.execute(command, arg, context), budget);
    } catch (e) {
      if (e instanceof NvdaCommandTimeoutError || e instanceof NvdaUnsupportedCommandError) throw e;
      error = e instanceof Error ? e.message : String(e);
      // replayPlan ignores observation.error, so a `type` that threw part-way up
      // the ladder recorded no fidelity at all and read as a clean step. It
      // cannot claim the text landed, so record it as degraded here; the ladder's
      // own debug lines say which rung it died on. (steps.length is this step's
      // index — see recordFidelity.)
      if (command === "type" && !this.typeFidelity.some((f) => f.stepIndex === this.steps.length)) {
        this.typeFidelity.push({
          stepIndex: this.steps.length,
          text: (arg ?? "").slice(0, 60),
          focusRoute: "threw",
          carriedBy: null,
          hostSetValue: false,
          // Unknown from out here: the ladder dies inside execute() and its own
          // clear verdict goes with it. "none" is the honest floor — the debug
          // lines say whether a clear had already run.
          hostClear: "none",
          landed: false,
          reason: "command-threw",
          detail: error.slice(0, 160),
          degraded: true
        });
      }
    }
    let { rawSpoken, currentItem } = await this.collect();
    // A silent command leaves the oracle's own answer as the speech tail; put
    // the tail back before ANY of the logic below reads it (see undoOracleEcho).
    currentItem = this.undoOracleEcho(currentItem);
    // Self-heal a cursor escape into browser chrome: re-enter the web area.
    if (
      NVDA_CURSOR_ESCAPED.test(currentItem.trim()) &&
      this.hostFocus &&
      this.escapeRecoveries < MAX_ESCAPE_RECOVERIES
    ) {
      this.escapeRecoveries++;
      this.debug("cursor escaped web content — recovering", {
        command,
        item: currentItem,
        recovery: this.escapeRecoveries
      });
      await this.enterWebArea();
      const recovered = await this.collect();
      rawSpoken = [...rawSpoken, ...recovered.rawSpoken];
      currentItem = recovered.currentItem;
    }
    // Speech-loss detection — the OTHER way this driver's cursor gets stuck, and
    // the one the trap detector below cannot see.
    //
    // Evidence (run 30455293803, three write tasks): the plan's own `interact`
    // toggled focus mode on with the review cursor on "banner landmark", and NVDA
    // then reported item:"" for ~270 consecutive commands. Nothing recovered,
    // because itemText() is what milestone matching and the read-needle sweep both
    // read: the resync could never match, the cursor never reached the field, and
    // `type` finally fired on a nav link. Each blind command still costs ~2.25s,
    // so the attempt burned ~10 minutes and surfaced only as a `readNext hung for
    // 30000ms` at the end.
    //
    // What counts as evidence of silence is deliberately narrow. A blank item is
    // meaningful only when the command actually asked NVDA to speak: guidepup
    // pushes one log entry per captured gesture and pushes "" when nothing was
    // spoken in the debounce window, so "new entries, all empty" means NVDA took
    // the keystroke and said nothing. Two exclusions follow from the same
    // mechanism: `observe` performs no gesture at all, so it adds no entries and
    // merely re-reads the tail (no new evidence either way), and `type` runs its
    // whole ladder with capture:false, which appends an empty entry PER
    // CHARACTER by construction — counting that would flag every write step.
    const spokeNothing = rawSpoken.length > 0 && rawSpoken.every((phrase) => phrase.trim().length === 0);
    const heardSomething = currentItem.trim().length > 0 || rawSpoken.some((phrase) => phrase.trim().length > 0);
    if (heardSomething) {
      if (this.blankObservations > 0) {
        this.debug("NVDA speech is back", {
          command,
          blankObservations: this.blankObservations,
          item: currentItem.slice(0, 120)
        });
      }
      this.blankObservations = 0;
    } else if (spokeNothing && command !== "type") {
      this.blankObservations++;
      if (this.blankObservations >= BLANK_OBSERVATION_LIMIT) {
        const context = {
          command,
          blankObservations: this.blankObservations,
          lastContentItem: this.lastContentItem?.raw ?? "(none)",
          recoveriesUsed: this.speechRecoveries
        };
        if (this.speechRecoveries >= MAX_SPEECH_RECOVERIES) {
          this.debug("NVDA SPEECH LOST AGAIN — all recoveries spent this attempt, abandoning it", context);
          throw new NvdaSpeechLostError(
            `NVDA keeps going silent: ${this.blankObservations} consecutive commands (through ${command}) produced ` +
              `no speech at all, for the ${MAX_SPEECH_RECOVERIES + 1}th time this attempt, so every observation is ` +
              `empty again. Milestone matching and the needle sweep both read itemText(), so the replay is blind — ` +
              `abandoning the attempt rather than issuing hundreds of ~2.25s blind commands. Last item with ` +
              `content: ${JSON.stringify(this.lastContentItem?.raw ?? "")}.`
          );
        }
        this.speechRecoveries++;
        this.debug("NVDA SPEECH LOST — no item text for consecutive commands, attempting recovery", context);
        const recovery = await this.recoverFromSpeechLoss();
        rawSpoken = [...rawSpoken, ...recovery.rawSpoken];
        currentItem = recovery.currentItem;
        if (currentItem.trim().length === 0) {
          this.debug("NVDA SPEECH STILL LOST after recovery — abandoning the attempt", {
            ...context,
            tried: recovery.tried
          });
          throw new NvdaSpeechLostError(
            `NVDA stopped reporting item text: ${this.blankObservations} consecutive commands (through ${command}) ` +
              `produced no speech at all, and ${recovery.tried} did not restore it. Milestone matching and the ` +
              `needle sweep both read itemText(), so the replay is blind from here — abandoning the attempt rather ` +
              `than issuing hundreds of ~2.25s blind commands. The usual cause is focus mode entered on a ` +
              `non-focusable container (see the \`interact\` guard). Last item with content: ` +
              `${JSON.stringify(this.lastContentItem?.raw ?? "")}.`
          );
        }
        this.debug("NVDA speech restored", { tried: recovery.tried, item: currentItem.slice(0, 120) });
        this.blankObservations = 0;
      }
    }
    // Trap detection: move commands that don't move inside a text-entry context
    // mean NVDA is stuck in focus mode on a field — pop back to browse mode.
    // Blank items are excluded from the identical-item count on purpose: "" === ""
    // made this counter run up on the wedge above (it reached TRAPPED_MOVE_LIMIT
    // within four commands), but its NVDA_TEXT_ENTRY_CONTEXT gate — which is here
    // because the trap it detects is a cursor stuck INSIDE a field — could never
    // pass on "banner landmark" plus nav-link speech, so it did nothing, silently.
    // Silence is now the blank detector's case; leaving the counter alone through
    // it also keeps a real trap either side of the wedge from being masked by a
    // run of empty "identical" items.
    if ((command === "next" || command === "previous") && currentItem.trim().length > 0) {
      this.trappedMoves = currentItem === this.lastMoveItem ? this.trappedMoves + 1 : 0;
      this.lastMoveItem = currentItem;
      if (
        this.trappedMoves >= TRAPPED_MOVE_LIMIT &&
        this.trapPops < MAX_TRAP_POPS &&
        NVDA_TEXT_ENTRY_CONTEXT.test([currentItem, ...rawSpoken.slice(-2)].join(" "))
      ) {
        this.trapPops++;
        this.trappedMoves = 0;
        this.debug("cursor trapped in focus mode — exiting to browse mode", { item: currentItem, pop: this.trapPops });
        await this.withTimeout(
          "trapPop:exitFocusMode",
          this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
        ).catch(() => {});
        const popped = await this.collect();
        rawSpoken = [...rawSpoken, ...popped.rawSpoken];
        currentItem = popped.currentItem;
      }
    }
    // A contradiction rides out on the step record's own error field. replayPlan
    // ignores observation.error (so this changes no control flow, and the ladder
    // above is untouched), but NvdaDebugLog.step prints it and it lands in
    // steps.json — the step that fired on the wrong element is no longer
    // indistinguishable from one that fired on the right one.
    if (cursor.contradiction) error = error ? `${error}; ${cursor.contradiction}` : cursor.contradiction;
    const strippedItem = stripNvdaBoilerplate(currentItem);
    const cleanedItem = strippedItem ?? currentItem;
    const alternates = new Set<string>();
    const announced = stripNvdaBoilerplate(rawSpoken.at(-1) ?? "");
    if (announced) alternates.add(announced);
    let roleFree = cleanedItem;
    let previous;
    do {
      previous = roleFree;
      roleFree = roleFree.replace(NVDA_AMBIGUOUS_ROLE_SUFFIX, "").trim();
    } while (roleFree !== previous && roleFree.length > 0);
    if (roleFree) alternates.add(roleFree);
    // Appended LAST so the two renderings above keep their existing rank in
    // resolveFieldLabelCandidates' `previous-step-item`/`last-content-item`
    // sources; these only ever add a more specific label behind them.
    for (const suffix of nvdaLineSegmentAlternates(cleanedItem)) alternates.add(suffix);
    alternates.delete(cleanedItem);
    alternates.delete("");
    const observation = buildObservation(
      rawSpoken.map((p) => stripNvdaBoilerplate(p)).filter((p): p is string => p !== null),
      cleanedItem,
      null,
      { noisePatterns: this.noisePatterns, error, currentItemAlternates: [...alternates] }
    );
    // Remember the last item that carried CONTENT. itemText() is an alias for
    // lastSpokenPhrase(), so by the time `type` runs the only thing NVDA has
    // said is the preceding `interact`'s "focus mode" — boilerplate, hence the
    // empty label that used to collapse the entire type ladder. This is the
    // label source instead (see resolveFieldLabelCandidates).
    if (strippedItem) {
      this.lastContentItem = { primary: cleanedItem, alternates: [...alternates], raw: currentItem.trim() };
    }
    const record: AtStepRecord = {
      index: this.steps.length,
      command,
      ...(arg === undefined ? {} : { arg }),
      observation,
      rawSpoken,
      startedTimestamp,
      endedTimestamp: new Date().toISOString()
    };
    this.steps.push(record);
    this.onStep?.(record);
    return observation;
  }

  /**
   * Run one `next`/`previous` arrow without letting it answer the survey.
   *
   * Three parts, because neither half alone is enough (see
   * ARROW_MUTABLE_SELECTOR for the measurement this is built on):
   *
   *  1. PREVENT. When DOM focus sits on an arrow-mutable control, leave focus
   *     mode first. Escape (keyboardCommands.exitFocusMode) is the right gesture
   *     precisely here: NVDA switches to focus mode AUTOMATICALLY when focus
   *     reaches a form control, and Escape undoes an automatic switch. It is sent
   *     ONLY in that case, never on every arrow, because in browse mode Escape
   *     goes to the page and would dismiss a dialog.
   *  2. VERIFY. Mode is not observable from the DOM — leaving focus mode moves no
   *     focus and changes no attribute — so prevention cannot be confirmed by
   *     asking. The answer itself can be: read it either side of the arrow.
   *  3. RECORD, then repair. A step that still changed something is a finding
   *     about the DRIVER, so it becomes a SweepMutation whatever the repair does.
   *
   * With no host channel this degrades to the old bare arrow. That is the honest
   * floor: the probes are host-side, and a driver without one has never been able
   * to see this.
   */
  private async arrowSweep(command: "next" | "previous" | "readNext", arrow: () => Promise<void>): Promise<void> {
    if (!this.hostEval) return arrow();

    const before = await this.hostEval(sweepSignatureJs(true)).catch(() => "");
    const [kind, key = "", value = ""] = before.split("|");
    // 'none' (nothing focused) and 'safe' (focused, but arrows do not change its
    // value) are the overwhelmingly common readings on a reading sweep, and both
    // exit before spending a single extra gesture.
    if (kind !== "radio" && kind !== "value") return arrow();

    this.debug("sweep: focus is on an arrow-mutable control — leaving focus mode before arrowing", {
      command,
      kind,
      key,
      answer: value
    });
    let leftFocusMode = true;
    await this.withTimeout(
      "sweep:exitFocusMode",
      this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" }),
      FOCUS_RUNG_TIMEOUT_MS
    ).catch((e) => {
      leftFocusMode = false;
      this.debug("sweep: exitFocusMode threw — arrowing anyway, the check below is the real guard", {
        error: String(e)
      });
    });

    await arrow();

    const after = await this.hostEval(sweepSignatureJs(false)).catch(() => "");
    const afterValue = after.split("|")[2] ?? "";
    // An unreadable after-reading is not a mutation: a lost host probe has never
    // been treated as proof of failure anywhere else in this file either.
    if (!after || after.split("|")[0] !== kind || afterValue === value) return;

    const restore = await this.hostEval(sweepRestoreJs(kind, key, value)).catch((e) => `threw|${String(e)}`);
    const confirm = await this.hostEval(sweepSignatureJs(false)).catch(() => "");
    const restored = (confirm.split("|")[2] ?? "") === value;
    this.debug("sweep: THE ARROW CHANGED THE ANSWER — this step read nothing, it wrote (issue #913)", {
      command,
      kind,
      key,
      before: value,
      after: afterValue,
      leftFocusMode,
      restore,
      restored
    });
    this.sweepMutations.push({
      stepIndex: this.steps.length,
      command,
      kind,
      key,
      before: value,
      after: afterValue,
      leftFocusMode,
      restore: restore.slice(0, 160),
      restored
    });
  }

  /**
   * Move the review cursor from a control's LABEL TEXT onto the control itself,
   * so `act`'s Enter has something it can actually activate.
   *
   * The failure this exists for, measured on the seeded survey. NVDA's browse
   * buffer splits a SurveyJS choice across two lines, and the control's own line
   * carries role and state but NO name (the label text is already adjacent in
   * the buffer, so NVDA does not repeat it):
   *
   *   line 3  the radio       spoken "radio button, not checked"
   *   line 4  the label text  spoken "Just right"   navigatorObject "label"
   *
   * A milestone of "just right" can therefore ONLY match line 4 — and Enter
   * there does nothing whatsoever (measured: nothing checked, activeElement
   * BODY). Worse, the ladder never notices: the speech matches, the cursor
   * oracle answers a bare "label" and correctly ABSTAINS, and the gate accepts
   * on abstain, so zero resyncs fire and the control-hop rung never runs. The
   * survey was submitted with whatever was checked by other means.
   *
   * BACKWARD, not forward: the control PRECEDES its label text in the buffer, so
   * the next form field forward from line 4 is the following option — hopping
   * that way would select "Too fast" when the plan asked for "Just right".
   *
   * Reached only as a FALLBACK, after an Enter that provably changed nothing
   * (see `case "act"`). That ordering is the correction for three red runs spent
   * trying to predict which widgets need it:
   *
   *  - the oracle reply must be a bare `label`. "Any nameless object" also
   *    catches ordinary prose, whose reply is "paragraph"; that suppressed a
   *    working Enter on a milestone of "post" (run 31270612942).
   *  - the LINE must not announce a control, which keeps buttons and links out.
   *  - EVERY milestone word must appear on what the hop landed on. Overlap
   *    accepted "Reference Assignment (Optional), combo box" for a milestone of
   *    "privacy (optional)" on the single word "optional", so Enter opened a
   *    combo box instead of ticking a checkbox (run 31270612942).
   *
   * None of those was enough on its own, because the distinguishing fact is not
   * visible in the announcement at all. Run 31286526726 measured the Chakra
   * privacy checkbox presenting the SAME bare-label line as a SurveyJS choice
   * ("Privacy (Optional)", no role word, `label` object) — yet Enter ticks it,
   * because its `<label>` activates its input, while SurveyJS's leaves
   * activeElement on BODY. No amount of reading the speech separates those. Only
   * pressing the key and looking at the page does, which is why this now runs
   * after the Enter rather than instead of it.
   *
   * `skip` therefore means "the Enter already happened and did nothing, and the
   * hop could not find the control either" — a genuine dead end, not a
   * suppressed keystroke.
   *
   * Returns "skip" when the hop did not reach a control matching the milestone.
   * Skipping is safe by construction: the Enter it suppresses is the one already
   * proven to be a no-op, so this is never worse than the behaviour it replaces,
   * and it is far better than firing Enter at whatever the hop landed on.
   */
  /**
   * Is this `act` sitting on the shape that MIGHT need retargeting — a line of
   * bare label text, matched by a naming milestone, with a nameless `label`
   * navigator object?
   *
   * Answering yes costs only the two host reads that bracket the Enter; it does
   * not change what the Enter does. That is the whole point of the inversion:
   * the previous shape decided to retarget INSTEAD of pressing Enter, and was
   * wrong about which widgets need it (run 31286526726 — the Chakra privacy
   * checkbox has exactly the same bare-label line as SurveyJS, but Enter on it
   * works, because its `<label>` activates its input where SurveyJS's does not).
   * Pressing first and checking after replaces that guess with a measurement.
   */
  private async actNeedsNoOpCheck(milestone: string | undefined): Promise<boolean> {
    if (!this.hostEval) return false;
    const wanted = cursorOracleApplies(milestone);
    if (!wanted.applies) return false;
    const check = this.cursorChecks.at(-1);
    if (!check || check.stepIndex !== this.steps.length || check.command !== "act") return false;
    if (check.verdict !== "abstained" || check.objectTokens.length > 0) return false;
    if (clean(check.reply) !== "label") return false;
    const line = this.undoOracleEcho(await this.itemTextSafe(ITEM_TEXT_PROBE_MS));
    return !ACT_LINE_NAMES_A_CONTROL.test(line);
  }

  private async retargetActToControl(milestone: string | undefined): Promise<"proceed" | "skip"> {
    const wanted = cursorOracleApplies(milestone);
    if (!wanted.applies) return "proceed";
    // corroborateCursor ran for THIS step (run() calls it before execute) and
    // stamped its record with the index this step is about to take.
    const check = this.cursorChecks.at(-1);
    if (!check || check.stepIndex !== this.steps.length || check.command !== "act") return "proceed";
    if (check.verdict !== "abstained" || check.objectTokens.length > 0) return "proceed";
    // The reply must be a bare LABEL, not merely nameless. Run 31270612942
    // proved the difference matters: a milestone of "post" sat on ordinary prose
    // whose reply was "paragraph", this guard engaged, the hop landed on the
    // reply textarea and SUPPRESSED an Enter that had been working. "paragraph"
    // is exactly the benign collapse NVDA_ROLE_TOKENS documents — plain text has
    // no name to give. A `<label>` is different in kind: it is never a thing to
    // activate, only ever a wrapper around the control that is.
    if (clean(check.reply) !== "label") return "proceed";
    // ...and the LINE must be bare text. A nameless `label` navigator object does
    // NOT imply Enter is a no-op — that was measured on SurveyJS markup and does
    // not generalise. Run 31273130928 proved the counter-example: the Chakra
    // privacy checkbox also reports a `label` object, but its browse LINE already
    // carries name and role ("Privacy (Optional), check box, checked, ...") and
    // Enter on it works. Suppressing that Enter failed a task that had passed.
    //
    // What actually separates the two is whether the line NVDA matched the
    // milestone against announced a control at all. The broken case is a line of
    // pure label text with no role word anywhere in it ("Just right"); the
    // working case names its own role. Only the former needs retargeting, and
    // only the former is proven to be a dead Enter.
    // undoOracleEcho, exactly as `case "interact"` does and for the same reason:
    // itemText() is an alias for lastSpokenPhrase(), corroborateCursor has just
    // interrogated the oracle for this very step, so without this the "line" read
    // here is the oracle's own answer — "label" — which of course names no
    // control. Run 31275593976 is what that cost: the stand-down never fired,
    // privacy (optional) retargeted anyway and help-request failed a third time.
    const raw = await this.itemTextSafe(ITEM_TEXT_PROBE_MS);
    const before = this.undoOracleEcho(raw);
    if (ACT_LINE_NAMES_A_CONTROL.test(before)) {
      this.debug("act: line already announces a control — leaving this act alone", { item: before.slice(0, 120) });
      return "proceed";
    }

    // Everything the stand-down decision rests on. Run 31282511729 showed it not
    // firing on the privacy checkbox with no way to tell WHY from the log: the
    // pre-hop line was never recorded, only the oracle reply. These four fields
    // separate the possibilities — the echo was not undone (raw === before and
    // both are "label"), the tail was some third phrase entirely, or the line
    // genuinely carries no role word at that moment.
    this.debug("act: cursor is on bare label text, not the control it names", {
      milestone,
      oracleReply: check.reply.slice(0, 120),
      rawTail: raw.slice(0, 160),
      lineAfterUndoEcho: before.slice(0, 160),
      namesAControl: ACT_LINE_NAMES_A_CONTROL.test(before),
      lastContentItem: this.lastContentItem?.raw.slice(0, 160) ?? "(none)",
      hop: "previous form field (the control precedes its label text)"
    });
    await this.moveToControl("previous");
    const item = await this.itemTextSafe(ITEM_TEXT_PROBE_MS);
    // The hop's own speech is enough here and costs nothing extra: a form-field
    // quick-nav announces the control the way focus does, name included
    // ("Just right, radio button, not checked"), which is exactly the name the
    // line read omitted.
    const { content } = nvdaCursorTokens(item);
    // EVERY milestone word must be present, not merely one. Overlap alone is far
    // too weak for a gesture that picks WHICH control gets activated: in run
    // 31270612942 a milestone of "privacy (optional)" shared its one word
    // "optional" with "Reference Assignment (Optional), combo box" and this hop
    // accepted it, so Enter opened a combo box instead of ticking the privacy
    // checkbox and the whole help-request task failed. Overlap is the right rule
    // for judgeCursorOracle, which only has to decide whether two readings
    // describe the same place; it is the wrong rule here.
    const missing = wanted.tokens.filter((token) => !content.includes(token));
    if (missing.length === 0) {
      this.debug("act: retargeted onto the control the milestone names", {
        item: item.slice(0, 120),
        matched: wanted.tokens
      });
      return "proceed";
    }
    this.debug("act: RETARGET FAILED — not firing Enter, which would activate the wrong control", {
      milestone,
      landedOn: item.slice(0, 120),
      wanted: wanted.tokens,
      missing
    });
    return "skip";
  }

  private async execute(command: AtCommand, arg?: string, context?: AtStepContext): Promise<void> {
    const nvda = this.nvda;
    const kc = nvda.keyboardCommands;
    const opts = this.commandOptions;
    switch (command) {
      case "observe":
        return;
      case "next":
        return this.arrowSweep("next", () => nvda.next(opts));
      case "previous":
        return this.arrowSweep("previous", () => nvda.previous(opts));
      case "act": {
        // A milestone can match the LABEL TEXT of a control rather than the
        // control. Enter there does nothing on some widgets and works fine on
        // others, so the Enter goes FIRST and the retarget is the fallback for
        // when it demonstrably did nothing (see retargetActToControl).
        if (!(await this.actNeedsNoOpCheck(context?.milestone))) return nvda.act(opts);
        const signature = () => this.hostEval!(actStateSignatureJs()).catch(() => "");
        const before = await signature();
        await nvda.act(opts);
        const after = await signature();
        // A lost read (hostEval reports "") is not evidence either way, and must
        // not be mistaken for "nothing is checked" — which is the survey's own
        // starting state. Only two good reads that AGREE prove the key was dead.
        const readable = before.startsWith(ACT_SIGNATURE_PREFIX) && after.startsWith(ACT_SIGNATURE_PREFIX);
        if (!readable || after !== before) {
          this.debug("act: Enter changed an answer, or the check was unreadable — no retarget", {
            milestone: context?.milestone,
            before,
            after,
            readable
          });
          return;
        }
        if ((await this.retargetActToControl(context?.milestone)) === "skip") return;
        return nvda.act(opts);
      }
      case "interact": {
        // NVDA has no interaction levels; entering focus mode is the analogue.
        // But NVDA+Space is a TOGGLE, not a descent, and toggling focus mode onto
        // a non-focusable CONTAINER wedges NVDA: in run 30455293803 the plan's
        // counted navigation had drifted into the nav sidebar, this step fired
        // anyway, NVDA announced "banner landmark" — and then spoke nothing for
        // ~270 commands (the speech-loss detector in run() is the other half of
        // this fix). The other two write tasks reached the same state via "main
        // landmark" and "Skip links, navigation landmark".
        //
        // Every branch below logs its decision, and each is narrow on purpose:
        // `interact` legitimately precedes every `type` in the write plans, and
        // suppressing it on a real field would leave the caret in browse mode
        // where a letter is quick-nav. Note also that a skip here is recoverable
        // — the type ladder's rung 0b re-sends this exact gesture and verifies it
        // host-side — whereas a wedge is not.
        const before = this.undoOracleEcho(await this.itemTextSafe(ITEM_TEXT_PROBE_MS));
        // itemText()-is-lastSpokenPhrase() is a liability everywhere else in this
        // file; here it is the reading we want, because what NVDA said in
        // response to the PREVIOUS step is the evidence of where the cursor is.
        // undoOracleEcho keeps that true: `interact` is a milestone-bearing
        // state-changing command, so the cursor oracle has just spoken, and
        // without it this would read OUR question's answer instead of the
        // previous step's announcement — a different (and untested) guard input.
        if (isNvdaContainerItem(before)) {
          this.debug("interact: SKIPPED — cursor is on a landmark container, NVDA+Space there wedges NVDA", {
            item: before.slice(0, 120)
          });
          return;
        }
        const focus = await this.hostFocusCanTakeText(true);
        if (focus.verdict === "yes") {
          // In focus mode the toggle means LEAVE focus mode. The discussion reply
          // autofocuses its textarea ~100ms after the reply button (see rung 0a),
          // so this is the common legitimate case, and toggling out of it hands
          // the following `type` the worst possible mode. Only an explicit "yes"
          // counts — never "unknown" (see HostVerdict).
          this.debug("interact: SKIPPED — DOM focus already accepts text, NVDA+Space would leave focus mode", {
            field: focus.detail
          });
          return;
        }
        this.debug("interact: entering focus mode", {
          item: before.slice(0, 120),
          focusProbe: focus.verdict,
          activeElement: focus.detail.slice(0, 120)
        });
        await nvda.perform(kc.toggleBetweenBrowseAndFocusMode, opts);
        // Post-check, and the load-bearing half: with capture:"initial" the
        // perform resolves on the FIRST phrase NVDA speaks in response, and that
        // phrase is the only direct evidence of what focus mode landed on. It is
        // also the only evidence available for the observed failure — there the
        // pre-gesture phrase was "link, current page, graphic" (a nav link), and
        // "banner landmark" appeared only as the toggle's own answer. A healthy
        // interact answers "focus mode" or names the field; a landmark means we
        // are one command away from the wedge. Undo with the toggle, not
        // exitFocusMode: that is Escape, and NVDA honours Escape only for an
        // AUTOMATIC mode switch, never for a manual NVDA+Space.
        //
        // Settle first: capture:"initial" resolves on the FIRST phrase, but NVDA
        // announces the mode change and then the object, and it is the LAST of
        // those that says what we landed on.
        await settle(NVDA_FOCUS_SETTLE_MS);
        const after = this.undoOracleEcho(await this.itemTextSafe(ITEM_TEXT_PROBE_MS));
        if (isNvdaContainerItem(after)) {
          // One corroborating question before undoing, because the announcement
          // can name the enclosing landmark of a field we DID reach: if DOM focus
          // now accepts text, focus mode landed on something typable and undoing
          // it would be the "suppressed a legitimate interact" bug. Only an
          // explicit "yes" saves the toggle — "unknown" is not a yes.
          const landed = await this.hostFocusCanTakeText(true);
          if (landed.verdict === "yes") {
            this.debug("interact: announcement named a landmark but DOM focus takes text — keeping focus mode", {
              item: after.slice(0, 120),
              field: landed.detail
            });
            return;
          }
          this.debug("interact: focus mode landed on a landmark container — UNDOING before it wedges NVDA", {
            item: after.slice(0, 120),
            focusProbe: landed.verdict,
            activeElement: landed.detail.slice(0, 120)
          });
          await this.withTimeout(
            "interact:undoContainerFocusMode",
            nvda.perform(kc.toggleBetweenBrowseAndFocusMode, { capture: "initial" }),
            FOCUS_RUNG_TIMEOUT_MS
          ).catch((e) => this.debug("interact: undo toggle threw", { error: String(e) }));
        }
        return;
      }
      case "stopInteracting":
        return nvda.perform(kc.exitFocusMode, opts);
      case "press":
        // Deliberately NO focus routing here, unlike vo/voHarness (which routes
        // keyboard focus to the VO cursor before every press): in NVDA browse
        // mode press("Enter") IS the activation gesture for the navigator
        // object, so pre-routing focus would change WHICH element gets
        // activated — the opposite of what the plan recorded.
        return nvda.press(arg ?? "Enter");
      case "pressKey":
        return nvda.press(arg ?? "Tab");
      case "type": {
        const text = arg ?? "";
        if (!text) return;
        // run() gives this command a budget of commandTimeoutMs + len*1000 and
        // then ABANDONS it — withTimeout only races, it never cancels, and
        // guidepup's client queue is serial so a hung gesture cannot be skipped.
        // When the budget blows, run.ts retries the task: closeAllWindows() +
        // openUrl(), a brand-new page — and an abandoned ladder would keep
        // typing, pasting and setting values into THAT page, poisoning attempt 2
        // nondeterministically. So carry our own deadline, 2s inside run()'s,
        // and stop issuing gestures once it passes.
        const deadline = Date.now() + this.commandTimeoutMs + text.length * 1000 - 2_000;
        const expired = (where: string): boolean => {
          if (Date.now() < deadline) return false;
          this.debug("type: BUDGET EXPIRED — abandoning the ladder before it can mutate a replaced page", { where });
          return true;
        };
        await this.ensureBrowserForeground(expired); // rung −1
        const route = expired("rungs 0a/0b")
          ? { ok: false, rung: "expired", detail: "" }
          : await this.routeFocusForTyping(expired); // rungs 0a + 0b
        // Fidelity bookkeeping (observational only — it changes no rung and no
        // ordering). Every exit from the ladder below records exactly one
        // TypeStepFidelity: WHICH rung wrote the text, whether rung 4 bypassed
        // the keyboard, and the final landed verdict. Without this the ladder's
        // findings lived only in debug() and the step reported as a clean pass.
        let carriedBy: TypeRung | null = null;
        let hostSetValueFired = false;
        let hostClear: TypeStepFidelity["hostClear"] = "none";
        // Verification baseline: the content the field ALREADY held when this step
        // started, which is the only extra content verification will tolerate (see
        // typedTextLanded's allowedPrefill). Measured by rung 0c's probe below —
        // "" until then, and "" again the moment a rung host-clears the field, so
        // the tolerance can never outlive the content it was granted for.
        let allowedPrefill = "";
        const recordFidelity = (landed: boolean, reason: TypeFidelityReason, detail: string): void => {
          this.typeFidelity.push({
            // run() pushes this step's record AFTER execute() returns, so the
            // current length is the index this step will have in steps[].
            stepIndex: this.steps.length,
            text: text.slice(0, 60),
            focusRoute: route.rung,
            carriedBy: landed ? carriedBy : null,
            hostSetValue: hostSetValueFired,
            hostClear,
            landed,
            reason,
            detail: detail.slice(0, 160),
            degraded: hostSetValueFired || !landed
          });
        };
        // Rung 0c — single-character safety valve, NVDA-specific and the reason
        // this whole ladder exists: in BROWSE mode a letter is quick-nav, so a
        // mis-routed 68-character string is 68 caret jumps across the document
        // (observed live: keystrokes landed on the skip link, MAIN, BODY, the
        // toast group, and an unrelated search input). Spend ONE character to
        // find out, then either type the rest or jump straight to rung 2.
        // capture:false throughout — NVDA echoes each typed char into a
        // live-region-chatty field and guidepup's post-type capture-poll waits
        // for speech to STABILIZE, which never happens → the command hangs to
        // its budget (6 hangs → 0 when this was added; do not remove).
        let skippedRung1 = false;
        if (expired("rungs 0c/1")) {
          // Not one character was sent, so "did not land" is the honest verdict
          // — the budget-expiry debug line alone used to leave this step clean.
          recordFidelity(false, "budget-expired", "ladder abandoned before rungs 0c/1");
          return;
        }
        if (text.length >= 2 && this.hostEval) {
          const before = await this.hostFieldValue(true);
          // Doubles as the verification baseline. Only a READ field counts: with
          // "nofield"/"unknown" we cannot tell a prefilled field from an empty
          // one, and an unmeasured tolerance is exactly the kind of incidental
          // slack that let `text + text` pass as `match`.
          if (before.verdict === "ok" && before.value.trim() !== "") allowedPrefill = before.value;
          await nvda.type(text.slice(0, 1), { capture: false });
          // Probe twice: SendKeys delivery is asynchronous at the OS level and a
          // false "did not append" costs a whole rung-2 retype, so give the app
          // a second look before condemning the keystroke.
          let after: FieldValueProbe | null = null;
          let appended = false;
          let unknown = false;
          for (const wait of [250, 400]) {
            await settle(wait);
            after = await this.hostFieldValue(false);
            if (before.verdict === "unknown" || after.verdict === "unknown") {
              unknown = true;
              break;
            }
            // sameElement matters: focus moving to a field that already holds
            // text otherwise reads as a successful append.
            appended =
              before.verdict === "ok" &&
              after.verdict === "ok" &&
              after.sameElement &&
              after.value.length > before.value.length;
            if (appended) break;
          }
          this.debug("type: rung 0c single-character safety valve", {
            route: route.rung,
            appended,
            unknown,
            before: before.verdict === "ok" ? before.value.slice(-40) : `<${before.verdict}>`,
            after: after && after.verdict === "ok" ? after.value.slice(-40) : `<${after?.verdict ?? "none"}>`,
            sameElement: after?.sameElement
          });
          if (unknown) {
            // Host verification is what makes 0c meaningful; without it, staying
            // on the pure-AT path is the non-escalating choice.
            this.debug("type: rung 0c INCONCLUSIVE — host probe failed; continuing on the pure-AT path");
            await nvda.type(text.slice(1), { capture: false }); // rung 1: pure AT
          } else if (appended) {
            await nvda.type(text.slice(1), { capture: false }); // rung 1: pure AT
          } else {
            skippedRung1 = true;
            this.debug(
              "type: rung 0c FAILED — first character did not append; NOT spraying the remaining " +
                `${text.length - 1} characters as browse-mode quick-nav keys, jumping to rung 2`
            );
          }
        } else {
          await nvda.type(text, { capture: false }); // rung 1: pure AT
        }
        // Rung 1 fired in every branch above except the 0c safety valve.
        if (!skippedRung1) carriedBy = "1";
        if (this.hostEval && (skippedRung1 || text.length >= 3)) {
          let check: LandedCheck = skippedRung1
            ? { landed: false, reason: "skipped-rung-1", detail: "rung 0c safety valve tripped" }
            : await this.typedTextLanded(text, false, allowedPrefill);
          if (!check.landed) {
            this.debug("type: rung 2 — host-assisted field focus + retype", {
              reason: check.reason,
              detail: check.detail.slice(0, 120),
              route: route.rung,
              activeElement: await this.describeActiveElement()
            });
            // Was a specific element deliberately routed to? Verification is
            // then allowed to insist the text landed in THAT element, not just
            // in whatever ended up focused.
            let routed = false;
            const candidateList: string[] = [];
            if (!expired("rung 2")) {
              // RECOMPUTE the candidates: the pre-type label is stale by now (0b
              // and the 0c character may both have moved focus), and reusing it
              // was how every rung of the old ladder inherited the same empty
              // string.
              const { candidates, sources } = await this.resolveFieldLabelCandidates(context?.milestone);
              candidateList.push(...candidates);
              // `sources` naming plan-milestone is how a runner log shows the
              // plan's own field name was available (and used) at this step.
              this.debug("type: focus label candidates", {
                sources,
                milestone: context?.milestone ?? "(none)",
                candidates: candidates.slice(0, 8)
              });
              const hostRoute = await this.hostFocusField(candidates);
              routed = !/^(none|skipped|error)/.test(hostRoute.strategy);
              await settle(NVDA_FOCUS_SETTLE_MS);
              // Re-probe before retyping: if host focus missed too, the retype
              // would spray the whole string as quick-nav keys and undo the very
              // thing rung 0c bought us. Ctrl+A/Ctrl+V (rung 3) are modified
              // keystrokes and stay safe in browse mode, so we still try those.
              const canRetype = await this.hostFocusCanTakeText();
              if (canRetype.verdict === "no") {
                this.debug("type: rung 2 retype SKIPPED — focus still cannot take text after host routing", {
                  strategy: hostRoute.strategy,
                  detail: hostRoute.detail.slice(0, 120),
                  activeElement: canRetype.detail
                });
                check = { landed: false, reason: "not-a-field", detail: canRetype.detail };
              } else {
                if (canRetype.verdict === "unknown") {
                  this.debug("type: rung 2 probe UNKNOWN — retyping anyway rather than escalating to paste/set", {
                    probe: canRetype.detail
                  });
                }
                // Control+a still goes FIRST — when NVDA really is in focus mode
                // it is the honest user gesture, and the host clear then simply
                // agrees with it — but we no longer RELY on it. Control+a selects
                // a field's contents only when the field has real DOM focus,
                // which is the very condition rung 2 exists to recover from: in
                // run 30457321723 it selected nothing, this retype APPENDED, and
                // the textarea ended up holding the 32-character string twice.
                await nvda.press("Control+a", { capture: false });
                const cleared = await this.hostClearField();
                hostClear = cleared.verdict;
                if (cleared.verdict === "cleared") allowedPrefill = "";
                if (cleared.verdict === "dirty") {
                  // Typing here would append — the doubling mechanism itself.
                  // Refuse, and leave it to the rungs that REPLACE atomically
                  // (rung 3 pastes into a cleared field, rung 4 assigns).
                  this.debug(
                    "type: rung 2 retype REFUSED — field still holds content after Control+a AND a host clear; " +
                      "typing into it would APPEND, which is how the doubled value happened",
                    { residue: cleared.residue.slice(0, 80), detail: cleared.detail }
                  );
                  check = { landed: false, reason: "unclearable-field", detail: cleared.detail };
                } else {
                  if (cleared.verdict === "unknown") {
                    // A broken confirming read is not proof the field kept its
                    // content (the standing rule for every host probe here), and
                    // a doubled value now FAILS verification instead of passing
                    // it — so retype rather than escalate to a degraded rung.
                    this.debug(
                      "type: rung 2 host clear UNCONFIRMED — retyping anyway; verification will catch a double",
                      {
                        detail: cleared.detail
                      }
                    );
                  }
                  await nvda.type(text, { capture: false });
                  carriedBy = "2";
                  check = await this.typedTextLanded(text, routed, allowedPrefill);
                }
              }
            }
            if (!check.landed && this.hostSetClipboard && !expired("rung 3")) {
              // Rung 3: atomic paste — an autosave rerender cannot interrupt it
              // mid-stream. Give the pasteboard time to settle before Ctrl+V.
              this.debug("type: rung 3 — retype missed too, atomic clipboard paste", { reason: check.reason });
              const pasteRoute = await this.hostFocusField(candidateList);
              routed = !/^(none|skipped|error)/.test(pasteRoute.strategy);
              // Same story as rung 2, and worse: Control+V with nothing selected
              // INSERTS at the caret. An unverified Control+a in front of it is
              // one more chance to double the value rather than replace it.
              await nvda.press("Control+a", { capture: false });
              const clearedForPaste = await this.hostClearField();
              hostClear = clearedForPaste.verdict;
              if (clearedForPaste.verdict === "cleared") allowedPrefill = "";
              if (clearedForPaste.verdict === "dirty") {
                this.debug(
                  "type: rung 3 paste REFUSED — field still holds content after Control+a AND a host clear; " +
                    "Control+V would INSERT alongside it",
                  { residue: clearedForPaste.residue.slice(0, 80), detail: clearedForPaste.detail }
                );
                check = { landed: false, reason: "unclearable-field", detail: clearedForPaste.detail };
              } else {
                await this.hostSetClipboard(text);
                await settle(500);
                await nvda.press("Control+v", { capture: false });
                carriedBy = "3";
                check = await this.typedTextLanded(text, routed, allowedPrefill);
              }
            }
            if (!check.landed && !expired("rung 4")) {
              // Rung 4, DEGRADED FIDELITY: keyboard input failed into a
              // host-verified-focused field. Logged loudly every time — it is
              // reported as an app finding, not swept up as harness flake.
              this.debug("type: rung 4 HOST VALUE FALLBACK — keyboard input failed twice (degraded fidelity)", {
                reason: check.reason,
                detail: check.detail.slice(0, 120)
              });
              hostSetValueFired = true;
              const setResult = await this.hostSetValue(text);
              carriedBy = "4";
              this.debug("type: rung 4 result", { setResult: setResult.slice(0, 120) });
              if (setResult.startsWith("wrote|")) {
                // The native setter replaced the whole value, so nothing of the
                // baseline survives: drop the tolerance and let the final check
                // insist on EXACTLY the expected text. If the app then re-appends
                // (a rerender restoring its own state), that is a finding worth
                // failing on, not something to wave through.
                allowedPrefill = "";
              } else {
                this.debug("type: rung 4 DID NOT WRITE — the host value fallback itself failed", {
                  setResult: setResult.slice(0, 120)
                });
              }
            }
            const final = await this.typedTextLanded(text, routed, allowedPrefill);
            this.debug("type: after recovery", {
              landed: final.landed,
              reason: final.reason,
              routedTarget: routed,
              activeElement: await this.describeActiveElement()
            });
            // The post-recovery re-check is the authoritative verdict for this
            // step: a rung's own check can land and then be undone by a
            // rerender, and it is the LAST reading that says what the user got.
            check = final;
          }
          recordFidelity(check.landed, check.reason, check.detail);
        } else {
          // No host channel, or text too short to verify: rung 1 typed it and
          // nothing can prove where it went. Recorded as unverified rather than
          // as a pass we cannot back up — but not as degraded either, since a
          // lost verification is not a proven failure (see typedTextLanded).
          recordFidelity(true, "unverified", "no host verification for this step");
        }
        return;
      }
      case "readNext": {
        const n = Math.min(Math.max(parseInt(arg ?? "10", 10) || 10, 1), READ_NEXT_MAX);
        // Through arrowSweep, exactly like `next`/`previous`: these are the SAME
        // ArrowDown, and a read-ahead is if anything the more dangerous of the
        // two because it fires up to READ_NEXT_MAX of them in a row. Calling
        // nvda.next() directly here left the biggest sweep in the plans
        // unguarded, which is why q2 kept coming back "Too slow" long after the
        // `act` had correctly selected "Just right" (run 31315071708), and why
        // the original #913 log shows 27-28 announcements of each option.
        for (let i = 0; i < n; i++) await this.arrowSweep("readNext", () => nvda.next(opts));
        return;
      }
      case "restartFromTop":
        return nvda.press("Control+Home");
      case "moveToNextHeading":
        return nvda.perform(kc.moveToNextHeading, opts);
      case "moveToPreviousHeading":
        return nvda.perform(kc.moveToPreviousHeading, opts);
      case "moveToNextLink":
        return nvda.perform(kc.moveToNextLink, opts);
      case "moveToPreviousLink":
        return nvda.perform(kc.moveToPreviousLink, opts);
      case "moveToNextForm":
        return nvda.perform(kc.moveToNextFormField, opts);
      case "moveToNextLandmark":
        return nvda.perform(kc.moveToNextLandmark, opts);
      case "moveToPreviousLandmark":
        return nvda.perform(kc.moveToPreviousLandmark, opts);
      case "moveToNextMain":
        // NVDA has no "next main" primitive; landmark-hop is the honest
        // equivalent (main is a landmark). Plans currently never use this.
        return nvda.perform(kc.moveToNextLandmark, opts);
      default: {
        const exhaustive: never = command;
        throw new NvdaUnsupportedCommandError(`unsupported AT command for real NVDA: ${String(exhaustive)}`);
      }
    }
  }

  private async collect(): Promise<{ rawSpoken: string[]; currentItem: string }> {
    let rawSpoken: string[] = [];
    let currentItem = "";
    try {
      const log = await this.withTimeout("spokenPhraseLog", this.nvda.spokenPhraseLog());
      rawSpoken = log.slice(this.spokenLogCursor);
      this.spokenLogCursor = log.length;
      const itemLog = await this.withTimeout("itemTextLog", this.nvda.itemTextLog());
      for (const hopItem of itemLog.slice(this.itemTextLogCursor)) {
        if (hopItem && !rawSpoken.includes(hopItem)) rawSpoken.push(hopItem);
      }
      this.itemTextLogCursor = itemLog.length;
      currentItem = await this.withTimeout("itemText", this.nvda.itemText());
      const announced = stripNvdaBoilerplate(rawSpoken.at(-1) ?? "");
      if (
        announced &&
        currentItem &&
        announced.length > currentItem.trim().length &&
        announced.toLowerCase().startsWith(currentItem.trim().toLowerCase())
      ) {
        currentItem = announced;
      }
    } catch (e) {
      this.debug("collect: observation truncated", { error: String(e) });
    }
    return { rawSpoken, currentItem };
  }

  private withTimeout<T>(command: string, promise: Promise<T>, budgetMs = this.commandTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NvdaCommandTimeoutError(`NVDA command "${command}" hung for ${budgetMs}ms`)),
        budgetMs
      );
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }
}
