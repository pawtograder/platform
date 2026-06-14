/**
 * Lightweight, dependency-free source-symbol parser for the grading code viewer.
 *
 * There is no language server in the browser or in our Deno edge functions, so parsing is
 * heuristic (regex / line-based). It deliberately targets only the declarations that power
 * "go to definition": types (class / interface / enum / record / `type`), functions / methods,
 * and top-level fields / variables. Ambiguous or unparseable input yields fewer symbols rather
 * than wrong ones — empty results simply disable go-to-definition for that file.
 *
 * Pure module: no Deno- or Node-specific APIs, so it is shared by the indexing edge function,
 * the backfill script, the Jest unit tests, and (read side) the frontend.
 */

export type SymbolLanguage = "java" | "python" | "typescript";

export type CodeSymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "method"
  | "constructor"
  | "field"
  | "function"
  | "variable";

/** A single declaration within one file. Lines and columns are 1-based (Monaco convention). */
export type CodeSymbol = {
  name: string;
  kind: CodeSymbolKind;
  line: number;
  column: number;
};

/** Parsed symbols for one file, tagged with the file identity needed to build a cross-file index. */
export type FileSymbols = {
  fileId: number;
  fileName: string;
  symbols: CodeSymbol[];
};

/** A symbol resolved back to the file it was declared in. */
export type IndexedSymbol = CodeSymbol & { fileId: number; fileName: string };

export type SymbolIndex = {
  byName: Map<string, IndexedSymbol[]>;
};

const TYPE_LIKE_KINDS: ReadonlySet<CodeSymbolKind> = new Set(["class", "interface", "enum", "type"]);

/** Map a file name to the language we can parse, or null if unsupported. */
export function getSymbolLanguage(fileName: string): SymbolLanguage | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  return null;
}

/** Basename without directory or extension, e.g. "src/com/Foo.java" -> "Foo". */
export function baseNameWithoutExtension(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Column (1-based) of `name`'s first occurrence at or after `from` within `line`. */
function columnOf(line: string, name: string, from = 0): number {
  const idx = line.indexOf(name, from);
  return (idx < 0 ? 0 : idx) + 1;
}

const JAVA_TYPE = /\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/;
// A method/constructor declaration: at least one modifier keyword, then (optional return type) name(...).
const JAVA_MEMBER =
  /^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\s+)+[\w<>\[\],.\s]*?\b([A-Za-z_]\w*)\s*\(/;
const JAVA_FIELD =
  /^[ \t]*(?:(?:public|private|protected|static|final|volatile|transient)\s+)+[\w<>\[\].]+\s+([A-Za-z_]\w*)\s*[=;]/;

function parseJava(contents: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const typeMatch = JAVA_TYPE.exec(line);
    if (typeMatch) {
      const keyword = typeMatch[1];
      const name = typeMatch[2];
      const kind: CodeSymbolKind = keyword === "interface" ? "interface" : keyword === "enum" ? "enum" : "class";
      symbols.push({ name, kind, line: lineNo, column: columnOf(line, name, typeMatch.index) });
      continue;
    }

    const memberMatch = JAVA_MEMBER.exec(line);
    if (memberMatch) {
      const name = memberMatch[1];
      // Skip control-flow keywords that look like calls (if/for/while/switch/catch/return/new).
      if (!["if", "for", "while", "switch", "catch", "return", "new"].includes(name)) {
        symbols.push({ name, kind: "method", line: lineNo, column: columnOf(line, name) });
        continue;
      }
    }

    const fieldMatch = JAVA_FIELD.exec(line);
    if (fieldMatch) {
      const name = fieldMatch[1];
      symbols.push({ name, kind: "field", line: lineNo, column: columnOf(line, name) });
    }
  }
  return symbols;
}

const PY_CLASS = /^([ \t]*)class\s+([A-Za-z_]\w*)/;
const PY_DEF = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_ASSIGN = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;

