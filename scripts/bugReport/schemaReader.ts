/**
 * Reads the public schema out of the generated `SupabaseTypes.d.ts` and the wrapper list out of
 * `lib/edgeFunctions.ts`, using the TypeScript parser (no type checker, so it runs in well under a
 * second). Shared by `scripts/PostprocessSupabaseTypes.ts` (exhaustiveness check, runtime maps) and
 * `scripts/bugReport/generatePrivacyDraft.ts` (initial classification).
 */
import fs from "fs";
import ts from "typescript";

export type RelationshipInfo = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

export type RelationInfo = {
  kind: "table" | "view";
  /** Column name to the source text of its `Row` type. */
  columns: Record<string, string>;
  relationships: RelationshipInfo[];
};

export type FunctionOverload = {
  args: Record<string, string>;
  /** Source text of the `Returns` type. */
  returns: string;
  /** Present when the generator could tie the return to a table or view row type. */
  setof?: { to: string; isOneToOne: boolean; isSetofReturn: boolean };
  /** Present for `RETURNS TABLE(...)` / record returns: column name to type text. */
  returnsColumns?: Record<string, string>;
  /** True when `Returns` is an array (SETOF, `RETURNS TABLE`, or an array scalar). */
  returnsArray: boolean;
};

export type SchemaInfo = {
  relations: Record<string, RelationInfo>;
  functions: Record<string, FunctionOverload[]>;
};

function propName(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

function members(node: ts.TypeNode | undefined): Map<string, ts.TypeNode> {
  const out = new Map<string, ts.TypeNode>();
  if (!node) return out;
  let n: ts.TypeNode = node;
  while (ts.isParenthesizedTypeNode(n)) n = n.type;
  if (!ts.isTypeLiteralNode(n)) return out;
  for (const m of n.members) {
    if (ts.isPropertySignature(m) && m.type) {
      out.set(propName(m.name, m.getSourceFile()), m.type);
    }
  }
  return out;
}

function stringLiteral(node: ts.TypeNode | undefined): string {
  if (node && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
  throw new Error(`expected a string literal type, got ${node?.getText()}`);
}

function booleanLiteral(node: ts.TypeNode | undefined): boolean {
  if (node && ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return false;
  }
  throw new Error(`expected a boolean literal type, got ${node?.getText()}`);
}

function stringTuple(node: ts.TypeNode | undefined): string[] {
  if (node && ts.isTupleTypeNode(node)) return node.elements.map((e) => stringLiteral(e as ts.TypeNode));
  throw new Error(`expected a tuple type, got ${node?.getText()}`);
}

function readRelationships(node: ts.TypeNode | undefined): RelationshipInfo[] {
  if (!node || !ts.isTupleTypeNode(node)) return [];
  return node.elements.map((el) => {
    const m = members(el as ts.TypeNode);
    return {
      foreignKeyName: stringLiteral(m.get("foreignKeyName")),
      columns: stringTuple(m.get("columns")),
      isOneToOne: booleanLiteral(m.get("isOneToOne")),
      referencedRelation: stringLiteral(m.get("referencedRelation")),
      referencedColumns: stringTuple(m.get("referencedColumns"))
    };
  });
}

function readColumns(node: ts.TypeNode | undefined, sf: ts.SourceFile): Record<string, string> {
  const cols: Record<string, string> = {};
  for (const [k, v] of members(node)) cols[k] = v.getText(sf);
  return cols;
}

function readOverload(node: ts.TypeNode, sf: ts.SourceFile): FunctionOverload {
  const m = members(node);
  const returnsNode = m.get("Returns");
  if (!returnsNode) throw new Error(`function overload without Returns: ${node.getText(sf)}`);
  const overload: FunctionOverload = {
    args: readColumns(m.get("Args"), sf),
    returns: returnsNode.getText(sf),
    returnsArray: ts.isArrayTypeNode(returnsNode)
  };
  const rowNode = ts.isArrayTypeNode(returnsNode) ? returnsNode.elementType : returnsNode;
  if (ts.isTypeLiteralNode(rowNode)) overload.returnsColumns = readColumns(rowNode, sf);
  const setof = members(m.get("SetofOptions"));
  if (setof.size > 0) {
    overload.setof = {
      to: stringLiteral(setof.get("to")),
      isOneToOne: booleanLiteral(setof.get("isOneToOne")),
      isSetofReturn: booleanLiteral(setof.get("isSetofReturn"))
    };
  }
  return overload;
}

/** Parses `Database["public"]` out of a generated `SupabaseTypes.d.ts` source text. */
export function readSchemaFromSource(source: string, schema = "public"): SchemaInfo {
  const sf = ts.createSourceFile("SupabaseTypes.d.ts", source, ts.ScriptTarget.Latest, true);
  let database: ts.TypeNode | undefined;
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "Database") database = stmt.type;
  }
  if (!database) throw new Error("no `Database` type alias found");
  const schemaNode = members(database).get(schema);
  if (!schemaNode) throw new Error(`no "${schema}" schema in Database`);
  const s = members(schemaNode);

  const relations: Record<string, RelationInfo> = {};
  for (const [kind, key] of [
    ["table", "Tables"],
    ["view", "Views"]
  ] as const) {
    for (const [name, def] of members(s.get(key))) {
      const d = members(def);
      relations[name] = {
        kind,
        columns: readColumns(d.get("Row"), sf),
        relationships: readRelationships(d.get("Relationships"))
      };
    }
  }

  const functions: Record<string, FunctionOverload[]> = {};
  for (const [name, def] of members(s.get("Functions"))) {
    const variants = ts.isUnionTypeNode(def) ? def.types : [def];
    functions[name] = variants.map((v) => readOverload(v, sf));
  }
  return { relations, functions };
}

