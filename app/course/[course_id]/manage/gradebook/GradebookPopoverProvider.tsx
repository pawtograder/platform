"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Box, Popover } from "@chakra-ui/react";
import { OverrideScoreForm } from "@/app/course/[course_id]/manage/gradebook/overrideScoreForm";
import { useGradebookColumn, useGradebookColumnStudent } from "@/hooks/useGradebook";

type OpenArgs = {
  targetElement: HTMLElement;
  columnId: number;
  studentId: string;
};

type GradebookPopoverContextType = {
  openAt: (args: OpenArgs) => void;
  close: () => void;
};

const GradebookPopoverContext = createContext<GradebookPopoverContextType | null>(null);

export function useGradebookPopover() {
  const ctx = useContext(GradebookPopoverContext);
  if (!ctx) throw new Error("useGradebookPopover must be used within GradebookPopoverProvider");
  return ctx;
}

export function GradebookPopoverProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<{ columnId: number; studentId: string } | null>(null);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number; height: number } | null>(
    null
  );
  const targetRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const openedAtRef = useRef<number>(0);

  const openAt = useCallback(({ targetElement, columnId, studentId }: OpenArgs) => {
    targetRef.current = targetElement;
    const rect = targetElement.getBoundingClientRect();
    setAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    setSelected({ columnId, studentId });
    // Defer opening to the next tick so the initial click doesn't count as an outside click
    setTimeout(() => {
      openedAtRef.current = Date.now();
      setIsOpen(true);
    }, 0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setSelected(null);
    setAnchorRect(null);
    targetRef.current = null;
  }, []);

  // Reposition on scroll/resize while open, optimized without polling
  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => {
      const el = targetRef.current;
      if (!el || !el.isConnected) {
        // During virtualization or quick re-render, element may briefly disconnect.
        // Avoid closing; we'll attempt to reposition on the next event.
        return;
      }
      const rect = el.getBoundingClientRect();
      setAnchorRect((prev) => {
        if (
          !prev ||
          prev.top !== rect.top ||
          prev.left !== rect.left ||
          prev.width !== rect.width ||
          prev.height !== rect.height
        ) {
          return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        }
        return prev;
      });
    };
    let rafId = 0;
    const scheduleReposition = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(reposition);
    };
    // Initial position
    scheduleReposition();
    // Listen to scroll/resize at capture phase to catch container scrolls too
    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition, true);
    // Observe size changes of the anchor element
    let resizeObserver: ResizeObserver | null = null;
    if (targetRef.current && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleReposition());
      resizeObserver.observe(targetRef.current);
    }
    // Click-away close (we disable built-in closeOnInteractOutside to avoid initial-click auto close)
    const onPointerDown = (e: Event) => {
      // Ignore early outside-clicks right after opening to prevent flicker
      if (Date.now() - openedAtRef.current < 150) return;
      const target = e.target as Node | null;
      const inTrigger = !!(targetRef.current && target && targetRef.current.contains(target));
      const inContent = !!(contentRef.current && target && contentRef.current.contains(target));
      if (!inTrigger && !inContent) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", scheduleReposition, true);
      window.removeEventListener("resize", scheduleReposition, true);
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeObserver) resizeObserver.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isOpen, close]);

  const contextValue = useMemo<GradebookPopoverContextType>(() => ({ openAt, close }), [openAt, close]);

  function SelectedPopoverContent({ columnId, studentId }: { columnId: number; studentId: string }) {
    const column = useGradebookColumn(columnId);
    const studentGradebookColumn = useGradebookColumnStudent(columnId, studentId);
    return (
      <Popover.Content w="lg" maxH="80vh" bg={column?.score_expression ? "bg.warning" : "bg.panel"}>
        <Popover.Arrow />
        <Popover.Body p={1} m={2}>
          {studentGradebookColumn && (
            <OverrideScoreForm
              studentGradebookColumn={studentGradebookColumn}
              onSuccess={() => setIsOpen(false)}
              isAutoCalculated={Boolean(column?.score_expression !== null || column?.external_data !== null)}
              showWarning={Boolean(column?.score_expression !== null)}
            />
          )}
        </Popover.Body>
      </Popover.Content>
    );
  }

  return (
    <GradebookPopoverContext.Provider value={contextValue}>
      {children}
      {/* Fixed-positioned invisible anchor that the popover uses as its trigger/reference */}
      <Popover.Root
        open={isOpen}
        onOpenChange={(d) => setIsOpen(d.open)}
        closeOnInteractOutside={false}
        positioning={{ placement: "bottom", strategy: "fixed" }}
      >
        <Popover.Trigger asChild>
          <Box
            position="fixed"
            top={anchorRect ? `${anchorRect.top + anchorRect.height}px` : "-10000px"}
            left={anchorRect ? `${anchorRect.left}px` : "-10000px"}
            width={anchorRect ? `${anchorRect.width}px` : "0px"}
            height="0px"
            zIndex={10000}
            pointerEvents="none"
            aria-hidden
          />
        </Popover.Trigger>
        {isOpen && selected ? (
          <Popover.Positioner>
            <Box ref={contentRef} zIndex={90000}>
              <SelectedPopoverContent columnId={selected.columnId} studentId={selected.studentId} />
            </Box>
          </Popover.Positioner>
        ) : null}
      </Popover.Root>
    </GradebookPopoverContext.Provider>
  );
}
