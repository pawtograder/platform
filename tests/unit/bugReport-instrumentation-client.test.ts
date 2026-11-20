/**
 * @jest-environment node
 *
 * B5 (spec §7.3): nothing replay-related may leave the browser before the user submits a report,
 * so the Sentry client config must never turn on Sentry's own replay or feedback widget. This
 * parses instrumentation-client.ts and fails if:
 *   - `replayIntegration` (or any replay integration) is referenced at all;
 *   - `replaysSessionSampleRate` or `replaysOnErrorSampleRate` is anything but the literal 0;
 *   - `feedbackIntegration` is called without `autoInject: false`;
 *   - the file imports anything beyond what it already needs (its own header comment explains
 *     why an extra import there can silently take Sentry and PostHog init down).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ALLOWED_IMPORTS = new Set(["@sentry/nextjs", "posthog-js"]);
const REPLAY_RATE_KEYS = new Set(["replaysSessionSampleRate", "replaysOnErrorSampleRate"]);

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isLiteralZero(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
  return ts.isNumericLiteral(expr) && Number(expr.text) === 0;
}

/** Returns a list of violations; empty means the config is acceptable. */
function checkClientConfig(source: string, fileName = "instrumentation-client.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const where = (node: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!ALLOWED_IMPORTS.has(node.moduleSpecifier.text)) {
        problems.push(`unexpected import "${node.moduleSpecifier.text}" (${where(node)})`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      problems.push(`unexpected require() (${where(node)})`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push(`unexpected dynamic import() (${where(node)})`);
    }
    if (ts.isIdentifier(node) && /replay/i.test(node.text) && /integration/i.test(node.text)) {
      problems.push(`${node.text} referenced (${where(node)})`);
    }
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name);
      if (key && REPLAY_RATE_KEYS.has(key) && !isLiteralZero(node.initializer)) {
        problems.push(`${key} must be the literal 0 (${where(node)})`);
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && REPLAY_RATE_KEYS.has(node.name.text)) {
      problems.push(`${node.name.text} must be the literal 0 (${where(node)})`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === "feedbackIntegration") {
        const options = node.arguments[0];
        const autoInjectOff =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              propertyName(p.name) === "autoInject" &&
              p.initializer.kind === ts.SyntaxKind.FalseKeyword
          );
        if (!autoInjectOff) {
          problems.push(`feedbackIntegration without autoInject: false (${where(node)})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

describe("B5: instrumentation-client.ts never enables Sentry replay or the feedback widget", () => {
  it("the real file passes", () => {
    const source = readFileSync(path.join(__dirname, "../../instrumentation-client.ts"), "utf8");
    expect(checkClientConfig(source)).toEqual([]);
    // The rates are present and explicitly zero rather than merely absent.
    expect(source).toMatch(/replaysSessionSampleRate:\s*0\b/);
    expect(source).toMatch(/replaysOnErrorSampleRate:\s*0\b/);
    expect(source).toMatch(/integrations:\s*\[\]/);
  });

  describe("the checker catches", () => {
    const base = (init: string, extra = "") =>
      `import * as Sentry from "@sentry/nextjs";\n${extra}\nSentry.init({ dsn: "x", ${init} });`;

    it.each([
      ["replayIntegration", base("integrations: [Sentry.replayIntegration()]"), /replayIntegration referenced/],
      ["replayCanvasIntegration", base("integrations: [Sentry.replayCanvasIntegration()]"), /replayCanvas/],
      ["a named replay import", base("", 'import { replayIntegration } from "@sentry/nextjs";'), /replayIntegration/],
      ["a non-zero session rate", base("replaysSessionSampleRate: 0.1"), /replaysSessionSampleRate/],
      ["a non-zero error rate", base("replaysOnErrorSampleRate: 1"), /replaysOnErrorSampleRate/],
      ["a computed rate", base("replaysOnErrorSampleRate: rate"), /replaysOnErrorSampleRate/],
      ["a shorthand rate", base("replaysSessionSampleRate"), /replaysSessionSampleRate/],
      ["a quoted rate key", base('"replaysOnErrorSampleRate": 0.5'), /replaysOnErrorSampleRate/],
      ["feedback with defaults", base("integrations: [Sentry.feedbackIntegration()]"), /autoInject/],
      [
        "feedback with autoInject true",
        base("integrations: [Sentry.feedbackIntegration({ autoInject: true })]"),
        /autoInject/
      ],
      ["an extra import", base("", 'import { thing } from "@/lib/thing";'), /unexpected import/],
      ["a dynamic import", base("", 'import("@/lib/thing");'), /dynamic import/]
    ])("%s", (_label, source, pattern) => {
      const problems = checkClientConfig(source);
      expect(problems.join("\n")).toMatch(pattern);
    });

    it("and allows feedback with autoInject: false and zero rates", () => {
      const source = base(
        "replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0, integrations: [Sentry.feedbackIntegration({ autoInject: false })]"
      );
      expect(checkClientConfig(source)).toEqual([]);
    });
  });
});
