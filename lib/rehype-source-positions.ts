import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Rehype plugin that adds data-source-line-start and data-source-line-end
 * attributes to elements that have position information.
 * This enables mapping rendered markdown elements back to source line numbers
 * for line-level commenting.
 */
export default function rehypeSourcePositions() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.position) {
        node.properties = node.properties || {};
        (node.properties as Record<string, number>)["data-source-line-start"] = node.position.start.line;
        (node.properties as Record<string, number>)["data-source-line-end"] = node.position.end.line;
      }
    });
  };
}
