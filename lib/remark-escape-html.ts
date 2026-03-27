import type { Root } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Remark plugin that converts raw HTML nodes to text nodes so that
 * angle-bracketed content (e.g. `<foobar>`) is displayed literally
 * instead of being stripped or interpreted as HTML.
 */
export default function remarkEscapeHtml() {
  return (tree: Root) => {
    visit(tree, "html", (node) => {
      (node as unknown as { type: string }).type = "text";
    });
  };
}