export function readSchema(dtsPath: string, schema = "public"): SchemaInfo {
  return readSchemaFromSource(fs.readFileSync(dtsPath, "utf8"), schema);
}

export type EdgeWrapperTarget = {
  /** Edge function slugs this wrapper invokes (`/functions/v1/<slug>`). */
  edgeFunctions: string[];
  /** RPCs this wrapper calls directly (`/rest/v1/rpc/<name>`); their results are classified by RPCS. */
  rpcs: string[];
};

/**
 * Every exported function in `lib/edgeFunctions.ts`, with the edge functions and RPCs it calls.
 * Wrappers that call another wrapper inherit that wrapper's targets.
 */
export function readEdgeFunctionWrappers(source: string): Record<string, EdgeWrapperTarget> {
  const sf = ts.createSourceFile("edgeFunctions.ts", source, ts.ScriptTarget.Latest, true);
  const direct: Record<string, EdgeWrapperTarget & { calls: string[] }> = {};
  const exported = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const target = { edgeFunctions: [] as string[], rpcs: [] as string[], calls: [] as string[] };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf).replace(/\s+/g, "");
        const firstString = n.arguments.find((a): a is ts.StringLiteral => ts.isStringLiteral(a));
        if (callee.startsWith("invokeEdgeFunction") && firstString) target.edgeFunctions.push(firstString.text);
        else if (/\.functions\.invoke$/.test(callee) && firstString) target.edgeFunctions.push(firstString.text);
        else if (/(\.rpc|\(supabase\.rpcasCallableFunction\))$/.test(callee) && firstString)
          target.rpcs.push(firstString.text);
        else if (ts.isIdentifier(n.expression)) target.calls.push(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(stmt.body);
    direct[stmt.name.text] = target;
    if (isExported) exported.add(stmt.name.text);
  }
  const resolve = (name: string, seen: Set<string>): EdgeWrapperTarget => {
    const d = direct[name];
    const out: EdgeWrapperTarget = { edgeFunctions: [...d.edgeFunctions], rpcs: [...d.rpcs] };
    for (const c of d.calls) {
      if (!direct[c] || seen.has(c) || c === "invokeEdgeFunction") continue;
      seen.add(c);
      const sub = resolve(c, seen);
      out.edgeFunctions.push(...sub.edgeFunctions);
      out.rpcs.push(...sub.rpcs);
    }
    out.edgeFunctions = [...new Set(out.edgeFunctions)].sort();
    out.rpcs = [...new Set(out.rpcs)].sort();
    return out;
  };
  const result: Record<string, EdgeWrapperTarget> = {};
  for (const name of [...exported].sort()) result[name] = resolve(name, new Set([name]));
  return result;
}
