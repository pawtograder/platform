/**
 * Route policy: matching, the E2E-only override, and the listing rules (test A5).
 *
 * The listing rules are static checks on each listed page's source:
 *   - the page exists, and sits under /course/[course_id] (the flag is a course flag);
 *   - class-wide pages (manage/, grade/) are `structure` at most;
 *   - a server component that reads data on the server needs `ssrTaint: true`, unless it is
 *     in CONTROLLER_HYDRATING_SERVER_PAGES because everything it fetches goes into a
 *     TableController (whose initialData package 2 ingests);
 *   - an `ssrTaint: true` page renders `<ReportTaint>`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROUTE_POLICY,
  courseIdFromPathname,
  recordingLevelFor,
  routePolicyEntryFor,
  type RoutePolicyEntry
} from "@/lib/bugReport/routePolicy";
import { ReportTaint, serializeTaintPayload } from "@/components/bugReport/ReportTaint";
import { renderToStaticMarkup } from "react-dom/server";

const APP_DIR = path.join(__dirname, "..", "..", "..", "app");

/**
 * Server pages that fetch on the server but hand every row to a TableController. Each entry
 * needs the reason, so a reviewer can check it.
 */
const CONTROLLER_HYDRATING_SERVER_PAGES: Record<string, string> = {};

