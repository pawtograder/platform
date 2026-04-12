/**
 * Lightweight Java symbol helpers for the grading Monaco integration.
 * Parses are best-effort; empty results disable go-to-definition until symbols are found.
 */

export type JavaSymbolKind = "class" | "interface" | "enum" | "method" | "constructor" | "field";

export type JavaSymbol = {
  name: string;
  kind: JavaSymbolKind;
  line: number;
  column: number;
  fileId: number;
  parent?: string;
  returnType?: string;
  parameters?: string[];
};

export type JavaFileSymbols = {
  fileId: number;
  fileName: string;
  symbols: JavaSymbol[];
};

export type SymbolIndex = {
  byName: Map<string, JavaSymbol[]>;
};

export function parseJavaFile(contents: string, fileId: number, fileName: string): JavaFileSymbols {
  void contents;
  return { fileId, fileName, symbols: [] };
}

export function buildSymbolIndex(files: JavaFileSymbols[]): SymbolIndex {
  const byName = new Map<string, JavaSymbol[]>();
  for (const file of files) {
    for (const sym of file.symbols) {
      const list = byName.get(sym.name) ?? [];
      list.push(sym);
      byName.set(sym.name, list);
    }
  }
  return { byName };
}

export function resolveType(
  word: string,
  file: JavaFileSymbols | undefined,
  index: SymbolIndex | null
): { fileId: number; line: number; column: number; name: string } | null {
  void word;
  void file;
  void index;
  return null;
}

export function findReferences(
  symbol: JavaSymbol,
  index: SymbolIndex,
  files: { id: number; contents: string }[]
): { fileId: number; line: number; column: number }[] {
  void symbol;
  void index;
  void files;
  return [];
}
