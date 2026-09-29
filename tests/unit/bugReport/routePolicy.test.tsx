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
  resolveAppRoute,
  routePolicyEntryFor,
  type RoutePolicyEntry
} from "@/lib/bugReport/routePolicy";
import appRoutesFile from "@/lib/bugReport/generated/appRoutes.json";
import { APP_ROUTES_HINT, collectAppRoutes } from "@/scripts/bugReport/generateAppRoutes";
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

  it("resolves [...param] and [[...param]] to the rest of the path, and the most specific route wins", () => {
    const routes = [
      "/course/[course_id]/files/[...path]",
      "/course/[course_id]/files/[kind]/readme",
      "/course/[course_id]/files/[kind]",
      "/course/[course_id]/files/static/[...path]",
      "/docs/[[...slug]]"
    ];
    expect(resolveAppRoute("/course/1/files", routes)).toBeNull();
    expect(resolveAppRoute("/course/1/files/a", routes)).toBe("/course/[course_id]/files/[kind]");
    expect(resolveAppRoute("/course/1/files/a/b/c", routes)).toBe("/course/[course_id]/files/[...path]");
    expect(resolveAppRoute("/course/1/files/a/readme", routes)).toBe("/course/[course_id]/files/[kind]/readme");
    expect(resolveAppRoute("/course/1/files/static/x", routes)).toBe("/course/[course_id]/files/static/[...path]");
    expect(resolveAppRoute("/docs", routes)).toBe("/docs/[[...slug]]");
    expect(resolveAppRoute("/docs/a/b", routes)).toBe("/docs/[[...slug]]");
  });

  it("never records an unlisted static sibling of a listed [param] route", () => {
    // Listed: discussion/[root_id] and office-hours/[queue_id]. These are other pages.
    expect(resolveAppRoute("/course/1/discussion/new")).toBe("/course/[course_id]/discussion/new");
    expect(recordingLevelFor("/course/1/discussion/new")).toBeNull();
    expect(recordingLevelFor("/course/1/discussion/%6Eew")).toBeNull();
    expect(recordingLevelFor("/course/1/office-hours/search")).toBeNull();
    // No page at office-hours/request, so Next renders the [queue_id] page for it, as here.
    expect(resolveAppRoute("/course/1/office-hours/request")).toBe("/course/[course_id]/office-hours/[queue_id]");
    expect(recordingLevelFor("/course/1/discussion/9")).toBe("structure");
  });

  it("applies the same resolution to the test policy", () => {
    process.env.BUG_REPORT_E2E = "true";
    policy([{ pattern: "/course/[course_id]/manage/office-hours/request/[request_id]", level: "structure" }]);
    expect(recordingLevelFor("/course/1/manage/office-hours/request/5")).toBe("structure");
    expect(routePolicyEntryFor("/course/1/manage/office-hours/request/5")?.pattern).toBe(
      "/course/[course_id]/manage/office-hours/request/[request_id]"
    );
    // A test entry for a pattern that isn't a real page matches nothing.
    policy([{ pattern: "/course/[course_id]/[anything]", level: "structure" }]);
    expect(recordingLevelFor("/course/1/manage")).toBeNull();
  });

  it("parses the course id", () => {
    expect(courseIdFromPathname("/course/42/gradebook")).toBe(42);
    expect(courseIdFromPathname("/course/42")).toBe(42);
    expect(courseIdFromPathname("/course/canvas-classes")).toBeNull();
    expect(courseIdFromPathname("/admin")).toBeNull();
  });
});

describe("generated/appRoutes.json", () => {
  it(`lists every page under app/ (${APP_ROUTES_HINT})`, () => {
    expect(appRoutesFile).toEqual(collectAppRoutes());
  });

  it("every ROUTE_POLICY pattern is a real page", () => {
    expect(ROUTE_POLICY.map((e) => e.pattern).filter((p) => !appRoutesFile.includes(p))).toEqual([]);
  });

  it("walks every real page: each resolves to itself, and only the listed ones record", () => {
    const listed = new Map(ROUTE_POLICY.map((e) => [e.pattern, e.level]));
    const concrete = (pattern: string) =>
      pattern
        .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, "/x7/y7")
        .replace(/\[\.\.\.[^\]]+\]/g, "x7/y7")
        .replace(/\[[^\]]+\]/g, "7") || "/";
    const recorded: string[] = [];
    for (const pattern of appRoutesFile) {
      const pathname = concrete(pattern);
      expect([pathname, resolveAppRoute(pathname)]).toEqual([pathname, pattern]);
      const level = recordingLevelFor(pathname);
      expect([pattern, level]).toEqual([pattern, listed.get(pattern) ?? null]);
      if (level) recorded.push(pattern);
    }
    expect(recorded.sort()).toEqual([...listed.keys()].sort());
  });

  it("collects pages, leaving out route groups, slots, private folders, and intercepts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-routes-"));
    const page = (route: string, file = "page.tsx") => {
      fs.mkdirSync(path.join(dir, route), { recursive: true });
      fs.writeFileSync(path.join(dir, route, file), "export default function P() { return null; }\n");
    };
    try {
      page("");
      page("(auth-pages)/sign-in");
      page("course/[course_id]/discussion/new", "page.ts");
      page("course/[course_id]/@modal/settings");
      page("course/[course_id]/_components/fake");
      page("course/[course_id]/(.)photo/[id]");
      page("docs/[[...slug]]");
      page("api/thing", "route.ts");
      expect(collectAppRoutes(dir)).toEqual([
        "/",
        "/course/[course_id]/discussion/new",
        "/course/[course_id]/settings",
        "/docs/[[...slug]]",
        "/sign-in"
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
