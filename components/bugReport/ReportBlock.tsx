import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/** The attribute the recorder's block selector matches (`lib/bugReport/recorder.ts`). */
export const REPORT_BLOCK_ATTRIBUTE = "data-report-block";

type ReportBlockProps = {
  children?: ReactNode;
  /**
   * Render this wrapper element instead of marking the child. Use it when the child is text or
   * several nodes and a `span` would sit wrong, for example a block of paragraphs (`as="div"`).
   */
  as?: "span" | "div";
};

/**
 * Keeps free text and grades out of bug-report recordings (spec package 3).
 *
 * The recorder records an element carrying `data-report-block` as a placeholder with only its
 * class and its size, and never records its subtree: text, attributes, and inputs inside it are
 * not in the buffer at all, so nothing in review can unblock it.
 *
 * With a single element child, the attribute goes on that element and no extra DOM is added,
 * so layout, selectors, and accessibility stay as they were. The child must pass unknown props
 * through to its DOM element, as every Chakra component does. With any other children (text,
 * several elements) it renders a wrapper, a `span` unless `as` says otherwise. rrweb measures
 * the blocked element for the placeholder, so the wrapper can't use `display: contents`: that
 * box has no size and the replay would show nothing where the content was.
 *
 * Works in server and client components.
 */
export function ReportBlock({ children, as }: ReportBlockProps) {
  const marker = { [REPORT_BLOCK_ATTRIBUTE]: "" };
  if (!as && Children.count(children) === 1 && isValidElement(children) && typeof children.type !== "symbol") {
    return cloneElement(children as ReactElement<Record<string, unknown>>, marker);
  }
  const Wrapper = as ?? "span";
  return <Wrapper {...marker}>{children}</Wrapper>;
}
