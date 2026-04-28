"use client";

/**
 * Monaco integration for the gradebook Expression Builder: custom language,
 * completion (built-ins + slug-aware `gradebook_columns("…")`), and hover from
 * {@link IntermediateValue} spans.
 */
import type { IntermediateValue } from "@/lib/gradebookExpressionTester";

export const GRADEBOOK_EXPRESSION_LANGUAGE_ID = "gradebookExpression";

export type GradebookBuiltinFunction = {
  name: string;
  /** Human-readable signature (no injected `context` param). */
  signature: string;
  description: string;
  /** Monaco snippet insert text (placeholders ${1:…}). */
  insertText: string;
};

/** Built-ins aligned with {@link addCommonExpressionFunctions} + gradebook lookups. */
export const GRADEBOOK_BUILTIN_FUNCTIONS: GradebookBuiltinFunction[] = [
  {
    name: "gradebook_columns",
    signature: 'gradebook_columns("column-slug-or-glob")',
    description:
      "Looks up one or more gradebook columns by slug (glob patterns allowed). Returns a value object (use `.score`, etc.) or an array when multiple columns match.",
    insertText: 'gradebook_columns("${1:slug}")'
  },
  {
    name: "assignments",
    signature: 'assignments("assignment-slug")',
    description: "Returns the assignment's total_points for the given slug.",
    insertText: 'assignments("${1:slug}")'
  },
  {
    name: "add",
    signature: "add(a, b)",
    description: "Add; unwraps gradebook value operands to their numeric score.",
    insertText: "add(${1:a}, ${2:b})"
  },
  {
    name: "subtract",
    signature: "subtract(a, b)",
    description: "Subtract; unwraps gradebook value operands.",
    insertText: "subtract(${1:a}, ${2:b})"
  },
  {
    name: "multiply",
    signature: "multiply(a, b)",
    description: "Multiply; unwraps gradebook value operands.",
    insertText: "multiply(${1:a}, ${2:b})"
  },
  {
    name: "divide",
    signature: "divide(a, b)",
    description: "Divide; unwraps gradebook value operands.",
    insertText: "divide(${1:a}, ${2:b})"
  },
  {
    name: "sum",
    signature: "sum(values)",
    description: "Sum of numeric scores from an array of gradebook values and/or numbers.",
    insertText: 'sum(${1:gradebook_columns("hw-*")})'
  },
  {
    name: "mean",
    signature: "mean(values, weighted?)",
    description:
      "Weighted percentage mean over gradebook values (default weighted=true). Each entry uses score/max_score.",
    insertText: 'mean(${1:gradebook_columns("hw-*")}, ${2:true})'
  },
  {
    name: "min",
    signature: "min(...values)",
    description: "Minimum of numeric scores extracted from gradebook values and numbers.",
    insertText: "min(${1:a}, ${2:b})"
  },
  {
    name: "max",
    signature: "max(...values)",
    description: "Maximum of numeric scores extracted from gradebook values and numbers.",
    insertText: "max(${1:a}, ${2:b})"
  },
  {
    name: "equal",
    signature: "equal(value, threshold)",
    description: "1 if value equals threshold, else 0 (unwraps gradebook value).",
    insertText: "equal(${1:value}, ${2:threshold})"
  },
  {
    name: "unequal",
    signature: "unequal(value, threshold)",
    description: "1 if value differs from threshold, else 0.",
    insertText: "unequal(${1:value}, ${2:threshold})"
  },
  {
    name: "largerEq",
    signature: "largerEq(value, threshold)",
    description: "1 if value >= threshold, else 0.",
    insertText: "largerEq(${1:value}, ${2:threshold})"
  },
  {
    name: "smallerEq",
    signature: "smallerEq(value, threshold)",
    description: "1 if value <= threshold, else 0.",
    insertText: "smallerEq(${1:value}, ${2:threshold})"
  },
  {
    name: "larger",
    signature: "larger(value, threshold)",
    description: "1 if value > threshold, else 0.",
    insertText: "larger(${1:value}, ${2:threshold})"
  },
  {
    name: "smaller",
    signature: "smaller(value, threshold)",
    description: "1 if value < threshold, else 0.",
    insertText: "smaller(${1:value}, ${2:threshold})"
  },
  {
    name: "countif",
    signature: "countif(values, condition)",
    description:
      'Count gradebook values where the lambda returns true, e.g. countif(gradebook_columns("hw-*"), f(x) = x.score > 0).',
    insertText: 'countif(${1:gradebook_columns("hw-*")}, ${2:f(x) = x.score > 0})'
  },
  {
    name: "drop_lowest",
    signature: "drop_lowest(values, count)",
    description: "Returns a new array with the lowest-scoring droppable entries removed.",
    insertText: 'drop_lowest(${1:gradebook_columns("hw-*")}, ${2:1})'
  },
  {
    name: "case_when",
    signature: "case_when(matrix)",
    description:
      "First row whose condition is truthy wins; each row is [condition, result]. Example: case_when([largerEq(T, 90), 10; true, 0])",
    insertText: "case_when([\n  ${1:largerEq(T, 90)}, ${2:10};\n  true, ${3:0}\n])"
  }
];

