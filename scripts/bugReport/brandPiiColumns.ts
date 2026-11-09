/**
 * Brands the classified columns of every public table and view `Row` in the generated
 * `SupabaseTypes.d.ts` as `Pii<kind, T>` (package 4b), so the `pii-render` lint rule
 * (`eslint-rules/pii-render.mjs`) can see through the type checker which values are names, emails,
 * handles, grades, or free text. `Insert` and `Update` stay unbranded.
 *
 * The brand is an optional phantom property, so a branded value is still assignable to and from its
 * plain type: code that reads `row.name` as a string, compares it, or builds a row from literals
 * typechecks unchanged. Idempotent: an already-branded column is left alone.
 */
import ts from "typescript";
import type { PiiKind } from "../../lib/bugReport/privacyTypes";

export const PII_TYPE_NAME = "Pii";

const PII_DECLARATION = `/**
 * Privacy brand from lib/bugReport/privacy.ts, added by scripts/bugReport/brandPiiColumns.ts. An
 * optional phantom property, so a branded value stays assignable to and from its plain type; the
 * pii-render lint rule reads it through the type checker. Null and undefined are never branded.
 */
export type ${PII_TYPE_NAME}<K extends "name" | "email" | "handle" | "grade" | "free_text", T> = T extends null | undefined
  ? T
  : T & { readonly __pii?: K };
`;

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

function members(node: ts.TypeNode | undefined): Map<string, ts.PropertySignature> {
  const out = new Map<string, ts.PropertySignature>();
  if (!node) return out;
  let n: ts.TypeNode = node;
  while (ts.isParenthesizedTypeNode(n)) n = n.type;
  if (!ts.isTypeLiteralNode(n)) return out;
  for (const m of n.members) if (ts.isPropertySignature(m) && m.type) out.set(propName(m.name), m);
  return out;
}

function isPiiReference(node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === PII_TYPE_NAME;
}

function isNullish(node: ts.TypeNode): boolean {
  return (
    (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  );
}

/** `string | null` → `Pii<"name", string> | null`; `A | B` → `Pii<K, A | B>`. */
export function brandTypeText(type: ts.TypeNode, kind: Exclude<PiiKind, "none">, sf: ts.SourceFile): string | null {
  const parts = ts.isUnionTypeNode(type) ? [...type.types] : [type];
  if (parts.some(isPiiReference)) return null;
  const nullish = parts.filter(isNullish);
  const rest = parts.filter((p) => !isNullish(p));
  if (rest.length === 0) return null;
  const branded = `${PII_TYPE_NAME}<"${kind}", ${rest.map((p) => p.getText(sf)).join(" | ")}>`;
  return [branded, ...nullish.map((p) => p.getText(sf))].join(" | ");
}

export type BrandResult = { source: string; branded: number };

/**
 * Returns `source` with each classified public `Row` column wrapped in `Pii<kind, T>` and the `Pii`
 * alias declared once after the `Json` alias. `classify` returns the column's kind, or undefined
 * when it has no entry (the exhaustiveness check reports those separately).
 */
export function brandPiiColumns(
  source: string,
  classify: (key: string) => PiiKind | undefined,
  schema = "public"
): BrandResult {
  const sf = ts.createSourceFile("SupabaseTypes.d.ts", source, ts.ScriptTarget.Latest, true);
  let database: ts.TypeNode | undefined;
  let jsonAlias: ts.TypeAliasDeclaration | undefined;
  let hasPii = false;
  for (const stmt of sf.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue;
    if (stmt.name.text === "Database") database = stmt.type;
    if (stmt.name.text === "Json") jsonAlias = stmt;
    if (stmt.name.text === PII_TYPE_NAME) hasPii = true;
  }
  if (!database) throw new Error("no `Database` type alias found");
  const schemaProp = members(database).get(schema);
  if (!schemaProp) throw new Error(`no "${schema}" schema in Database`);
  const s = members(schemaProp.type);

  const edits: { start: number; end: number; text: string }[] = [];
  for (const key of ["Tables", "Views"]) {
    for (const [relation, def] of members(s.get(key)?.type)) {
      for (const [column, prop] of members(members(def.type).get("Row")?.type)) {
        const kind = classify(`${relation}.${column}`);
        if (!kind || kind === "none" || !prop.type) continue;
        const text = brandTypeText(prop.type, kind, sf);
        if (text !== null) edits.push({ start: prop.type.getStart(sf), end: prop.type.getEnd(), text });
      }
    }
  }
  if (!hasPii) {
    const at = jsonAlias ? jsonAlias.getEnd() : 0;
    edits.push({ start: at, end: at, text: (jsonAlias ? "\n\n" : "") + PII_DECLARATION + (jsonAlias ? "" : "\n") });
  }

  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { source: out, branded: edits.length - (hasPii ? 0 : 1) };
}

/** The inverse, for readers that want the column's plain type text: `Pii<K, T> | null` → `T | null`. */
export function unbrandTypeText(type: ts.TypeNode, sf: ts.SourceFile): string {
  const parts = ts.isUnionTypeNode(type) ? [...type.types] : [type];
  if (!parts.some(isPiiReference)) return type.getText(sf);
  return parts
    .map((p) => (isPiiReference(p) ? (p as ts.TypeReferenceNode).typeArguments![1].getText(sf) : p.getText(sf)))
    .join(" | ");
}
