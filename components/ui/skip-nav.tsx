"use client";

/**
 * Skip-link menu for keyboard / screen-reader users (WCAG 2.4.1, 2.1.1).
 *
 * Visually hidden until any child link receives focus, at which point the
 * menu is pinned to the top-left of the viewport. Targets are id-based so
 * pages without a given landmark gracefully degrade — anchors that point at
 * a missing id are filtered out at click time.
 */
import { Box, HStack } from "@chakra-ui/react";
import { usePathname } from "next/navigation";
import * as React from "react";

const TARGETS: { id: string; label: string }[] = [
  { id: "main-content", label: "Skip to main content" },
  { id: "primary-nav", label: "Skip to navigation" },
  { id: "user-menu", label: "Skip to user menu" }
];

/**
 * Route-scoped targets: rendered only when the current route mounts the
 * landmark, so other pages never expose a skip link that goes nowhere.
 * Matched on pathname (not the DOM) so the link is stable while the page's
 * data is still loading.
 */
const CONTEXTUAL_TARGETS: { id: string; label: string; pattern: RegExp }[] = [
  {
    // The submission sub-tab bar (Grade / Autograder Detail / Files) sits
    // behind ~7 header controls; without this, reaching it takes that many
    // Tab presses on every submission page.
    id: "submission-tabs",
    label: "Skip to submission tabs",
    pattern: /^\/course\/[^/]+\/assignments\/[^/]+\/submissions\/[^/]+/
  }
];

function isVisible(el: HTMLElement) {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

/**
 * Move focus to a landmark. `scroll` (default true) also brings it to the top
 * of the viewport — right for an explicit skip-link/Alt-chord activation, wrong
 * for automatic post-navigation focus management, where scrolling main content
 * to the top edge would push the course header and banners off-screen.
 */
export function focusLandmark(id: string, { scroll = true }: { scroll?: boolean } = {}): boolean {
  // Same id may appear twice (mobile + desktop variants under responsive display).
  // Prefer the visible one. Fall back to the first element with a matching
  // data-landmark attribute, which we use where ids would collide.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(`#${CSS.escape(id)}, [data-landmark="${id}"]`));
  const target = candidates.find(isVisible) ?? candidates[0];
  if (!target) return false;
  if (id === "skip-links") {
    // Our own container: the CSS below reveals a link only while that LINK has
    // focus (the <nav> itself stays visually hidden), so land on the first
    // anchor — focusing the container would show nothing.
    const firstLink = target.querySelector<HTMLElement>("a");
    if (firstLink) {
      firstLink.focus();
      return true;
    }
  }
  if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: !scroll });
  if (scroll) target.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}

export default function SkipNav() {
  const pathname = usePathname() ?? "";
  const targets = [...TARGETS, ...CONTEXTUAL_TARGETS.filter((t) => t.pattern.test(pathname))];

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    if (typeof document === "undefined") return;
    e.preventDefault();
    if (focusLandmark(id)) {
      history.replaceState(null, "", `#${id}`);
      return;
    }
    // Contextual targets are matched on pathname, so a link can be reachable
    // before its landmark has mounted (a submission page still resolving, say).
    // preventDefault has already suppressed the native jump, so returning here
    // would swallow the keystroke entirely and strand focus on the skip link;
    // land on main content instead, which every route renders.
    if (id !== "main-content" && focusLandmark("main-content")) {
      history.replaceState(null, "", "#main-content");
    }
  };

  return (
    <Box
      as="nav"
      aria-label="Skip links"
      id="skip-links"
      position="absolute"
      top="0"
      left="0"
      zIndex="9999"
      _focusWithin={{
        position: "fixed",
        top: "2",
        left: "2",
        bg: "bg",
        boxShadow: "lg",
        p: "2",
        borderRadius: "md",
        borderWidth: "1px",
        borderColor: "border.emphasized"
      }}
    >
      <HStack
        as="ul"
        listStyleType="none"
        gap="2"
        m="0"
        p="0"
        css={{
          "& a": {
            position: "absolute",
            width: "1px",
            height: "1px",
            margin: "-1px",
            padding: "0",
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            whiteSpace: "nowrap",
            border: "0"
          },
          "& a:focus": {
            position: "static",
            width: "auto",
            height: "auto",
            margin: "0",
            padding: "0.5rem 0.75rem",
            overflow: "visible",
            clip: "auto",
            whiteSpace: "normal",
            outline: "2px solid",
            outlineColor: "var(--chakra-colors-orange-500)",
            outlineOffset: "2px",
            borderRadius: "0.25rem",
            background: "var(--chakra-colors-bg)",
            color: "var(--chakra-colors-fg)",
            textDecoration: "underline"
          }
        }}
      >
        {targets.map(({ id, label }) => (
          <li key={id}>
            <a href={`#${id}`} onClick={(e) => handleClick(e, id)}>
              {label}
            </a>
          </li>
        ))}
      </HStack>
    </Box>
  );
}
