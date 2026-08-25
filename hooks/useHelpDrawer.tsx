"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useState } from "react";

// Lazily loaded: the drawer pulls in the office-hours and discussion controllers, and
// most page views never open it.
const HelpDrawer = dynamic(() => import("@/components/help-queue/help-drawer"), {
  ssr: false
});

interface HelpDrawerContextType {
  isOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
}

const HelpDrawerContext = createContext<HelpDrawerContextType | undefined>(undefined);

export function HelpDrawerProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openDrawer = useCallback(() => setIsOpen(true), []);
  const closeDrawer = useCallback(() => setIsOpen(false), []);
  const toggleDrawer = useCallback(() => setIsOpen((prev) => !prev), []);

  return (
    <HelpDrawerContext.Provider value={{ isOpen, openDrawer, closeDrawer, toggleDrawer }}>
      {children}
      {/*
        Mounted here, once, so every opener has a consumer.

        The drawer used to be mounted by FloatingHelpRequestWidget and
        OfficeHoursStatusCard, both of which render conditionally: the widget returns null
        for staff, for read-only view-as, and on office-hours pages, and mounted the drawer
        only in its "no active request" branch, while the status card only appears on the
        student dashboard when no calendar is configured. Any other opener — the submission
        page's "Ask For Help" button — therefore flipped context state that nothing
        rendered, so it did nothing at all for staff and for students who already had an
        active request. Owning the mount here means openDrawer() always opens something.
      */}
      {isOpen && <HelpDrawer isOpen={isOpen} onClose={closeDrawer} />}
    </HelpDrawerContext.Provider>
  );
}

export function useHelpDrawer() {
  const context = useContext(HelpDrawerContext);
  if (!context) {
    throw new Error("useHelpDrawer must be used within HelpDrawerProvider");
  }
  return context;
}
