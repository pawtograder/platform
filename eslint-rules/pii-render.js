/**
 * `pii/pii-render`: the type-level guardrail for the bug reporter (spec package 4b, ADR 6).
 *
 * `scripts/bugReport/brandPiiColumns.ts` brands every classified `Row` column in the generated
 * Supabase types as `Pii<kind, T>`, which is `T & { readonly __pii?: kind }`. This rule reads that
 * phantom property through the type checker and reports two things:
 *
 * - `unmasked`: a Pii value of any kind rendered inside an element carrying `data-report-unmask`
 *   (the element itself or a JSX ancestor), as a child or as any attribute or prop value. The
 *   recorder records that subtree as text, so a classified value there reaches the replay.
 * - `unblocked`: a `free_text` or `grade` value rendered outside `<ReportBlock>`, as a child of any
 *   element or an attribute of a DOM element. The taint set never string-matches those kinds, so
 *   they must be blocked structurally.
 *
 * A value counts as rendered when its own type carries the brand, when it is a template literal,
 * concatenation, conditional, or logical expression with a branded operand, or when it is a call
 * that transforms a branded string or number (`name.toUpperCase()`, `score.toFixed(1)`,
 * `String(score)`). Any other call counts only when its return type carries the brand, so
 * `formatName(row.name)` is not reported unless `formatName` is typed to return a Pii value.
 *
 * Needs typed linting (`parserOptions.projectService` or `project`). Runs in its own pass,
 * `npm run lint:pii` (eslint.pii.config.mjs), with a ratchet against `eslint-rules/pii-baseline.json`.
 */
"use strict";

const { ESLintUtils } = require("@typescript-eslint/utils");

const BRAND = "__pii";
const UNMASK_ATTRIBUTE = "data-report-unmask";
const BLOCK_COMPONENT = "ReportBlock";
const MUST_BLOCK = new Set(["free_text", "grade"]);
/** Attributes React consumes without rendering. */
const NOT_RENDERED_ATTRIBUTES = new Set(["key", "ref"]);
/** String and Number methods whose result is the value itself, reformatted. */
const TRANSFORMING_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "substring",
  "substr",
  "toExponential",
  "toFixed",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleUpperCase",
  "toLowerCase",
  "toPrecision",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "valueOf"
]);
const TRANSFORMING_GLOBALS = new Set(["String", "Number"]);

/** Kinds carried by a type: the literal values of its `__pii` property, through unions and arrays. */
function kindsOfType(type, checker, out = new Set(), seen = new Set()) {
  if (!type || seen.has(type)) return out;
  seen.add(type);
  if (type.isUnion()) {
    for (const t of type.types) kindsOfType(t, checker, out, seen);
    return out;
  }
  const brand = checker.getPropertyOfType(type, BRAND);
  if (brand) {
    const brandType = checker.getTypeOfSymbol(brand);
    for (const t of brandType.isUnion() ? brandType.types : [brandType]) {
      if (t.isStringLiteral()) out.add(t.value);
    }
    return out;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const t of checker.getTypeArguments(type)) kindsOfType(t, checker, out, seen);
  }
  return out;
}

function jsxName(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property.name;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return "";
}

function isIntrinsic(opening) {
  return opening.name.type === "JSXIdentifier" && /^[a-z]/.test(opening.name.name);
}

function hasUnmask(opening) {
  return opening.attributes.some((a) => a.type === "JSXAttribute" && jsxName(a.name) === UNMASK_ATTRIBUTE);
}