const SERVER_DATA_ACCESS = [
  /from\s+["']@\/utils\/supabase\/server["']/,
  /from\s+["']@\/lib\/ssrUtils["']/,
  /\bcreateAdminClient\b/,
  /\bawait\s+fetch\(/
];

function isClientComponent(source: string): boolean {
  const withoutComments = source.replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^\s*["']use client["']/.test(withoutComments);
}

export function routePolicyViolations(
  entries: readonly RoutePolicyEntry[],
  appDir: string,
  controllerHydrating: Record<string, string> = CONTROLLER_HYDRATING_SERVER_PAGES
): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    const segments = entry.pattern.split("/").filter(Boolean);
    const pageFile = path.join(appDir, ...segments, "page.tsx");
    if (!entry.pattern.startsWith("/course/[course_id]/") && entry.pattern !== "/course/[course_id]") {
      violations.push(`${entry.pattern}: must be under /course/[course_id]; the recording flag is a course flag`);
    }
    if ((segments.includes("manage") || segments.includes("grade")) && entry.level !== "structure") {
      violations.push(`${entry.pattern}: class-wide pages are "structure" at most`);
    }
    if (!fs.existsSync(pageFile)) {
      violations.push(`${entry.pattern}: no page at ${path.relative(appDir, pageFile)}`);
      continue;
    }
    const source = fs.readFileSync(pageFile, "utf8");
    const serverFetching = !isClientComponent(source) && SERVER_DATA_ACCESS.some((re) => re.test(source));
    if (serverFetching && !entry.ssrTaint && !controllerHydrating[entry.pattern]) {
      violations.push(
        `${entry.pattern}: server component without a TableController; list it with ssrTaint: true and render <ReportTaint>`
      );
    }
    if (entry.ssrTaint && !/<ReportTaint\b/.test(source)) {
      violations.push(`${entry.pattern}: ssrTaint: true but the page doesn't render <ReportTaint>`);
    }
  }
  return violations;
}

describe("routePolicy matching", () => {
  const policy = (entries: RoutePolicyEntry[]) =>
    window.localStorage.setItem("bugReport.testRoutePolicy", JSON.stringify(entries));

  afterEach(() => {
    window.localStorage.clear();
    delete process.env.BUG_REPORT_E2E;
  });

  it("returns null for unlisted routes", () => {
    expect(recordingLevelFor("/course/1/manage/course/lti")).toBeNull();
    expect(recordingLevelFor("/")).toBeNull();
    expect(recordingLevelFor("/course/1/assignments")).toBeNull();
  });

  it("matches [param] to exactly one segment", () => {
    expect(recordingLevelFor("/course/12/assignments/34")).toBe("full");
    expect(recordingLevelFor("/course/12/assignments/34/")).toBe("full");
    expect(recordingLevelFor("/course/12/assignments/34?tab=x#y")).toBe("full");
    expect(recordingLevelFor("/course/12/assignments/34/submissions/5")).toBeNull();
    expect(recordingLevelFor("/course/12/discussion/9")).toBe("structure");
  });

  it("honors the test policy only when the build enables it", () => {
    policy([{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
    expect(recordingLevelFor("/course/1/manage/gradebook")).toBeNull();
    process.env.BUG_REPORT_E2E = "true";
    expect(recordingLevelFor("/course/1/manage/gradebook")).toBe("structure");
    // Production entries still apply alongside the test ones.
    expect(recordingLevelFor("/course/1/gradebook")).toBe("full");
  });

  it("lets a test entry replace a production entry with the same pattern", () => {
    process.env.BUG_REPORT_E2E = "true";
    policy([{ pattern: "/course/[course_id]/gradebook", level: "structure" }]);
    expect(recordingLevelFor("/course/1/gradebook")).toBe("structure");
  });

  it("ignores malformed test policies", () => {
    process.env.BUG_REPORT_E2E = "true";
    window.localStorage.setItem("bugReport.testRoutePolicy", "{not json");
    expect(recordingLevelFor("/course/1/manage/gradebook")).toBeNull();
    policy([{ pattern: "/course/[course_id]/manage/gradebook", level: "everything" } as unknown as RoutePolicyEntry]);
    expect(recordingLevelFor("/course/1/manage/gradebook")).toBeNull();
  });

  it("matches [...param] to the rest of the path, and the most specific pattern wins", () => {
    process.env.BUG_REPORT_E2E = "true";
    policy([
      { pattern: "/course/[course_id]/files/[...path]", level: "structure" },
      { pattern: "/course/[course_id]/files/[kind]/readme", level: "full" },
      { pattern: "/course/[course_id]/files/[kind]", level: "full" },
      { pattern: "/course/[course_id]/files/static/[...path]", level: "full" }
    ]);
    expect(routePolicyEntryFor("/course/1/files")).toBeNull();
    expect(routePolicyEntryFor("/course/1/files/a")?.pattern).toBe("/course/[course_id]/files/[kind]");
    expect(routePolicyEntryFor("/course/1/files/a/b/c")?.pattern).toBe("/course/[course_id]/files/[...path]");
    expect(routePolicyEntryFor("/course/1/files/a/readme")?.pattern).toBe("/course/[course_id]/files/[kind]/readme");
    expect(routePolicyEntryFor("/course/1/files/static/x")?.pattern).toBe("/course/[course_id]/files/static/[...path]");
  });

  it("parses the course id", () => {
    expect(courseIdFromPathname("/course/42/gradebook")).toBe(42);
    expect(courseIdFromPathname("/course/42")).toBe(42);
    expect(courseIdFromPathname("/course/canvas-classes")).toBeNull();
    expect(courseIdFromPathname("/admin")).toBeNull();
  });
});

describe("routePolicy listing rules (A5)", () => {
  it("the production policy has no violations", () => {
    expect(routePolicyViolations(ROUTE_POLICY, APP_DIR)).toEqual([]);
  });

  describe("on a synthetic app directory", () => {
    let appDir: string;
    const writePage = (route: string, source: string) => {
      const dir = path.join(appDir, ...route.split("/").filter(Boolean));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "page.tsx"), source);
    };

    beforeAll(() => {
      appDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-policy-"));
      writePage(
        "/course/[course_id]/roster-ssr",
        `import { createClient } from "@/utils/supabase/server";\nexport default async function Page() { const s = await createClient(); return <div />; }\n`
      );
      writePage(
        "/course/[course_id]/roster-ssr-tainted",
        `import { createClient } from "@/utils/supabase/server";\nimport { ReportTaint } from "@/components/bugReport/ReportTaint";\nexport default async function Page() { return <><ReportTaint values={{}} features={[]} pattern="x" /></>; }\n`
      );
      writePage(
        "/course/[course_id]/client-page",
        `"use client";\nimport { createClient } from "@/utils/supabase/client";\nexport default function Page() { return <div />; }\n`
      );
      writePage("/course/[course_id]/static-server", `export default function Page() { return <div />; }\n`);
    });

    afterAll(() => {
      fs.rmSync(appDir, { recursive: true, force: true });
    });

    it("fails for a controller-less server page listed without ssrTaint", () => {
      const v = routePolicyViolations([{ pattern: "/course/[course_id]/roster-ssr", level: "structure" }], appDir);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatch(/ssrTaint: true/);
    });

    it("fails for an ssrTaint page that doesn't render the taint block", () => {
      const v = routePolicyViolations(
        [{ pattern: "/course/[course_id]/roster-ssr", level: "structure", ssrTaint: true }],
        appDir
      );
      expect(v).toEqual([expect.stringMatching(/doesn't render <ReportTaint>/)]);
    });

    it("passes an ssrTaint page that renders the taint block", () => {
      expect(
        routePolicyViolations(
          [{ pattern: "/course/[course_id]/roster-ssr-tainted", level: "structure", ssrTaint: true }],
          appDir
        )
      ).toEqual([]);
    });

    it("passes client pages and server pages that fetch nothing", () => {
      expect(
        routePolicyViolations(
          [
            { pattern: "/course/[course_id]/client-page", level: "full" },
            { pattern: "/course/[course_id]/static-server", level: "full" }
          ],
          appDir
        )
      ).toEqual([]);
    });

    it("passes a server page on the controller-hydrating allowlist", () => {
      expect(
        routePolicyViolations([{ pattern: "/course/[course_id]/roster-ssr", level: "structure" }], appDir, {
          "/course/[course_id]/roster-ssr": "rows go to TableController initialData"
        })
      ).toEqual([]);
    });

    it("fails for missing pages, non-course routes, and full-level class-wide pages", () => {
      const v = routePolicyViolations(
        [
          { pattern: "/course/[course_id]/nope", level: "full" },
          { pattern: "/admin/client-page", level: "full" },
          { pattern: "/course/[course_id]/manage/client-page", level: "full" }
        ],
        appDir
      );
      expect(v).toEqual([
        expect.stringMatching(/nope: no page/),
        expect.stringMatching(/admin\/client-page: must be under/),
        expect.stringMatching(/admin\/client-page: no page/),
        expect.stringMatching(/manage\/client-page: class-wide pages/),
        expect.stringMatching(/manage\/client-page: no page/)
      ]);
    });
  });
});

describe("ReportTaint", () => {
  const features = [{ name: "bug-report-recording", enabled: true }];

  it("renders nothing unless the flag is on and the pattern is listed with ssrTaint", () => {
    expect(
      renderToStaticMarkup(
        ReportTaint({ values: { name: ["A B"] }, features: [], pattern: "/course/[course_id]/gradebook" }) ?? <></>
      )
    ).toBe("");
    expect(
      renderToStaticMarkup(
        ReportTaint({ values: { name: ["A B"] }, features, pattern: "/course/[course_id]/gradebook" }) ?? <></>
      )
    ).toBe("");
  });

  it("renders the section 4.3 script tag for an ssrTaint route with the flag on", () => {
    jest.isolateModules(() => {
      jest.doMock("@/lib/bugReport/routePolicy", () => ({
        ROUTE_POLICY: [{ pattern: "/course/[course_id]/ssr", level: "structure", ssrTaint: true }]
      }));
      const { ReportTaint: Isolated } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@/components/bugReport/ReportTaint") as typeof import("@/components/bugReport/ReportTaint");
      const html = renderToStaticMarkup(
        Isolated({
          values: { name: ["Ada Lovelace", "Ada Lovelace", null], handle: ["ada"] },
          features,
          pattern: "/course/[course_id]/ssr"
        }) ?? <></>
      );
      expect(html).toBe(
        '<script type="application/json" id="report-taint">{"v":1,"values":{"name":["Ada Lovelace"],"handle":["ada"]}}</script>'
      );
    });
  });

  it("emits HTML-safe JSON", () => {
    const html = serializeTaintPayload({ v: 1, values: { name: ["</script><b>x</b>"], email: ["a@b.c"] } });
    expect(html).not.toContain("<");
    expect(JSON.parse(html)).toEqual({ v: 1, values: { name: ["</script><b>x</b>"], email: ["a@b.c"] } });
  });
});