let languageRegistered = false;

export function registerGradebookExpressionLanguage(monaco: typeof import("monaco-editor")): void {
  if (languageRegistered) return;
  languageRegistered = true;

  monaco.languages.register({ id: GRADEBOOK_EXPRESSION_LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(GRADEBOOK_EXPRESSION_LANGUAGE_ID, {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\d+\.\d+([eE][+-]?\d+)?/, "number"],
        [/\d+/, "number"],
        [/[+\-*/^;,=[\]{}().?:!|&<>~%]+/, "operator"],
        [/[a-zA-Z_]\w*/, "identifier"]
      ]
    }
  });

  monaco.languages.setLanguageConfiguration(GRADEBOOK_EXPRESSION_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"]
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ]
  });
}

export type GradebookSlugColumn = { slug: string; detail?: string };

export type GradebookMonacoProviderOpts = {
  getColumnSlugs: () => GradebookSlugColumn[];
  getIntermediates: () => IntermediateValue[];
};

/**
 * 1-based Monaco line/column → 0-based offset into `text`.
 * Newlines: `\n` and `\r\n` (each line break counts as one logical line, per VS Code / Monaco).
 */
export function monacoPositionToOffset(text: string, lineNumber: number, column: number): number {
  if (lineNumber < 1 || column < 1) return 0;
  let line = 1;
  let i = 0;
  while (line < lineNumber && i < text.length) {
    const ch = text[i];
    if (ch === "\r") {
      i++;
      if (text[i] === "\n") i++;
      line++;
      continue;
    }
    if (ch === "\n") {
      i++;
      line++;
      continue;
    }
    i++;
  }
  return Math.min(i + (column - 1), text.length);
}

/** 0-based offset → 1-based Monaco position. */
export function offsetToMonacoPosition(text: string, offset: number): { lineNumber: number; column: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  let lineNumber = 1;
  let column = 1;
  for (let i = 0; i < safe; i++) {
    const ch = text[i];
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      lineNumber++;
      column = 1;
      continue;
    }
    if (ch === "\n") {
      lineNumber++;
      column = 1;
      continue;
    }
    column++;
  }
  return { lineNumber, column };
}

/** Prefer the model’s native offset math (CRLF-safe, matches caret). */
type MinimalTextModel = {
  getValue(): string;
  getOffsetAt?(position: { lineNumber: number; column: number }): number;
  getPositionAt?(offset: number): { lineNumber: number; column: number };
};

export function modelOffsetAt(model: MinimalTextModel, position: { lineNumber: number; column: number }): number {
  if (typeof model.getOffsetAt === "function") {
    return model.getOffsetAt(position);
  }
  return monacoPositionToOffset(model.getValue(), position.lineNumber, position.column);
}

export function modelPositionAt(model: MinimalTextModel, offset: number): { lineNumber: number; column: number } {
  if (typeof model.getPositionAt === "function") {
    return model.getPositionAt(offset);
  }
  return offsetToMonacoPosition(model.getValue(), offset);
}

/**
 * True when `offset` lies inside a `"…"` or `'…'` literal (mathjs `#` line comments skipped).
 */
export function isOffsetInsideStringLiteral(text: string, offset: number): boolean {
  const end = Math.min(offset, text.length);
  let inStr: false | '"' | "'" = false;
  let i = 0;
  while (i < end) {
    const ch = text[i];
    if (!inStr) {
      if (ch === "#") {
        while (i < end && text[i] !== "\n" && text[i] !== "\r") i++;
        continue;
      }
      if (ch === "\r") {
        i++;
        if (i < end && text[i] === "\n") i++;
        continue;
      }
      if (ch === "\n") {
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      i++;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === inStr) inStr = false;
    i++;
  }
  return inStr !== false;
}

/**
 * If `offset` is inside the first string argument of `gradebook_columns(`, returns
 * replacement range (0-based offsets) and filter text for column slug completion.
 */
export function getGradebookColumnsSlugStringContext(
  text: string,
  offset: number
): { replaceStart: number; replaceEnd: number; filter: string } | null {
  const callRe = /\bgradebook_columns\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const arg = parseFirstStringArgSpan(text, openParen);
    if (!arg) continue;
    const { contentStart, contentEndClosed } = arg;
    const inside =
      offset >= contentStart && (contentEndClosed === null ? offset <= text.length : offset < contentEndClosed);
    if (inside) {
      return {
        replaceStart: contentStart,
        replaceEnd: offset,
        filter: text.slice(contentStart, offset)
      };
    }
  }
  return null;
}

