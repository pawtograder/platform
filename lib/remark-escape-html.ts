import type { Html, Paragraph, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Parents where raw HTML is block-level; a lone text node is invalid here, so
 * we wrap the escaped content in a paragraph.
 */
const FLOW_BLOCK_PARENT_TYPES = new Set<string>(["root", "blockquote", "listItem", "footnoteDefinition"]);

function isFlowBlockParent(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    FLOW_BLOCK_PARENT_TYPES.has(String((node as { type: unknown }).type))
  );
}

/**
 * Remark plugin that converts raw HTML nodes to text nodes so that
 * angle-bracketed content (e.g. `<foobar>`) is displayed literally
 * instead of being stripped or interpreted as HTML.
 */
export default function remarkEscapeHtml() {
  return (tree: Root) => {
    visit(tree, "html", (node, index, parent) => {
      const htmlNode = node as Html;
      if (parent && typeof index === "number" && isFlowBlockParent(parent)) {
        const textNode: Text = { type: "text", value: htmlNode.value };
        const paragraphNode: Paragraph = {
          type: "paragraph",
          children: [textNode]
        };
        parent.children.splice(index, 1, paragraphNode);
      } else {
        (node as unknown as { type: string }).type = "text";
      }
    });
  };
}
