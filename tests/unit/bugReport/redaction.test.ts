/**
 * The redaction walker (package 3) on synthetic rrweb events: text split across nodes,
 * mutations replayed forward, attributes, inputs, breadcrumbs, URLs, the title, keepLastMs,
 * click-to-redact, and the remaining-strings list.
 */
import { redactBuffer, taintSnapshot } from "@/lib/bugReport/redaction";
import { extraRedactionDetector, taintDetector } from "@/lib/bugReport/redaction/detectors";
import type { RedactOptions, TaintSnapshot } from "@/lib/bugReport/redaction/types";
import { redactReportUrl } from "@/lib/bugReport/redaction/reportUrl";
import { decodeUrlWithMap } from "@/lib/bugReport/redaction/urlText";
import { keepLast } from "@/lib/bugReport/redaction/walker";
import { createTaintSet, getTaintSet } from "@/lib/bugReport/taint";
import type { FrozenBuffer, FrozenSegment, RecordedEvent } from "@/lib/bugReport/types";

type Node = {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: Node[];
  textContent?: string;
  isStyle?: boolean;
};

let nextNodeId = 1;
const el = (tagName: string, attributes: Record<string, unknown> = {}, childNodes: Node[] = [], id = nextNodeId++) =>
  ({ id, type: 2, tagName, attributes, childNodes }) as Node;
const txt = (textContent: string, id = nextNodeId++, isStyle?: boolean) =>
  ({ id, type: 3, textContent, ...(isStyle ? { isStyle } : {}) }) as Node;
const doc = (head: Node[], body: Node[]) =>
  ({ id: nextNodeId++, type: 0, childNodes: [el("html", {}, [el("head", {}, head), el("body", {}, body)])] }) as Node;

const meta = (timestamp: number, href = "http://localhost/course/1/x"): RecordedEvent =>
  ({ type: 4, timestamp, data: { href, width: 1000, height: 800 } }) as unknown as RecordedEvent;
const full = (timestamp: number, node: Node): RecordedEvent =>
  ({ type: 2, timestamp, data: { node, initialOffset: { top: 0, left: 0 } } }) as unknown as RecordedEvent;
const mutation = (
  timestamp: number,
  data: { adds?: unknown[]; removes?: unknown[]; texts?: unknown[]; attributes?: unknown[] }
): RecordedEvent =>
  ({
    type: 3,
    timestamp,
    data: { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data }
  }) as unknown as RecordedEvent;
const input = (timestamp: number, id: number, text: string): RecordedEvent =>
  ({ type: 3, timestamp, data: { source: 5, id, text, isChecked: false } }) as unknown as RecordedEvent;
const crumb = (timestamp: number, payload: Record<string, unknown>): RecordedEvent =>
  ({ type: 5, timestamp, data: { tag: "breadcrumb", payload } }) as unknown as RecordedEvent;

function segment(events: RecordedEvent[]): FrozenSegment {
  return {
    events,
    startTimestamp: events[0].timestamp,
    endTimestamp: events[events.length - 1].timestamp,
    size: JSON.stringify(events).length,
    level: "full"
  };
}

function bufferOf(segments: FrozenSegment[], urls: string[] = ["http://localhost/course/1/x"]): FrozenBuffer {
  return {
    replayId: "0".repeat(32),
    level: "full",
    segments,
    startTimestamp: segments[0].startTimestamp,
    endTimestamp: segments[segments.length - 1].endTimestamp,
    urls,
    errorIds: [],
    traceIds: [],
    size: segments.reduce((n, s) => n + s.size, 0)
  };
}

const NAME = "Zorvik Quellmar";
const HANDLE = "vraeltek-42";
const EMAIL = "kvounder@pawtograder.net";
const taint: TaintSnapshot = [
  ...["zorvik quellmar", "zorvik", "quellmar", "quellmar, zorvik"].map((pattern) => ({
    kind: "name" as const,
    pattern
  })),
  { kind: "handle", pattern: HANDLE },
  { kind: "email", pattern: EMAIL },
  { kind: "email", pattern: "kvounder" }
];

