"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { focusLandmark } from "@/components/ui/skip-nav";

/**
 * Post-navigation focus management (WCAG 2.4.3). When a client-side route
 * change unmounts the element that had keyboard focus (e.g. SurveyJS's
 * Complete button redirecting to the surveys list), focus falls back to
 * <body> and the next Tab restarts from the top of the page. Move it to the
 * main-content landmark instead so keyboard/AT users resume from the new
 * page's content.
 *
 * Deliberately does nothing when focus survived the navigation — links in
 * persistent layouts (course nav, submission tab bar) keep focus so users
 * can continue tabbing from where they were — and on initial page load,
 * where the browser's default focus behavior is correct.
 */
export default function RouteFocusReset() {
  const pathname = usePathname();
  const isInitialLoad = useRef(true);

  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      return;
    }
    // The new page's own effects (including any autofocus) have already run:
    // child effects fire before this persistent-layout effect. Only step in
    // when the navigation genuinely dropped focus.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusLandmark("main-content");
  }, [pathname]);

  return null;
}
