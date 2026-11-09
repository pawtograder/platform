/**
 * Package 2a checks over the taint trace output (I2 and I3 at the unit level; the E2E versions are
 * in tests/e2e/bugReport/taint-trace-checks.spec.ts), and the committed generated files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CURRENT_CLASSIFICATION,
  blockCandidates,
  checkObserved,
  checkSinks,
  classificationOf,
  isBlocking,
  normalizeObserved,
  normalizeSinks,
  sinkComponentKey,
  type ObservedFlow,
  type PiiSinks
} from "@/lib/bugReport/traceCheck";

const generated = (f: string) => path.join(__dirname, "..", "..", "..", "lib", "bugReport", "generated", f);
const observedText = readFileSync(generated("privacy.observed.json"), "utf8");
const sinksText = readFileSync(generated("pii-sinks.json"), "utf8");

const flow = (over: Partial<ObservedFlow>): ObservedFlow => ({
  source: "rest:profiles",
  key: "profiles.name",
  kind: "name",
  firstSeenIn: "/course/[course_id]",
  test: "spec › test",
  ...over
});

describe("committed taint trace output", () => {
  it("has a classification for every observed flow", () => {
    const failures = checkObserved(JSON.parse(observedText)).filter(isBlocking);
    expect(failures.map((f) => f.message)).toEqual([]);
  });

  it("has no PII inside data-report-unmask", () => {
    expect(checkSinks(JSON.parse(sinksText)).map((f) => f.message)).toEqual([]);
  });

  it("is in normalized order, so reruns diff cleanly", () => {
    const observed = JSON.parse(observedText);
    const sinks = JSON.parse(sinksText);
    expect(JSON.stringify(normalizeObserved(observed))).toBe(JSON.stringify(observed));
    expect(JSON.stringify(normalizeSinks(sinks))).toBe(JSON.stringify(sinks));
  });
});

describe("classificationOf", () => {
  it("resolves row keys through COLUMNS whatever the source", () => {
    expect(classificationOf("rest:user_roles", "profiles.name")).toBe("name");
    expect(classificationOf("realtime:help_requests", "help_requests.request")).toBe("free_text");
    expect(classificationOf("rsc:/course/[course_id]", "users.email")).toBe("email");
  });

  it("resolves RPC JSONPaths, most specific path first", () => {
    expect(classificationOf("rpc:get_student_summary", "$.help_requests[*].request")).toBe("free_text");
    expect(classificationOf("rpc:no_such_function", "$.x")).toBeUndefined();
  });

  it("treats unresolved keys as unclassified", () => {
    expect(classificationOf("rsc:/course/[course_id]", "?label")).toBeUndefined();
    expect(classificationOf("api:/api/thing", "$.name")).toBeUndefined();
  });
});

describe("I2: an unclassified column fails, naming the column and page", () => {
  it("fails a column the classification lacks", () => {
    const COLUMNS = { ...CURRENT_CLASSIFICATION.COLUMNS };
    delete COLUMNS["help_requests.request"];
    const failures = checkObserved(
      [
        flow({
          source: "rest:help_requests",
          key: "help_requests.request",
          kind: "free_text",
          firstSeenIn: "/course/[course_id]/office-hours"
        })
      ],
      { ...CURRENT_CLASSIFICATION, COLUMNS }
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("unclassified");
    expect(failures[0].message).toContain("help_requests.request");
    expect(failures[0].message).toContain("/course/[course_id]/office-hours");
  });

  it("fails a column classified none that carried PII", () => {
    const failures = checkObserved([flow({ key: "profiles.id" })]);
    expect(failures.map((f) => f.kind)).toEqual(["classified-none"]);
  });

  it("reports server-rendered text as a warning, not a failure", () => {
    const failures = checkObserved([flow({ source: "rsc:/course/[course_id]", key: "?rendered:children" })]);
    expect(failures.map((f) => f.kind)).toEqual(["server-rendered"]);
    expect(failures.filter(isBlocking)).toEqual([]);
  });

  it("warns on an unclassified RSC flow whose route is not in ROUTE_POLICY", () => {
    const failures = checkObserved([
      flow({ source: "rsc:/course/[course_id]", key: "?avatar_url", kind: "email", firstSeenIn: "/course" })
    ]);
    expect(failures.map((f) => f.kind)).toEqual(["unlisted-rsc"]);
    expect(failures.filter(isBlocking)).toEqual([]);
    expect(failures[0].message).toContain("?avatar_url");
    expect(failures[0].message).toContain("not in ROUTE_POLICY");
  });

  it("fails an unclassified RSC flow on a listed route", () => {
    const listed = flow({ source: "rsc:/course/[course_id]/gradebook", key: "?name", kind: "email" });
    expect(checkObserved([listed]).map((f) => f.kind)).toEqual(["unclassified"]);
    const failures = checkObserved(
      [flow({ source: "rsc:/course/[course_id]", key: "?name" })],
      CURRENT_CLASSIFICATION,
      new Set(["/course/[course_id]"])
    );
    expect(failures.filter(isBlocking).map((f) => f.kind)).toEqual(["unclassified"]);
  });
});

describe("I3: PII inside data-report-unmask fails, naming the component", () => {
  it("names the component that carries the attribute", () => {
    const sinks: PiiSinks = {
      "/course/[course_id]": { [sinkComponentKey("PersonName", "StudentCard")]: ["name"], PersonName: ["name"] }
    };
    const failures = checkSinks(sinks);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("StudentCard carries data-report-unmask");
    expect(failures[0].message).toContain("PersonName");
    expect(failures[0].message).toContain("/course/[course_id]");
  });
});

describe("normalization", () => {
  it("keeps one flow per (source, key, kind) with the lowest page and test", () => {
    const out = normalizeObserved([
      flow({ firstSeenIn: "/b", test: "t2" }),
      flow({ firstSeenIn: "/a", test: "t9" }),
      flow({ firstSeenIn: "/a", test: "t1" })
    ]);
    expect(out).toEqual([flow({ firstSeenIn: "/a", test: "t1" })]);
  });

  it("lists components rendering free text and grades for <ReportBlock>", () => {
    expect(blockCandidates({ "/x": { A: ["name"], B: ["grade", "name"] }, "/y": { B: ["free_text"] } })).toEqual([
      { component: "B", kinds: ["free_text", "grade"], routes: ["/x", "/y"] }
    ]);
  });
});
