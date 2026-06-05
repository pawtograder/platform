/**
 * @jest-environment node
 */

/**
 * Heuristic source-symbol parsing + cross-file definition resolution for the grading code viewer.
 *
 * These are the contract for go-to-definition: the parser must surface type/function declarations
 * for Java, Python, and TypeScript, and `resolveDefinition` must point a usage at the right file
 * (local scope first, then the cross-file declaration). Wrong results here mean go-to-definition
 * jumps to the wrong place — or nowhere.
 */
import {
  buildSymbolIndex,
  getSymbolLanguage,
  parseSymbols,
  resolveDefinition,
  type FileSymbols
} from "../../supabase/functions/_shared/CodeSymbolParser";

function symbolNamed(symbols: ReturnType<typeof parseSymbols>, name: string) {
  return symbols.find((s) => s.name === name);
}

describe("getSymbolLanguage", () => {
  it("maps known extensions and rejects others", () => {
    expect(getSymbolLanguage("src/Main.java")).toBe("java");
    expect(getSymbolLanguage("pkg/mod.py")).toBe("python");
    expect(getSymbolLanguage("a/b/c.ts")).toBe("typescript");
    expect(getSymbolLanguage("Component.tsx")).toBe("typescript");
    expect(getSymbolLanguage("notes.md")).toBeNull();
    expect(getSymbolLanguage("image.png")).toBeNull();
  });
});

describe("Java parsing", () => {
  const java = `package com.example;

public class Helper {
    private int count;

    public int doMath(int a, int b) {
        return a + b;
    }
}`;

  it("extracts the class, field, and method", () => {
    const symbols = parseSymbols(java, "com/example/Helper.java");
    expect(symbolNamed(symbols, "Helper")).toMatchObject({ kind: "class", line: 3 });
    expect(symbolNamed(symbols, "count")).toMatchObject({ kind: "field" });
    expect(symbolNamed(symbols, "doMath")).toMatchObject({ kind: "method" });
  });

  it("does not treat control-flow or calls as declarations", () => {
    const symbols = parseSymbols(
      `public class A {
    public void run() {
        if (x) { return; }
        helper.doWork();
    }
}`,
      "A.java"
    );
    expect(symbolNamed(symbols, "if")).toBeUndefined();
    // "doWork" is a call, not preceded by a modifier, so it must not be picked up as a declaration.
    expect(symbolNamed(symbols, "doWork")).toBeUndefined();
  });
});

describe("Python parsing", () => {
  const py = `class Helper:
    def do_math(self, a, b):
        return a + b

def helper_fn():
    return 1

CONFIG = 5`;

  it("extracts class, method, function, and module variable", () => {
    const symbols = parseSymbols(py, "helper.py");
    expect(symbolNamed(symbols, "Helper")).toMatchObject({ kind: "class", line: 1 });
    expect(symbolNamed(symbols, "do_math")).toMatchObject({ kind: "method" });
    expect(symbolNamed(symbols, "helper_fn")).toMatchObject({ kind: "function" });
    expect(symbolNamed(symbols, "CONFIG")).toMatchObject({ kind: "variable" });
  });
});

describe("TypeScript parsing", () => {
  const ts = `export interface Shape {
  area(): number;
}
export class Circle implements Shape {
  radius: number;
  area(): number {
    return 3.14;
  }
}
export function makeCircle(): Circle {
  return new Circle();
}
export const PI = 3.14;`;

  it("extracts interface, class, function, and const", () => {
    const symbols = parseSymbols(ts, "helper.ts");
    expect(symbolNamed(symbols, "Shape")).toMatchObject({ kind: "interface" });
    expect(symbolNamed(symbols, "Circle")).toMatchObject({ kind: "class" });
    expect(symbolNamed(symbols, "makeCircle")).toMatchObject({ kind: "function" });
    expect(symbolNamed(symbols, "PI")).toMatchObject({ kind: "variable" });
  });
});

describe("resolveDefinition (cross-file)", () => {
  function indexFor(files: { fileId: number; fileName: string; contents: string }[]) {
    const parsed: FileSymbols[] = files.map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      symbols: parseSymbols(f.contents, f.fileName)
    }));
    return buildSymbolIndex(parsed);
  }

  it("resolves a Java class usage to the file that declares it (basename match)", () => {
    const index = indexFor([
      { fileId: 1, fileName: "com/example/Main.java", contents: "public class Main { void m() { Helper h; } }" },
      { fileId: 2, fileName: "com/example/Helper.java", contents: "public class Helper {}" }
    ]);
    const resolved = resolveDefinition("Helper", 1, index);
    expect(resolved).toMatchObject({ fileId: 2, kind: "class", name: "Helper" });
  });

  it("resolves a TypeScript class imported from another module", () => {
    const index = indexFor([
      {
        fileId: 10,
        fileName: "main.ts",
        contents: 'import { Circle } from "./helper";\nconst c: Circle = new Circle();'
      },
      { fileId: 11, fileName: "helper.ts", contents: "export class Circle {}" }
    ]);
    const resolved = resolveDefinition("Circle", 10, index);
    expect(resolved).toMatchObject({ fileId: 11, kind: "class" });
  });

  it("resolves a Python class even when the file basename differs from the class name (type-preferred)", () => {
    const index = indexFor([
      { fileId: 20, fileName: "main.py", contents: "from helper import Helper\n\ndef main():\n    h = Helper()" },
      { fileId: 21, fileName: "helper.py", contents: "class Helper:\n    pass" }
    ]);
    const resolved = resolveDefinition("Helper", 20, index);
    expect(resolved).toMatchObject({ fileId: 21, kind: "class" });
  });

  it("prefers a definition in the current file over a cross-file one", () => {
    const index = indexFor([
      { fileId: 1, fileName: "a.py", contents: "def shared():\n    return 1" },
      { fileId: 2, fileName: "b.py", contents: "def shared():\n    return 2" }
    ]);
    expect(resolveDefinition("shared", 2, index)).toMatchObject({ fileId: 2 });
    expect(resolveDefinition("shared", 1, index)).toMatchObject({ fileId: 1 });
  });

  it("returns null for an unknown identifier", () => {
    const index = indexFor([{ fileId: 1, fileName: "a.ts", contents: "export class Foo {}" }]);
    expect(resolveDefinition("Nonexistent", 1, index)).toBeNull();
  });
});