/**
 * @deprecated Use {@link getGradebookColumnsSlugStringContext} (assignments no longer use string completion here).
 */
export function getSlugStringCompletionContext(
  text: string,
  offset: number
): { kind: "gradebook_columns" | "assignments"; replaceStart: number; replaceEnd: number; filter: string } | null {
  const gc = getGradebookColumnsSlugStringContext(text, offset);
  if (gc) return { kind: "gradebook_columns", ...gc };
  return null;
}

/** After `openParenIndex` pointing at `(`, locate first string literal arg span (content only, no quotes). */
function parseFirstStringArgSpan(
  text: string,
  openParenIndex: number
): { contentStart: number; contentEndClosed: number | null } | null {
  let i = openParenIndex + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const q = text[i];
  if (q !== '"' && q !== "'") return null;
  const contentStart = i + 1;
  let j = contentStart;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === q) {
      return { contentStart, contentEndClosed: j };
    }
    j++;
  }
  return { contentStart, contentEndClosed: null };
}

/** Smallest intermediate span containing `offset` (for hover). */
export function findIntermediateForOffset(
  intermediates: IntermediateValue[],
  offset: number
): IntermediateValue | null {
  const valid = intermediates.filter(
    (iv) => iv.start >= 0 && iv.end > iv.start && offset >= iv.start && offset < iv.end
  );
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.end - a.start - (b.end - b.start));
  return valid[0] ?? null;
}

export function registerGradebookExpressionCompletionProvider(
  monaco: typeof import("monaco-editor"),
  opts: GradebookMonacoProviderOpts
): import("monaco-editor").IDisposable {
  return monaco.languages.registerCompletionItemProvider(GRADEBOOK_EXPRESSION_LANGUAGE_ID, {
    triggerCharacters: ["'", '"', "(", ".", "_"],
    provideCompletionItems(model, position) {
      const text = model.getValue();
      const offset = modelOffsetAt(model, position);
      const gcSlug = getGradebookColumnsSlugStringContext(text, offset);

      if (gcSlug) {
        const { replaceStart, replaceEnd, filter } = gcSlug;
        const startPos = modelPositionAt(model, replaceStart);
        const endPos = modelPositionAt(model, replaceEnd);
        const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
        const fl = filter.toLowerCase();
        const list = opts.getColumnSlugs().filter((c) => !fl || c.slug.toLowerCase().includes(fl));

        return {
          suggestions: list.map((item) => ({
            label: item.slug,
            kind: monaco.languages.CompletionItemKind.Value,
            detail: item.detail,
            range,
            insertText: item.slug
          }))
        };
      }

      if (isOffsetInsideStringLiteral(text, offset)) {
        return { suggestions: [] };
      }

      const word = model.getWordUntilPosition(position);
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const prefix = word.word.toLowerCase();
      const builtins = prefix
        ? GRADEBOOK_BUILTIN_FUNCTIONS.filter((f) => f.name.toLowerCase().startsWith(prefix))
        : GRADEBOOK_BUILTIN_FUNCTIONS;

      return {
        suggestions: builtins.map((f) => ({
          label: f.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: f.signature,
          documentation: { value: f.description },
          range: wordRange,
          insertText: f.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        }))
      };
    }
  });
}

export function registerGradebookExpressionHoverProvider(
  monaco: typeof import("monaco-editor"),
  opts: GradebookMonacoProviderOpts
): import("monaco-editor").IDisposable {
  return monaco.languages.registerHoverProvider(GRADEBOOK_EXPRESSION_LANGUAGE_ID, {
    provideHover(model, position) {
      const text = model.getValue();
      const offset = modelOffsetAt(model, position);
      const iv = findIntermediateForOffset(opts.getIntermediates(), offset);
      if (!iv) return null;

      const start = modelPositionAt(model, iv.start);
      const end = modelPositionAt(model, iv.end);
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

      if (iv.error) {
        return {
          range,
          contents: [{ value: `**Error**\n\n\`${iv.source}\`\n\n${iv.error}` }]
        };
      }

      const body = ["```", iv.source, "```", "", `**=** ${iv.display}`].join("\n");
      return { range, contents: [{ value: body }] };
    }
  });
}

/** Register language (once) + completion + hover; dispose all on teardown. */
export function registerGradebookExpressionEditorFeatures(
  monaco: typeof import("monaco-editor"),
  opts: GradebookMonacoProviderOpts
): import("monaco-editor").IDisposable {
  registerGradebookExpressionLanguage(monaco);
  const d1 = registerGradebookExpressionCompletionProvider(monaco, opts);
  const d2 = registerGradebookExpressionHoverProvider(monaco, opts);
  return {
    dispose() {
      d1.dispose();
      d2.dispose();
    }
  };
}
