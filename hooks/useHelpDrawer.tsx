"use client";

import { createContext, useContext, useState, useCallback } from "react";

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
