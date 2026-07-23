/**
 * The MCP tool surface offered to the agent — names + descriptions only.
 * Kept free of @modelcontextprotocol/sdk imports so unit tests (Jest) and the
 * runner can import it without loading the SDK (which is ESM-only and fails
 * under Jest's CJS environment); bridge.ts binds these specs to the server.
 */
import { READ_NEXT_MAX, type AtCommand } from "./atHarness";

export const MCP_SERVER_NAME = "at";
export const BRIDGE_PATH = "/mcp";

export interface ToolSpec {
  command: AtCommand;
  description: string;
  arg?: { name: string; description: string };
}

/**
 * Descriptions are explicit about WHICH cursor each tool affects — the virtual
 * (reading) cursor vs real keyboard focus — because that distinction (browse
 * mode vs focus mode) is exactly what trips up real SR users and LLMs alike.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    command: "next",
    description:
      "Move the VIRTUAL reading cursor to the next item and hear it announced. Does not move keyboard focus."
  },
  {
    command: "previous",
    description:
      "Move the VIRTUAL reading cursor to the previous item and hear it announced. Does not move keyboard focus."
  },
  {
    command: "readNext",
    arg: { name: "count", description: `how many items to read (1-${READ_NEXT_MAX})` },
    description:
      "Read the next N items in one go (bounded batch of `next`). Use this to listen through a region efficiently instead of one `next` per turn."
  },
  {
    command: "act",
    description:
      "Perform the default action on the item under the VIRTUAL cursor (click a button/link, toggle a radio or checkbox). Does not require keyboard focus."
  },
  {
    command: "interact",
    description:
      "Move real KEYBOARD FOCUS to the item under the virtual cursor and enter it (focus mode) — required before `type` or `press` on a form control."
  },
  {
    command: "stopInteracting",
    description: "Leave focus mode and return to the VIRTUAL reading cursor at the same item."
  },
  {
    command: "type",
    arg: { name: "text", description: "text to type" },
    description: "Type text into the KEYBOARD-FOCUSED element (use `interact` first)."
  },
  {
    command: "press",
    arg: { name: "key", description: "key or combo, e.g. Enter, Space, ArrowDown" },
    description: "Send a key press to the KEYBOARD-FOCUSED element via the screen reader (focus mode)."
  },
  {
    command: "pressKey",
    arg: { name: "key", description: "key or combo, e.g. Tab, Shift+Tab, Enter, Escape" },
    description:
      "Press a raw browser key (real keyboard, outside the screen reader) — Tab/Shift+Tab walk the page's real focus order."
  },
  {
    command: "moveToNextHeading",
    description: "Jump the VIRTUAL cursor to the next heading (standard SR navigation)."
  },
  {
    command: "moveToPreviousHeading",
    description: "Jump the VIRTUAL cursor to the previous heading."
  },
  {
    command: "moveToNextLandmark",
    description: "Jump the VIRTUAL cursor to the next landmark/region (navigation, main, form...)."
  },
  {
    command: "moveToPreviousLandmark",
    description: "Jump the VIRTUAL cursor to the previous landmark/region."
  },
  {
    command: "restartFromTop",
    description: "Restart reading from the top of the page (like jumping to the document start)."
  },
  {
    command: "observe",
    description:
      "Report the current state (item under the virtual cursor, keyboard focus, anything newly announced) without acting."
  }
];
