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
  _word: string,
  _file: JavaFileSymbols | undefined,
  _index: SymbolIndex | null
): { fileId: number; line: number; column: number; name: string } | null {
  return null;
}

export function findReferences(
  _symbol: JavaSymbol,
  _index: SymbolIndex,
  _files: { id: number; contents: string }[]
): { fileId: number; line: number; column: number }[] {
  return [];
}
