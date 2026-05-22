"use client";

import { GradebookProvider } from "@/hooks/useGradebook";

export default function GradebookLayoutClient({ children }: { children: React.ReactNode }) {
  return <GradebookProvider>{children}</GradebookProvider>;
}
