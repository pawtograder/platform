/**
 * Utility functions for working with cursor/caret position in text inputs
 */

export interface CursorPosition {
  top: number;
  left: number;
  height: number;
}

/**
 * Get the pixel position of the cursor in a textarea element
 */
export function getCursorPosition(element: HTMLTextAreaElement, selectionStart: number): CursorPosition {
  // Create a mirror div with the same styling as the textarea
  const mirror = document.createElement("div");
  const computedStyle = window.getComputedStyle(element);

  // Copy all relevant styles
  const stylesToCopy = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "wordSpacing",
    "textIndent",
    "whiteSpace",
    "wordWrap",
    "borderLeftWidth",
    "borderRightWidth",
    "borderTopWidth",
    "borderBottomWidth",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "paddingBottom",
    "marginLeft",
    "marginRight",
    "marginTop",
    "marginBottom",
    "width",
    "boxSizing"
  ];

  stylesToCopy.forEach((style) => {
    // @ts-ignore - dynamic property access
    mirror.style[style] = computedStyle[style];
  });

  // Set additional styles for the mirror
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.height = "auto";
  mirror.style.minHeight = "auto";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";

  // Get the textarea's bounding rect to anchor the mirror
  const elementRect = element.getBoundingClientRect();
  mirror.style.left = `${elementRect.left}px`;
  mirror.style.top = `${elementRect.top}px`;

  // Add the mirror to the DOM
  document.body.appendChild(mirror);

  // Get text content up to cursor position
  const textBeforeCursor = element.value.substring(0, selectionStart);
  const textAfterCursor = element.value.substring(selectionStart);

  // Create a span for the cursor position
  const cursorSpan = document.createElement("span");
  cursorSpan.textContent = "|"; // Temporary cursor marker

  // Set the content
  mirror.textContent = textBeforeCursor;
  mirror.appendChild(cursorSpan);
  mirror.appendChild(document.createTextNode(textAfterCursor));

  // Get the position of the cursor span
  const cursorRect = cursorSpan.getBoundingClientRect();

  // Calculate relative position using the anchored mirror
  // Since the mirror is positioned at elementRect.left/top, cursorRect is already in viewport coordinates
  // We need to convert to element-relative coordinates by subtracting scroll offsets
  const position = {
    top: cursorRect.top - elementRect.top - element.scrollTop,
    left: cursorRect.left - elementRect.left - element.scrollLeft,
    height: cursorRect.height
  };

  // Clean up
  document.body.removeChild(mirror);

  return position;
}

/**
 * Get cursor position for MDEditor (CodeMirror) instances
 */
export function getMDEditorCursorPosition(editorElement: HTMLElement, selectionStart: number): CursorPosition {
  // For MDEditor, we'll need to work with the CodeMirror instance
  // This is a simplified version - in practice, you might need to access
  // the CodeMirror API directly for more accurate positioning

  const rect = editorElement.getBoundingClientRect();

  // Fallback positioning - place dropdown below the editor
  return {
    top: rect.height + 5,
    left: 10,
    height: 20
  };
}

/**
 * Get the current cursor/selection position in a text input
 */
export function getCurrentCursorPosition(element: HTMLTextAreaElement | HTMLInputElement): number {
  return element.selectionStart || 0;
}
