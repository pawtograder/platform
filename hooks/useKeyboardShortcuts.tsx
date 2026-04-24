"use client";

import ShortcutsHelpDialog from "@/components/ui/shortcuts-help-dialog";
import { focusLandmark } from "@/components/ui/skip-nav";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { COURSE_FEATURES, type CourseFeatureName } from "@/lib/courseFeatures";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { useRouter } from "next/navigation";
import * as React from "react";

const CHORD_TIMEOUT_MS = 1500;

type GoEntry = { key: string; label: string; path: (id: number) => string; feature?: CourseFeatureName };

const GO_TABLE: GoEntry[] = [
  { key: "d", label: "Course dashboard", path: (id) => `/course/${id}` },
  { key: "a", label: "Assignments", path: (id) => `/course/${id}/assignments` },
  {
    key: "o",
    label: "Office Hours",
    path: (id) => `/course/${id}/office-hours`,
    feature: COURSE_FEATURES.OFFICE_HOURS
  },
  { key: "g", label: "Gradebook", path: (id) => `/course/${id}/gradebook`, feature: COURSE_FEATURES.GRADEBOOK },
  { key: "c", label: "Discussion", path: (id) => `/course/${id}/discussion`, feature: COURSE_FEATURES.DISCUSSION },
  { key: "f", label: "Flashcards", path: (id) => `/course/${id}/flashcards`, feature: COURSE_FEATURES.FLASHCARDS },
  { key: "p", label: "Polls", path: (id) => `/course/${id}/polls`, feature: COURSE_FEATURES.POLLS },
  { key: "s", label: "Surveys", path: (id) => `/course/${id}/surveys`, feature: COURSE_FEATURES.SURVEYS },
  { key: "h", label: "GitHub Help", path: (id) => `/course/${id}/github-help` },
  { key: "n", label: "Notifications", path: (id) => `/course/${id}/notifications` }
];

type LandmarkEntry = { key: string; landmarkId: string; label: string };

const LANDMARK_TABLE: LandmarkEntry[] = [
  { key: "m", landmarkId: "main-content", label: "Jump to main content" },
  { key: "n", landmarkId: "primary-nav", label: "Jump to navigation" },
  { key: "u", landmarkId: "user-menu", label: "Jump to user menu" },
  { key: "k", landmarkId: "skip-links", label: "Show skip links" }
];

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = t.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
  return false;
}

type ResolvedGoEntry = { key: string; label: string; path: string; feature?: CourseFeatureName };

type ShortcutsContextValue = {
  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
  goShortcuts: ResolvedGoEntry[];
  landmarkShortcuts: LandmarkEntry[];
};

const ShortcutsContext = React.createContext<ShortcutsContextValue | null>(null);

export function useKeyboardShortcuts() {
  const ctx = React.useContext(ShortcutsContext);
  if (!ctx) throw new Error("useKeyboardShortcuts must be used within KeyboardShortcutsProvider");
  return ctx;
}

export function KeyboardShortcutsProvider({ children, courseId }: { children: React.ReactNode; courseId: number }) {
  const router = useRouter();
  const { role } = useClassProfiles();
  const course = role.classes as CourseWithFeatures;

  const [helpOpen, setHelpOpen] = React.useState(false);
  const openHelp = React.useCallback(() => setHelpOpen(true), []);
  const closeHelp = React.useCallback(() => setHelpOpen(false), []);

  const isFeatureEnabled = React.useCallback(
    (name?: CourseFeatureName) => {
      if (!name) return true;
      const flag = course.features?.find((f) => f.name === name);
      return flag ? flag.enabled : true;
    },
    [course.features]
  );

  const enabledGoShortcuts = React.useMemo(
    () =>
      GO_TABLE.filter((g) => isFeatureEnabled(g.feature)).map((g) => ({
        ...g,
        path: g.path(courseId)
      })),
    [courseId, isFeatureEnabled]
  );

  const goMap = React.useMemo(() => {
    const m = new Map<string, string>();
    enabledGoShortcuts.forEach((g) => m.set(g.key, g.path));
    return m;
  }, [enabledGoShortcuts]);

  const pendingChordRef = React.useRef<{ kind: "g" | null; expires: number } | null>(null);

  React.useEffect(() => {
    function clearPending() {
      pendingChordRef.current = null;
    }

    function focusSearch(): boolean {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-shortcut="search"]'));
      const visible = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!visible) return false;
      visible.focus({ preventScroll: false });
      if (visible instanceof HTMLInputElement || visible instanceof HTMLTextAreaElement) {
        visible.select();
      }
      return true;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;

      const editable = isEditableTarget(e.target);

      // Esc cancels pending chord and closes help, even from non-editable; do not block default browser Esc otherwise.
      if (e.key === "Escape") {
        if (pendingChordRef.current) {
          clearPending();
        }
        return;
      }

      // Don't fire shortcuts while typing in form fields.
      if (editable) return;

      // Disallow Ctrl/Meta combinations (don't hijack browser shortcuts).
      // Alt is allowed only for landmark jumps below.
      if (e.ctrlKey || e.metaKey) return;

      // Alt-chord landmark jumps (Alt+letter, no Ctrl/Meta).
      if (e.altKey) {
        if (e.shiftKey) return;
        const k = e.key.toLowerCase();
        const landmark = LANDMARK_TABLE.find((l) => l.key === k);
        if (landmark) {
          e.preventDefault();
          focusLandmark(landmark.landmarkId);
        }
        return;
      }

      // ? opens help (Shift+/ on US keyboards). Use e.key === "?".
      if (e.key === "?") {
        e.preventDefault();
        clearPending();
        openHelp();
        return;
      }

      // s or / focuses search if present.
      if (!e.shiftKey && (e.key === "s" || e.key === "/")) {
        // s also starts the chord for surveys, but the chord requires a prior `g`.
        // Without a pending chord, treat s as search-focus.
        const pending = pendingChordRef.current;
        if (!pending && focusSearch()) {
          e.preventDefault();
          return;
        }
      }

      const k = e.key.toLowerCase();

      // Continuing a g-chord
      const pending = pendingChordRef.current;
      if (pending && pending.kind === "g" && Date.now() < pending.expires) {
        clearPending();
        const path = goMap.get(k);
        if (path) {
          e.preventDefault();
          router.push(path);
        }
        return;
      }

      // Starting a g-chord
      if (k === "g" && !e.shiftKey) {
        e.preventDefault();
        pendingChordRef.current = { kind: "g", expires: Date.now() + CHORD_TIMEOUT_MS };
        // Schedule cleanup after timeout
        window.setTimeout(() => {
          const p = pendingChordRef.current;
          if (p && Date.now() >= p.expires) clearPending();
        }, CHORD_TIMEOUT_MS + 50);
        return;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [goMap, router, openHelp]);

  const value = React.useMemo<ShortcutsContextValue>(
    () => ({
      helpOpen,
      openHelp,
      closeHelp,
      goShortcuts: enabledGoShortcuts,
      landmarkShortcuts: LANDMARK_TABLE
    }),
    [helpOpen, openHelp, closeHelp, enabledGoShortcuts]
  );

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      <ShortcutsHelpDialog />
    </ShortcutsContext.Provider>
  );
}