function parsePython(contents: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const classMatch = PY_CLASS.exec(line);
    if (classMatch) {
      const name = classMatch[2];
      symbols.push({ name, kind: "class", line: lineNo, column: columnOf(line, name, classMatch[1].length) });
      continue;
    }

    const defMatch = PY_DEF.exec(line);
    if (defMatch) {
      const indent = defMatch[1].length;
      const name = defMatch[2];
      symbols.push({
        name,
        kind: indent > 0 ? "method" : "function",
        line: lineNo,
        column: columnOf(line, name, indent)
      });
      continue;
    }

    // Module-level (column 0) assignment, e.g. `CONFIG = {...}`. Skip dunder names.
    const assignMatch = PY_ASSIGN.exec(line);
    if (assignMatch && !assignMatch[1].startsWith("__")) {
      const name = assignMatch[1];
      symbols.push({ name, kind: "variable", line: lineNo, column: 1 });
    }
  }
  return symbols;
}

const TS_TYPE = /\b(class|interface|enum|type)\s+([A-Za-z_]\w*)/;
const TS_FUNCTION = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_]\w*)/;
const TS_BINDING = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)/;

function parseTypeScript(contents: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const typeMatch = TS_TYPE.exec(line);
    if (typeMatch) {
      const keyword = typeMatch[1];
      const name = typeMatch[2];
      const kind: CodeSymbolKind =
        keyword === "class" ? "class" : keyword === "interface" ? "interface" : keyword === "enum" ? "enum" : "type";
      symbols.push({ name, kind, line: lineNo, column: columnOf(line, name, typeMatch.index) });
      continue;
    }

    const fnMatch = TS_FUNCTION.exec(line);
    if (fnMatch) {
      const name = fnMatch[1];
      symbols.push({ name, kind: "function", line: lineNo, column: columnOf(line, name) });
      continue;
    }

    const bindingMatch = TS_BINDING.exec(line);
    if (bindingMatch) {
      const name = bindingMatch[1];
      symbols.push({ name, kind: "variable", line: lineNo, column: columnOf(line, name) });
    }
  }
  return symbols;
}

/** Parse a file's source into symbols. Returns [] for unsupported languages or empty input. */
export function parseSymbols(contents: string, fileName: string): CodeSymbol[] {
  if (!contents) return [];
  switch (getSymbolLanguage(fileName)) {
    case "java":
      return parseJava(contents);
    case "python":
      return parsePython(contents);
    case "typescript":
      return parseTypeScript(contents);
    default:
      return [];
  }
}

/** Build a cross-file name -> declarations index from parsed files. */
export function buildSymbolIndex(files: FileSymbols[]): SymbolIndex {
  const byName = new Map<string, IndexedSymbol[]>();
  for (const file of files) {
    for (const sym of file.symbols) {
      const list = byName.get(sym.name) ?? [];
      list.push({ ...sym, fileId: file.fileId, fileName: file.fileName });
      byName.set(sym.name, list);
    }
  }
  return { byName };
}

/**
 * Resolve an identifier to its best declaration:
 *   1. a declaration in the same file (local scope wins),
 *   2. a declaration whose file basename matches the word (Java/TS class-per-file convention),
 *   3. the first type-like declaration (class/interface/enum/type),
 *   4. otherwise the first match.
 */
export function resolveDefinition(
  word: string,
  currentFileId: number | null,
  index: SymbolIndex
): IndexedSymbol | null {
  const matches = index.byName.get(word);
  if (!matches || matches.length === 0) return null;

  const local = matches.find((m) => m.fileId === currentFileId);
  if (local) return local;

  const byBasename = matches.find((m) => baseNameWithoutExtension(m.fileName) === word);
  if (byBasename) return byBasename;

  const typeLike = matches.find((m) => TYPE_LIKE_KINDS.has(m.kind));
  return typeLike ?? matches[0];
}