async function redact(buffer: FrozenBuffer, opts: Partial<RedactOptions> = {}) {
  return redactBuffer(buffer, { taintPatterns: taint, ...opts });
}

/** Every string in the redacted events, for leak assertions. */
function uploaded(result: { buffer: FrozenBuffer }): string {
  return JSON.stringify(result.buffer);
}

beforeEach(() => {
  nextNodeId = 1;
});

describe("text nodes", () => {
  it("matches a value split across inline nodes and masks each piece", async () => {
    const first = txt("vrael");
    const rest = txt("tek-42 joined");
    const p = el("p", {}, [el("b", {}, [first]), rest]);
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], [p]))])]));
    expect(uploaded(result)).not.toContain("vrael");
    expect(uploaded(result)).not.toContain("tek-42");
    const redactedFirst = (result.buffer.segments[0].events[1].data as { node: Node }).node;
    const texts: string[] = [];
    const walk = (n: Node) => {
      if (n.type === 3) texts.push(n.textContent!);
      n.childNodes?.forEach(walk);
    };
    walk(redactedFirst);
    expect(texts).toEqual(["*****", "****** joined"]);
    expect(result.stats.redactedSpans).toBe(2);
  });

  it("lists adjacent inline elements with a space between them", async () => {
    const p = el("p", {}, [el("a", {}, [txt("Email the student")]), el("a", {}, [txt("Profile link")])]);
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], [p]))])]));
    expect(result.remaining.filter((r) => r.kind === "text")).toEqual([
      { kind: "text", value: "Email the student Profile link", count: 1 }
    ]);
  });

  it("does not join text across block elements", async () => {
    // "vrael" and "tek-42" in two paragraphs are two blocks, so the handle is not assembled.
    const body = [el("p", {}, [txt("x vrael")]), el("p", {}, [txt("tek-42 y")])];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], body))])]));
    expect(result.stats.redactedSpans).toBe(0);
  });

  it("masks whole names, name tokens, and sortable forms, keeping whitespace", async () => {
    const body = [el("div", {}, [txt(`Posted by ${NAME}`)]), el("div", {}, [txt("Quellmar, Zorvik")])];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], body))])]));
    const out = uploaded(result);
    expect(out).toContain("Posted by ****** ********");
    // The comma is inside the "Last, First" span, so it is masked too.
    expect(out).toContain('"********* ******"');
  });

  it("replays mutations forward: text added later is matched with its old siblings", async () => {
    const old = txt("vrael");
    const p = el("p", {}, [old]);
    const later = txt("tek-42");
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [p])),
          mutation(30_000, { adds: [{ parentId: p.id, nextId: null, node: later }] })
        ])
      ])
    );
    const out = uploaded(result);
    expect(out).not.toContain("vrael");
    expect(out).not.toContain("tek-42");
    // The FullSnapshot's node was redacted too, not just the mutation.
    const snap = (result.buffer.segments[0].events[1].data as { node: Node }).node;
    expect(JSON.stringify(snap)).toContain('"*****"');
  });

  it("follows text changes, removals, and nodes added before their next sibling", async () => {
    const t = txt("loading");
    const p = el("p", {}, [t]);
    const span = el("span", {}, []);
    const a = txt("Zor");
    const b = txt("vik!");
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [p])),
          mutation(2, { texts: [{ id: t.id, value: `mail ${EMAIL} now` }] }),
          // `b` is inserted before `a`'s sibling that arrives later in the same list.
          mutation(3, {
            removes: [{ parentId: p.id, id: t.id }],
            adds: [
              { parentId: span.id, nextId: null, node: b },
              { parentId: p.id, nextId: null, node: span },
              { parentId: span.id, nextId: b.id, node: a }
            ]
          })
        ])
      ])
    );
    const out = uploaded(result);
    expect(out).not.toContain("kvounder");
    expect(out).not.toMatch(/Zor|vik!/);
    expect(out).toContain('"***"');
  });

  it("treats <title> text as the title and style text as CSS", async () => {
    const head = [
      el("title", {}, [txt(`${NAME} - Submission`)]),
      el("style", {}, [txt(".zorvik{color:red}", undefined, true)])
    ];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc(head, [el("p", {}, [txt("hello")])]))])]));
    const out = uploaded(result);
    expect(out).toContain("****** ******** - Submission");
    // CSS is matched on word boundaries, and ".zorvik{" is a whole word.
    expect(out).not.toContain(".zorvik");
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        { kind: "title", value: "****** ******** - Submission", count: 1 },
        { kind: "text", value: "hello", count: 1 }
      ])
    );
    expect(result.remaining.some((r) => r.value.includes("color"))).toBe(false);
  });
  it("matches both entries rrweb lists for a node changed twice in one mutation", async () => {
    // rrweb pushes one `texts` entry per change it observed, each with the node's latest text.
    const t = txt("loading");
    const p = el("p", { "data-report-unmask": "" }, [t]);
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [p])),
          mutation(2, {
            texts: [
              { id: t.id, value: NAME },
              { id: t.id, value: NAME }
            ]
          })
        ])
      ])
    );
    expect(uploaded(result)).not.toContain("Zorvik");
  });

  it("keeps a re-sent node's children when it comes after them in the same mutation", async () => {
    // A checkout between a node's insertion and the mutation that reports it: the snapshot has
    // the subtree, and rrweb sends the children first and the parent last, with no removal.
    const name = txt("Zorvik");
    const rest = txt(" Quellmar");
    const b = el("b", {}, [name]);
    const p = el("p", { "data-report-unmask": "" }, [b, rest]);
    const after = el("p", {}, []);
    const body = el("div", {}, [p]);
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [body])),
          mutation(2, {
            adds: [
              { parentId: p.id, nextId: rest.id, node: { ...b, childNodes: [] } },
              { parentId: b.id, nextId: null, node: { ...name } },
              { parentId: p.id, nextId: null, node: { ...rest } },
              { parentId: body.id, nextId: null, node: { ...after } },
              { parentId: body.id, nextId: after.id, node: { ...p, childNodes: [] } }
            ]
          })
        ])
      ])
    );
    expect(uploaded(result)).not.toMatch(/Zorvik|Quellmar/);
  });

  it("never places a re-sent node under its own descendant", async () => {
    // Only a map out of step with the page could ask for this. Between inline elements a cycle
    // would keep the walk up to the block from ever ending.
    const inner = el("b", {}, [txt(NAME)]);
    const outer = el("span", {}, [inner]);
    const p = el("p", { "data-report-unmask": "" }, [outer]);
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [p])),
          mutation(2, { adds: [{ parentId: inner.id, nextId: null, node: { ...outer, childNodes: [] } }] }),
          mutation(3, { texts: [{ id: inner.childNodes![0].id, value: NAME }] })
        ])
      ])
    );
    expect(uploaded(result)).not.toContain("Zorvik");
  });

  it("matches a block again when a node in it is emptied or moved out", async () => {
    // "Bo" and "Li" are under three characters, so only the whole name is a pattern.
    const short: TaintSnapshot = [{ kind: "name", pattern: "bo li" }];
    const sep = txt("-x-");
    const emptied = el("p", {}, [txt("Bo"), el("span", {}, [sep]), txt(" Li")]);
    const span = el("span", {}, [txt("X")]);
    const left = el("p", {}, [txt("Bo "), span, txt("Li")]);
    const other = el("div", {}, []);
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [emptied, left, other])),
          mutation(2, {
            texts: [{ id: sep.id, value: "" }],
            // A move with no `removes` entry for it.
            adds: [{ parentId: other.id, nextId: null, node: { ...span, childNodes: [] } }]
          })
        ])
      ]),
      { taintPatterns: short }
    );
    expect(uploaded(result)).not.toMatch(/"Bo"|" Li"|"Bo "|"Li"/);
  });

  it("joins a name around a button and across SVG text runs", async () => {
    const short: TaintSnapshot = [{ kind: "name", pattern: "bo li" }];
    const p = el("p", {}, [txt("Graded by "), el("button", {}, [txt("Bo")]), txt(" Li")]);
    const svg = el("svg", {}, [el("text", {}, [el("tspan", {}, [txt("Bo")]), el("tspan", {}, [txt("Li")])])]);
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], [p, svg]))])]), { taintPatterns: short });
    expect(uploaded(result)).not.toMatch(/"Bo"|"Li"|" Li"/);
  });
});

