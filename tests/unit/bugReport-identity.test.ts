/**
 * @jest-environment node
 *
 * G1 (spec §7.3, ADR 3), unit half: Sentry events carry the Pawtograder user ID and role only,
 * never a name or email. The E2E half (tests/e2e/bugReport/identity.spec.ts) checks the envelopes
 * a real build sends; this file covers the middleware, whose error paths E2E can't reach, and
 * statically checks every setUser / setTag call in the repo, edge functions included.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";

const USER_EMAIL = "g1-identity-canary@example.edu";
const USER_ID = "3f1d2c4b-0000-4000-8000-00000000c0de";

const sentryCalls: { fn: string; args: unknown[] }[] = [];
jest.mock("@sentry/nextjs", () => {
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      sentryCalls.push({ fn, args });
    };
  return {
    setUser: record("setUser"),
    setTag: record("setTag"),
    setTags: record("setTags"),
    setContext: record("setContext"),
    setExtra: record("setExtra"),
    captureException: record("captureException"),
    captureMessage: record("captureMessage")
  };
});

const claimsMock = jest.fn();
const classLookupMock = jest.fn();
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: claimsMock },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: classLookupMock }) }) })
  })
}));

jest.mock("@/utils/channels", () => ({
  channelHostSuffix: () => "example.edu",
  currentChannel: () => "stable",
  hostForChannel: () => null,
  sessionCookieOptions: () => ({}),
  STABLE_CHANNEL: "stable"
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateSession } = require("@/utils/supabase/middleware") as typeof import("@/utils/supabase/middleware");

function everythingSentToSentry(): string {
  return JSON.stringify(sentryCalls, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
}

describe("G1: middleware", () => {
  beforeEach(() => {
    sentryCalls.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    claimsMock.mockResolvedValue({
      data: { claims: { sub: USER_ID, email: USER_EMAIL, user_metadata: { name: "Canary Person" } } },
      error: null
    });
  });

  it("sets the user by ID only, and an error captured afterwards carries no email", async () => {
    classLookupMock.mockResolvedValue({ data: null, error: { message: "statement timeout", code: "57014" } });
    await updateSession(new NextRequest("http://localhost:3001/course/12/assignments"));

    const setUser = sentryCalls.filter((c) => c.fn === "setUser");
    expect(setUser).toEqual([{ fn: "setUser", args: [{ id: USER_ID }] }]);
    // The channel lookup failure is reported, in the same request scope as the user.
    expect(sentryCalls.some((c) => c.fn === "captureException")).toBe(true);
    expect(everythingSentToSentry()).not.toContain(USER_EMAIL);
    expect(everythingSentToSentry()).not.toContain("Canary Person");
  });

  it("reports a thrown session error without the email", async () => {
    claimsMock.mockRejectedValue(new Error("auth backend down"));
    await updateSession(new NextRequest("http://localhost:3001/course/12"));
    expect(sentryCalls.some((c) => c.fn === "captureException")).toBe(true);
    expect(everythingSentToSentry()).not.toContain(USER_EMAIL);
  });
});

// ---------------------------------------------------------------------------------------------

const ROOT = path.join(__dirname, "../..");
const SCAN_DIRS = ["app", "lib", "utils", "hooks", "components", "supabase/functions"];
const SCAN_FILES = [
  "instrumentation.ts",
  "instrumentation-client.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts"
];
const USER_KEYS_ALLOWED = new Set(["id"]);
// A person's name or email. GitHub handles (the `username` tag in GitHubWrapper) are not covered by
// ADR 3 and are left alone here.
const IDENTITY_TAG = /^(e-?mail|user_?e-?mail|name|real_?name|full_?name|sortable_?name|display_?name)$/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
  return expr;
}

function identityViolations(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!/setUser|setTag/.test(text)) return [];
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const rel = path.relative(ROOT, file);
  const problems: string[] = [];
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
      if (name === "setUser" && first) {
        if (first.kind === ts.SyntaxKind.NullKeyword) {
          // clearing the user is fine
        } else if (ts.isObjectLiteralExpression(first)) {
          for (const prop of first.properties) {
            const key =
              (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && prop.name
                ? prop.name.getText(sf).replace(/["']/g, "")
                : "<spread>";
            if (!USER_KEYS_ALLOWED.has(key)) problems.push(`${at(prop)} setUser sets "${key}"; only id is allowed`);
          }
        } else {
          problems.push(`${at(node)} setUser with a non-literal argument can't be checked; pass { id }`);
        }
      }
      if (name === "setTag" && first && ts.isStringLiteralLike(first) && IDENTITY_TAG.test(first.text)) {
        problems.push(`${at(node)} setTag("${first.text}") sends a name or email`);
      }
      if (name === "setTags" && first && ts.isObjectLiteralExpression(first)) {
        for (const prop of first.properties) {
          const key = prop.name?.getText(sf).replace(/["']/g, "");
          if (key && IDENTITY_TAG.test(key)) problems.push(`${at(prop)} setTags sets "${key}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

describe("G1: no Sentry identity call anywhere sends a name or email", () => {
  it("every setUser sets only id, and no tag is a name or email", () => {
    const files = [
      ...SCAN_DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d))),
      ...SCAN_FILES.map((f) => path.join(ROOT, f))
    ];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(identityViolations)).toEqual([]);
  });
});