/** @type {import("@typescript-eslint/utils").TSESLint.RuleModule<"unmasked" | "unblocked", []>} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow rendering classified (Pii-branded) values inside data-report-unmask, and free text or grades outside <ReportBlock>"
    },
    messages: {
      unmasked:
        "A {{kinds}} value is rendered inside a `data-report-unmask` element, so the bug-report recorder would record it as text. Render it outside the unmasked subtree (ADR 6).",
      unblocked:
        "A {{kinds}} value is rendered outside `<ReportBlock>`. Free text and grades must be blocked from bug-report recordings; wrap the element in `<ReportBlock>` (spec package 3)."
    },
    schema: []
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function kindsOfNode(node) {
      return kindsOfType(services.getTypeAtLocation(node), checker);
    }

    /** Kinds that flow into the rendered value of `node`. */
    function renderedKinds(node, out = new Set()) {
      if (!node) return out;
      // Composite expressions are judged by their operands: the type of `row.name && <b />` has a
      // branded falsy part, but it renders the element.
      const composite = node.type === "LogicalExpression" || node.type === "ConditionalExpression";
      if (!composite) for (const k of kindsOfNode(node)) out.add(k);
      switch (node.type) {
        case "TemplateLiteral":
          for (const e of node.expressions) renderedKinds(e, out);
          break;
        case "BinaryExpression":
          if (node.operator === "+") {
            renderedKinds(node.left, out);
            renderedKinds(node.right, out);
          }
          break;
        case "LogicalExpression":
          // `a && b` renders b (or a falsy a, never a string worth recording); `a || b` and `a ?? b` either.
          if (node.operator !== "&&") renderedKinds(node.left, out);
          renderedKinds(node.right, out);
          break;
        case "ConditionalExpression":
          renderedKinds(node.consequent, out);
          renderedKinds(node.alternate, out);
          break;
        case "ChainExpression":
        case "TSNonNullExpression":
        case "TSAsExpression":
        case "TSSatisfiesExpression":
          renderedKinds(node.expression, out);
          break;
        case "CallExpression": {
          const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            TRANSFORMING_METHODS.has(callee.property.name)
          ) {
            renderedKinds(callee.object, out);
          } else if (callee.type === "Identifier" && TRANSFORMING_GLOBALS.has(callee.name) && node.arguments[0]) {
            renderedKinds(node.arguments[0], out);
          }
          break;
        }
        default:
          break;
      }
      return out;
    }

    /** The JSX elements enclosing `node`, innermost first (including one whose attribute `node` is). */
    function enclosingElements(node) {
      const out = [];
      for (let n = node.parent; n; n = n.parent) {
        if (n.type === "JSXElement") out.push(n.openingElement);
      }
      return out;
    }

    function check(expression, reportNode, { isAttribute, owner }) {
      if (!expression || expression.type === "JSXEmptyExpression") return;
      const kinds = renderedKinds(expression);
      if (kinds.size === 0) return;
      const elements = enclosingElements(reportNode);
      if (elements.some((e) => jsxName(e.name) === BLOCK_COMPONENT)) return;
      if (elements.some(hasUnmask)) {
        context.report({ node: reportNode, messageId: "unmasked", data: { kinds: [...kinds].sort().join("/") } });
        return;
      }
      // Props of a custom component are its inputs, not rendered output; the component itself is checked.
      if (isAttribute && !isIntrinsic(owner)) return;
      const blocked = [...kinds].filter((k) => MUST_BLOCK.has(k)).sort();
      if (blocked.length > 0)
        context.report({ node: reportNode, messageId: "unblocked", data: { kinds: blocked.join("/") } });
    }

    return {
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent.type === "JSXAttribute") {
          if (NOT_RENDERED_ATTRIBUTES.has(jsxName(parent.name))) return;
          check(node.expression, node, { isAttribute: true, owner: parent.parent });
        } else {
          check(node.expression, node, { isAttribute: false });
        }
      },
      JSXSpreadAttribute(node) {
        const owner = node.parent;
        // `{...row}` on an element inside the unmasked subtree passes every column.
        const type = services.getTypeAtLocation(node.argument);
        const kinds = new Set();
        for (const prop of checker.getPropertiesOfType(type)) {
          if (NOT_RENDERED_ATTRIBUTES.has(prop.name)) continue;
          for (const k of kindsOfType(checker.getTypeOfSymbol(prop), checker)) kinds.add(k);
        }
        if (kinds.size === 0) return;
        const elements = enclosingElements(node);
        if (elements.some((e) => jsxName(e.name) === BLOCK_COMPONENT)) return;
        if (elements.some(hasUnmask)) {
          context.report({ node, messageId: "unmasked", data: { kinds: [...kinds].sort().join("/") } });
          return;
        }
        if (!isIntrinsic(owner)) return;
        const blocked = [...kinds].filter((k) => MUST_BLOCK.has(k)).sort();
        if (blocked.length > 0) context.report({ node, messageId: "unblocked", data: { kinds: blocked.join("/") } });
      }
    };
  }
};