describe("attributes, inputs, breadcrumbs, URLs", () => {
  it("redacts text and URL attributes in snapshots and mutations", async () => {
    const link = el("a", { href: `mailto:${EMAIL}?subject=hi`, title: NAME }, [txt("contact")]);
    const img = el("img", { alt: `Photo of ${NAME}` });
    const field = el("input", { placeholder: `e.g. ${HANDLE}`, "aria-label": "Search", value: HANDLE });
    const box = el("div", { "data-testid": `row-${HANDLE}`, class: "banner zorvik-row" });
    const result = await redact(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [link, img, field, box])),
          mutation(2, {
            attributes: [{ id: box.id, attributes: { "aria-label": `Row for ${NAME}`, style: { content: HANDLE } } }]
          })
        ])
      ])
    );
    const out = uploaded(result);
    for (const leak of ["zorvik", "quellmar", "vraeltek", "kvounder"]) expect(out.toLowerCase()).not.toContain(leak);
    expect(out).toContain("banner"); // class names survive except whole-word hits
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        { kind: "attribute", value: "Search", count: 1 },
        { kind: "attribute", value: "e.g. ***********", count: 1 },
        { kind: "text", value: "contact", count: 1 }
      ])
    );
  });

  it("redacts input events", async () => {
    const field = el("input", {});
    const result = await redact(
      bufferOf([segment([meta(0), full(1, doc([], [field])), input(2, field.id, `my name is ${NAME}`)])])
    );
    expect(uploaded(result)).toContain("my name is ****** ********");
    expect(result.remaining).toContainEqual({ kind: "input", value: "my name is ****** ********", count: 1 });
  });

  it("redacts console messages, click descriptions, and fetch URLs, percent-decoded", async () => {
    const result = await redact(
      bufferOf(
        [
          segment([
            meta(0, `http://localhost/course/1/x?who=${encodeURIComponent(NAME)}`),
            full(1, doc([], [el("p", {}, [txt("x")])])),
            crumb(2, {
              category: "console",
              level: "log",
              timestamp: 1,
              message: JSON.stringify({ name: NAME, email: EMAIL })
            }),
            crumb(3, { category: "ui.click", timestamp: 1, message: `button[data-testid="${HANDLE}"]`, data: {} }),
            crumb(4, {
              category: "fetch",
              timestamp: 1,
              data: {
                method: "GET",
                url: `http://127.0.0.1:54321/rest/v1/profiles?name=ilike.%25${encodeURIComponent(NAME)}%25`,
                status_code: 200,
                duration: 3
              }
            })
          ])
        ],
        [`http://localhost/course/1/x?who=${encodeURIComponent(NAME)}`]
      )
    );
    const out = uploaded(result);
    expect(out.toLowerCase()).not.toMatch(/zorvik|quellmar|vraeltek|kvounder/);
    const kinds = new Set(result.remaining.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["text", "console", "breadcrumb", "url"]));
    // The fetch method and breadcrumb category are untouched.
    expect(out).toContain('"method":"GET"');
    expect(out).toContain('"category":"console"');
    const fetchUrl = result.remaining.find((r) => r.value.includes("/rest/v1/profiles"))!;
    expect(fetchUrl.value).toMatch(/name=ilike\.%25\*+%25$/);
  });

  it("maps decoded URL spans back to the encoded bytes", () => {
    const map = decodeUrlWithMap("a%20b+c%C3%A9d");
    expect(map.text).toBe("a b cédd".slice(0, 6) + "d");
    expect(map.starts[1]).toBe(1);
    expect(map.ends[1]).toBe(4);
    expect(map.starts[5]).toBe(7);
    expect(map.ends[5]).toBe(13);
  });

  it("decodes a doubly encoded URL, mapping back to the original bytes", () => {
    const map = decodeUrlWithMap("a%2540b");
    expect(map.text).toBe("a@b");
    expect([map.starts[1], map.ends[1]]).toEqual([1, 6]);
    expect([map.starts[2], map.ends[2]]).toEqual([6, 7]);
    // At most three passes.
    expect(decodeUrlWithMap("%25252540").text).toBe("%40");
    expect(decodeUrlWithMap("plain").text).toBe("plain");
  });

  it("redacts names and emails in a URL nested in a query parameter", async () => {
    const href =
      "http://localhost/course/1/x?next=%2Fsearch%3Fq%3DZorvik%2520Quellmar%26e%3Dkvounder%2540pawtograder.net";
    const result = await redact(bufferOf([segment([meta(0, href), full(1, doc([], []))])], [href]));
    const out = uploaded(result);
    expect(out).not.toMatch(/Zorvik|Quellmar|kvounder|pawtograder\.net/);
    expect(out).toContain("http://localhost/course/1/x?next=");
    getTaintSet().add("name", NAME);
    expect(redactReportUrl(href, getTaintSet())).not.toMatch(/Zorvik|Quellmar|kvounder/);
    getTaintSet().clear();
  });
  it("masks the values typed on the way to a name", async () => {
    const field = el("input", {});
    const events: RecordedEvent[] = [meta(0), full(1, doc([], [field]))];
    for (let i = 1; i <= NAME.length; i++) events.push(input(1 + i, field.id, NAME.slice(0, i)));
    events.push(input(100, field.id, "Hi"));
    const result = await redact(bufferOf([segment(events)]));
    const values = result.buffer.segments[0].events.slice(2).map((e) => (e.data as { text: string }).text);
    expect(values.slice(0, NAME.length).every((v) => /^[\s*]+$/.test(v))).toBe(true);
    expect(values[NAME.length]).toBe("Hi");
  });

  it("matches every decoding pass of a URL, so a %2B or %25 the last pass changes is still read", async () => {
    // URLSearchParams writes "+" as %2B and "%" as %25. A second pass reads the first's "+" as a
    // space, and the "%00" in "%001234567%" as an escape.
    const plus = "http://localhost/course/1/x?email=eq.jdoe%2Bcs101%40northeastern.edu";
    const nuid = new URL("http://127.0.0.1:54321/rest/v1/user_roles");
    nuid.searchParams.append("sis_user_id", "ilike.%001234567%");
    const result = await redact(
      bufferOf(
        [
          segment([
            meta(0, plus),
            full(1, doc([], [])),
            crumb(2, {
              category: "fetch",
              timestamp: 1,
              data: { method: "GET", url: nuid.href, status_code: 200, duration: 3 }
            })
          ])
        ],
        [plus]
      ),
      { taintPatterns: [] }
    );
    expect(uploaded(result)).not.toMatch(/jdoe|1234567/);
    expect(redactReportUrl(plus, createTaintSet())).not.toContain("jdoe");
  });

  it("matches taint lines holding URL delimiters, and percent-escapes outside URL fields", async () => {
    const set = createTaintSet();
    set.add("free_text", "Why does test 3 fail?");
    const href = `http://localhost/course/1/search?q=${encodeURIComponent("Why does test 3 fail?")}&x=1`;
    const logged = "request failed http://127.0.0.1:54321/rest/v1/profiles?email=eq.quinlan.ostrander%40example.org";
    const result = await redactBuffer(
      bufferOf(
        [
          segment([
            meta(0, href),
            full(1, doc([], [el("p", {}, [txt("x")])])),
            crumb(2, { category: "console", level: "error", timestamp: 1, message: logged })
          ])
        ],
        [href]
      ),
      { taintPatterns: taintSnapshot(set) }
    );
    expect(uploaded(result)).not.toMatch(/Why|fail%3F|quinlan/);
    expect(redactReportUrl(href, set)).not.toMatch(/Why|fail/);
  });

  it("masks a mailto: href whole, subject and display name included", async () => {
    const links = [
      el("a", { href: "mailto:ta@example.test?subject=Regrade%20for%20Plimsoll%20Varn" }, [txt("****")]),
      el("a", { href: "mailto:Plimsoll Varn <pv@example.test>" }, [txt("****")])
    ];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], [el("p", {}, links)]))])]), {
      taintPatterns: []
    });
    expect(uploaded(result)).not.toMatch(/Plimsoll|Varn|Regrade/);
  });
});

