/**
 * @jest-environment node
 */
import path from "path";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import rule from "@/eslint-rules/pii-render";

const FIXTURES = path.join(__dirname, "fixtures/piiRender");

// Same shape as the `Pii` alias the postprocess script writes into SupabaseTypes.d.ts; the rule
// looks for the `__pii` property, not the alias name.
const PRELUDE = `
type Pii<K extends string, T> = T extends null | undefined ? T : T & { readonly __pii?: K };
type Row = {
  id: number;
  title: string;
  name: Pii<"name", string>;
  email: Pii<"email", string> | null;
  handle: Pii<"handle", string>;
  body: Pii<"free_text", string>;
  score: Pii<"grade", number> | null;
};
declare const row: Row;
declare const rows: Row[];
declare const cond: boolean;
declare function fmt(s: unknown): string;
declare function brandFmt(s: unknown): Pii<"free_text", string>;
declare function ReportBlock(p: { children?: unknown }): null;
declare function Text(p: { children?: unknown; label?: unknown }): null;
`;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: FIXTURES,
      ecmaFeatures: { jsx: true }
    }
  }
});

const filename = path.join(FIXTURES, "component.tsx");
const code = (jsx: string) => `${PRELUDE}\nexport const el = ${jsx};\n`;
const valid = (jsx: string) => ({ code: code(jsx), filename });
const invalid = (jsx: string, ...messageIds: ("unmasked" | "unblocked")[]) => ({
  code: code(jsx),
  filename,
  errors: messageIds.map((messageId) => ({ messageId }))
});

tester.run("pii/pii-render", rule, {
  valid: [
    // Names, emails, and handles may be rendered masked; the taint set redacts them.
    valid(`<div>{row.name}</div>`),
    valid(`<span title={row.email ?? ""}>{row.handle}</span>`),
    valid(`<div data-report-unmask>{row.title} ({row.id})</div>`),
    valid(`<div data-report-unmask>{rows.length} students</div>`),
    // Blocked subtrees are recorded as placeholders, even under an unmasked ancestor.
    valid(`<ReportBlock><div>{row.body}</div></ReportBlock>`),
    valid(`<ReportBlock><span title={row.body}>{row.score}</span></ReportBlock>`),
    valid(`<div data-report-unmask><ReportBlock>{row.name}</ReportBlock></div>`),
    // Arbitrary calls are judged by their return type only.
    valid(`<div>{fmt(row.body)}</div>`),
    // `key` is not rendered, and a custom component's props are checked inside that component.
    valid(`<div key={row.body}>x</div>`),
    valid(`<Text label={row.body} />`),
    // `a && <b />` renders the element, not the free text.
    valid(`<div>{row.body && <b>has a body</b>}</div>`)
  ],
  invalid: [
    // Any kind inside data-report-unmask, as a child, a template, an attribute, a prop, or a spread.
    invalid(`<div data-report-unmask>{row.name}</div>`, "unmasked"),
    invalid(`<div data-report-unmask><p><span>{\`\${row.email}\`}</span></p></div>`, "unmasked"),
    invalid(`<div data-report-unmask title={row.name} />`, "unmasked"),
    invalid(`<div data-report-unmask><Text label={row.handle} /></div>`, "unmasked"),
    invalid(`<div data-report-unmask {...row} />`, "unmasked"),
    invalid(`<ul data-report-unmask>{rows.map((r) => <li key={r.id}>{r.name}</li>)}</ul>`, "unmasked"),
    invalid(`<div data-report-unmask>{row.name.toUpperCase()}</div>`, "unmasked"),
    invalid(`<div data-report-unmask>{row.body}</div>`, "unmasked"),
    // Free text and grades outside <ReportBlock>.
    invalid(`<div>{row.body}</div>`, "unblocked"),
    invalid(`<div>{row.score ?? 0}</div>`, "unblocked"),
    invalid(`<div>{row.score?.toFixed(1)}</div>`, "unblocked"),
    invalid(`<div>{String(row.score)}</div>`, "unblocked"),
    invalid(`<div>{"Score: " + row.score}</div>`, "unblocked"),
    invalid(`<div>{\`\${row.title}: \${row.body}\`}</div>`, "unblocked"),
    invalid(`<div>{cond ? row.body : "none"}</div>`, "unblocked"),
    invalid(`<div>{brandFmt(row.title)}</div>`, "unblocked"),
    invalid(`<span title={row.body} />`, "unblocked"),
    invalid(`<Text>{row.body}</Text>`, "unblocked"),
    invalid(`<div>{rows.map((r) => r.body)}</div>`, "unblocked"),
    invalid(`<div {...row} />`, "unblocked"),
    // A value held in a local keeps its brand.
    {
      code: `${PRELUDE}\nexport function C() {\n  const who = row.name;\n  return <div data-report-unmask>{who}</div>;\n}\n`,
      filename,
      errors: [{ messageId: "unmasked" as const }]
    }
  ]
});
