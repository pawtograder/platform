"use client";

import { GradebookProvider } from "@/hooks/useGradebook";

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  return <GradebookProvider>{children}</GradebookProvider>;
}