describe("options", () => {
  function threeSegments(): FrozenBuffer {
    return bufferOf(
      [0, 60_000, 120_000].map((t, i) =>
        segment([
          meta(t, `http://localhost/course/1/page${i}`),
          full(t + 1, doc([], [el("p", {}, [txt(`segment ${i}`)])])),
          mutation(t + 50_000, { texts: [] })
        ])
      ),
      ["http://localhost/course/1/page0", "http://localhost/course/1/page1", "http://localhost/course/1/page2"]
    );
  }

  it("keepLastMs drops whole segments from the front and still starts with a checkout", async () => {
    const buffer = threeSegments();
    const result = await redact(buffer, { keepLastMs: 110_000 });
    expect(result.buffer.segments).toHaveLength(2);
    const events = result.buffer.segments.flatMap((s) => s.events);
    expect(events[0].type).toBe(4);
    expect(events[1].type).toBe(2);
    expect(result.buffer.startTimestamp).toBe(60_000);
    expect(result.buffer.endTimestamp - result.buffer.startTimestamp).toBeLessThanOrEqual(110_000);
    expect(result.buffer.urls).toEqual(["http://localhost/course/1/page1", "http://localhost/course/1/page2"]);
    expect(result.remaining.map((r) => r.value)).not.toContain("segment 0");
    // A window shorter than the newest segment keeps just that one.
    expect(keepLast(buffer, 1).segments).toHaveLength(1);
    expect(keepLast(buffer, undefined)).toBe(buffer);
  });

  it("keepLastMs lists only the URLs of the kept window when visits carry times", async () => {
    const [a, b, c] = ["a", "gradebook?student=Quinlan%20Ostrander", "c"].map((p) => `http://localhost/course/1/${p}`);
    const buffer: FrozenBuffer = {
      ...bufferOf(
        [0, 60_000, 120_000].map((t, i) =>
          segment([meta(t, [a, a, c][i]), full(t + 1, doc([], [])), mutation(t + 50_000, {})])
        ),
        [b, a, c]
      ),
      // B early, A from 10 s, C from 120 s. A window starting at 60 s never showed B.
      visits: [
        { url: b, at: 0 },
        { url: a, at: 10_000 },
        { url: c, at: 120_000 }
      ]
    };
    const result = await redact(buffer, { keepLastMs: 110_000 });
    expect(result.buffer.urls).toEqual([a, c]);
    // A URL revisited inside the window stays even though its first visit was before it.
    const revisit = keepLast({ ...buffer, visits: [...buffer.visits!, { url: b, at: 130_000 }] }, 110_000);
    expect(revisit.urls).toEqual([a, c, b]);
    // The visit list never leaves the pass: it holds the URLs unredacted.
    expect(result.buffer.visits).toBeUndefined();
    expect((await redact(buffer, {})).buffer.visits).toBeUndefined();
  });

  it("extraRedactions masks every exact occurrence, and * matches an already-masked character", async () => {
    const body = [
      el("p", {}, [txt("Lab 3 is due Friday")]),
      el("p", {}, [txt(`Ask ${NAME} about Lab 3`)]),
      el("p", {}, [txt("lab 3 lower case stays")])
    ];
    const buffer = bufferOf([segment([meta(0), full(1, doc([], body))])]);
    const first = await redact(buffer);
    const askLine = first.remaining.find((r) => r.value.startsWith("Ask"))!.value;
    expect(askLine).toBe("Ask ****** ******** about Lab 3");
    const second = await redact(buffer, { extraRedactions: ["Lab 3", askLine] });
    const values = second.remaining.map((r) => r.value);
    expect(values).toContain("*** * is due Friday");
    expect(values).toContain("lab 3 lower case stays");
    expect(values.some((v) => v.startsWith("Ask"))).toBe(false);
  });

  it("ignores click-to-redact strings made only of mask characters", () => {
    expect(extraRedactionDetector(["***", " * "])("anything at all")).toEqual([]);
  });

  it("groups remaining strings by kind with counts, never listing mask-only strings", async () => {
    const body = [
      el("p", {}, [txt("Submit")]),
      el("p", {}, [txt("Submit")]),
      el("p", {}, [txt("*****  ***")]),
      el("button", { title: "Submit" }, [])
    ];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], body))])]));
    expect(result.remaining.filter((r) => r.value === "Submit")).toEqual([
      { kind: "text", value: "Submit", count: 2 },
      { kind: "attribute", value: "Submit", count: 1 }
    ]);
    expect(result.remaining.some((r) => /^[\s*]*$/.test(r.value))).toBe(false);
    expect(result.stats.textNodes).toBe(3);
  });

  it("never modifies the input buffer", async () => {
    const buffer = bufferOf([segment([meta(0), full(1, doc([], [el("p", {}, [txt(NAME)])]))])]);
    const before = JSON.stringify(buffer);
    const result = await redact(buffer);
    expect(JSON.stringify(buffer)).toBe(before);
    expect(uploaded(result)).not.toContain("Zorvik");
  });
  it("click-to-redact masks a picked string inside class names and CSS too", async () => {
    const body = [
      el("p", { "data-report-unmask": "" }, [txt("Reviewer Kestrel7")]),
      el("div", { class: "card reviewer-Kestrel7x", style: "--who:Kestrel7a" }, [])
    ];
    const result = await redact(bufferOf([segment([meta(0), full(1, doc([], body))])]), {
      extraRedactions: ["Kestrel7"]
    });
    expect(uploaded(result)).not.toContain("Kestrel7");
  });

  it("click-to-redact finds a URL whose earlier mask covered a space", async () => {
    const link = el("a", { href: `/course/1/search?q=${NAME}&student=jdoe` }, [txt("****")]);
    const buffer = bufferOf([segment([meta(0), full(1, doc([], [el("p", {}, [link])]))])]);
    const first = await redact(buffer);
    const pick = first.remaining.find((r) => r.kind === "url" && r.value.startsWith("/course"))!.value;
    expect(pick).toBe("/course/1/search?q=****** ********&student=jdoe");
    const second = await redact(buffer, { extraRedactions: [pick] });
    expect(uploaded(second)).not.toContain("jdoe");
  });
});

