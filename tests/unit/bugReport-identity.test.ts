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
// A key that holds a person's name or email, as a tag, context field, or extra: `email`,
// `student_email`, `recipient`, Azure's `mail` and `userPrincipalName`. Counts such as
// `unique_emails_count` don't match. GitHub handles (the `username` tag in GitHubWrapper) are not
// covered by ADR 3 and are left alone here.
const IDENTITY_TAG =
  /^(\w*e-?mails?|mail|recipients?|name|real_?name|full_?name|sortable_?name|display_?name|given_?name|surname|user_?principal_?name)$/i;
/** Calls whose second argument may be a capture context ({ user, tags, extra, contexts }). */
const CAPTURE_CALLS = new Set(["captureException", "captureMessage", "captureEvent"]);

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

function propertyKey(prop: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string {
  return (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && prop.name
    ? prop.name.getText(sf).replace(/["']/g, "")
    : "<spread>";
}

function identityViolationsIn(text: string, rel: string): string[] {
  if (!/setUser|setTag|setContext|setExtra|capture(Exception|Message|Event)/.test(text)) return [];
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const problems: string[] = [];
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  /** `{ id }` only, and the id must not be an email. */
  const checkUser = (user: ts.Expression, call: string, node: ts.Node) => {
    if (user.kind === ts.SyntaxKind.NullKeyword) return; // clearing the user is fine
    if (!ts.isObjectLiteralExpression(user)) {
      problems.push(`${at(node)} ${call} with a non-literal user can't be checked; pass { id }`);
      return;
    }
    for (const prop of user.properties) {
      const key = propertyKey(prop, sf);
      if (!USER_KEYS_ALLOWED.has(key)) problems.push(`${at(prop)} ${call} sets user "${key}"; only id is allowed`);
      else if (/e-?mail/i.test(prop.getText(sf))) problems.push(`${at(prop)} ${call} sets an email as the user id`);
    }
  };
  /** Keys of a tags, extra, or context object. A spread can't be checked; `strict` flags it. */
  const checkKeys = (obj: ts.ObjectLiteralExpression, what: string, strict: boolean) => {
    for (const prop of obj.properties) {
      const key = propertyKey(prop, sf);
      if (key === "<spread>") {
        if (strict) problems.push(`${at(prop)} ${what} spreads an object, which can't be checked`);
      } else if (IDENTITY_TAG.test(key)) problems.push(`${at(prop)} ${what} sets "${key}", a name or email`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
      const second = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
      // `Sentry.x(...)` or `scope.x(...)`, as opposed to a React state setter that shares the name.
      const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText(sf) : "";
      const onSentry = /^Sentry$|scope(\(\))?$/i.test(receiver);
      if (name === "setUser" && first) checkUser(first, "setUser", node);
      if (name === "setTag" && first && ts.isStringLiteralLike(first) && IDENTITY_TAG.test(first.text)) {
        problems.push(`${at(node)} setTag("${first.text}") sends a name or email`);
      }
      if (name === "setTags" && first) {
        if (ts.isObjectLiteralExpression(first)) checkKeys(first, "setTags", onSentry);
        else if (onSentry) problems.push(`${at(node)} setTags with a non-literal argument can't be checked`);
      }
      if (name === "setExtra" && first && ts.isStringLiteralLike(first) && IDENTITY_TAG.test(first.text)) {
        problems.push(`${at(node)} setExtra("${first.text}") sends a name or email`);
      }
      if (name === "setExtras" && first && ts.isObjectLiteralExpression(first)) checkKeys(first, "setExtras", onSentry);
      if (name === "setContext" && second && ts.isObjectLiteralExpression(second)) {
        checkKeys(second, `setContext(${first?.getText(sf) ?? "?"})`, onSentry);
      }
      if (name && CAPTURE_CALLS.has(name) && second && ts.isObjectLiteralExpression(second)) {
        for (const prop of second.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = propertyKey(prop, sf);
          const value = unwrap(prop.initializer);
          if (key === "user") checkUser(value, name, prop);
          else if ((key === "tags" || key === "extra") && ts.isObjectLiteralExpression(value)) {
            checkKeys(value, `${name} ${key}`, true);
          } else if (key === "contexts" && ts.isObjectLiteralExpression(value)) {
            for (const ctx of value.properties) {
              if (ts.isPropertyAssignment(ctx) && ts.isObjectLiteralExpression(unwrap(ctx.initializer))) {
                checkKeys(unwrap(ctx.initializer) as ts.ObjectLiteralExpression, `${name} contexts`, true);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

function identityViolations(file: string): string[] {
  return identityViolationsIn(readFileSync(file, "utf8"), path.relative(ROOT, file));
}

describe("G1: no Sentry identity call anywhere sends a name or email", () => {
  it("every setUser sets only id, and no tag, context, or extra is a name or email", () => {
    const files = [
      ...SCAN_DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d))),
      ...SCAN_FILES.map((f) => path.join(ROOT, f))
    ];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(identityViolations)).toEqual([]);
  });

  describe("the checker catches", () => {
    it.each([
      ["an email in setUser", "Sentry.setUser({ id, email });", /setUser sets user "email"/],
      ["an email as the user id", "Sentry.setUser({ id: user.email });", /email as the user id/],
      ["a recipient address in a context", 'scope.setContext("smtp_error", { recipient: r });', /"recipient"/],
      ["Azure mail and UPN in a context", 'scope?.setContext("p", { mail: m, userPrincipalName: u });', /"mail"/],
      ["a prefixed email tag", 'scope.setTag("student_email", e);', /student_email/],
      ["a spread in setTags", "Sentry.setTags({ ...identity });", /spreads/],
      ["setTags with a variable", "Sentry.setTags(identityTags);", /non-literal/],
      ["a name in setExtra", 'Sentry.setExtra("name", n);', /setExtra\("name"\)/],
      ["a user in a capture context", "Sentry.captureException(e, { user: { id, email } });", /user "email"/],
      ["an email in capture extra", "Sentry.captureMessage(m, { extra: { email } });", /"email"/],
      ["a name in capture contexts", "Sentry.captureException(e, { contexts: { p: { full_name: n } } });", /full_name/]
    ])("%s", (_label, source, pattern) => {
      expect(identityViolationsIn(source, "synthetic.ts").join("\n")).toMatch(pattern);
    });

    it("and leaves IDs, counts, and clearing alone", () => {
      const source = [
        "Sentry.setUser(null);",
        "scope.setUser({ id: user.id });",
        'scope.setContext("email", { recipient_user_id: id, cc_count: 1 });',
        'scope.setContext("context_fetch_error", { type: "emails", unique_emails_count: 3 });',
        "Sentry.setTags({ role, class_id: classId });",
        "Sentry.captureException(e, { tags: { role }, user: { id: ctx.userId } });"
      ].join("\n");
      expect(identityViolationsIn(source, "synthetic.ts")).toEqual([]);
    });
  });
});