describe("taint snapshot and detectors", () => {
  afterEach(() => getTaintSet().clear());

  it("expands the taint set into match patterns", () => {
    const set = getTaintSet();
    set.add("name", NAME);
    set.add("email", EMAIL);
    set.add("handle", HANDLE);
    const snapshot = taintSnapshot(set);
    expect(snapshot).toEqual(
      expect.arrayContaining([
        { kind: "name", pattern: "zorvik quellmar" },
        { kind: "name", pattern: "quellmar, zorvik" },
        { kind: "name", pattern: "zorvik" },
        { kind: "email", pattern: EMAIL },
        { kind: "email", pattern: "kvounder" },
        { kind: "handle", pattern: HANDLE }
      ])
    );
    expect(new Set(snapshot.map((s) => s.pattern)).size).toBe(snapshot.length);
  });

  it("redacts the feedback page URL, raw and percent-decoded", () => {
    const set = getTaintSet();
    set.add("name", NAME);
    const url = `http://localhost/course/1/x?who=${encodeURIComponent(NAME)}&mail=${EMAIL}`;
    const out = redactReportUrl(url, set);
    expect(out).toBe(`http://localhost/course/1/x?who=${"*".repeat(17)}&mail=${"*".repeat(EMAIL.length)}`);
    expect(redactReportUrl("http://localhost/course/1/x", set)).toBe("http://localhost/course/1/x");
  });

  it("redacts all of a free-text line longer than the pattern cap, in text and console output", async () => {
    const set = getTaintSet();
    const line = "Secretpost " + "alpha beta gamma delta ".repeat(30) + "TAILCANARY end";
    expect(line.length).toBe(715);
    set.add("free_text", line);
    const result = await redactBuffer(
      bufferOf([
        segment([
          meta(0),
          full(1, doc([], [el("div", { "data-report-unmask": "" }, [txt(line)])])),
          crumb(2, { category: "console", level: "log", timestamp: 1, message: line })
        ])
      ]),
      { taintPatterns: taintSnapshot(set) }
    );
    const out = uploaded(result);
    expect(out).not.toContain("TAILCANARY");
    expect(out).not.toContain("Secretpost");
    expect(out).not.toMatch(/alpha|gamma/);
  });

  it("matches taint case- and whitespace-insensitively", () => {
    const detect = taintDetector(taint);
    expect(detect("by ZORVIK   quellmar.")).toEqual(expect.arrayContaining([{ start: 3, end: 20, kind: "name" }]));
  });

  it.each([
    ["NFC", "NFD"],
    ["NFD", "NFC"]
  ] as const)("redacts a name tainted in %s and rendered in %s, marks included", async (tainted, rendered) => {
    const set = getTaintSet();
    set.add("name", "Zoë Ångström".normalize(tainted));
    const shown = "Zoë Ångström".normalize(rendered);
    const result = await redactBuffer(
      bufferOf([
        segment([meta(0), full(1, doc([], [el("div", { "data-report-unmask": "", title: shown }, [txt(shown)])]))])
      ]),
      { taintPatterns: taintSnapshot(set) }
    );
    const out = uploaded(result).normalize("NFC");
    expect(out).not.toMatch(/Zo|ngstr/);
    // No combining mark is left over the masked letters.
    expect(uploaded(result)).not.toMatch(/\p{M}/u);
  });
  it("redacts the feedback page URL as the walker redacts the replay's URLs", async () => {
    const set = getTaintSet();
    set.add("name", NAME);
    set.add("name", "Zoë Ångström");
    set.add("email", EMAIL);
    const urls = [
      `http://localhost/course/1/x?q=${encodeURIComponent(NAME)}&h=${HANDLE.toUpperCase()}`,
      "http://localhost/course/1/x?who=Zo%C3%AB+%C3%85ngstr%C3%B6m",
      `http://localhost/course/1/x?next=${encodeURIComponent(`/y?e=${EMAIL}`)}`,
      "http://localhost/course/1/x?n=123456789"
    ];
    const { buffer } = await redactBuffer(bufferOf([segment([meta(0), full(1, doc([], []))])], urls), {
      taintPatterns: taintSnapshot(set)
    });
    expect(urls.map((u) => redactReportUrl(u, set))).toEqual(buffer.urls);
  });
});
