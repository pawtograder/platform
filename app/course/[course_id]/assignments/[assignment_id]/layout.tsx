"use client";

import { useParams } from "next/navigation";
import { AssignmentProvider } from "@/hooks/useAssignment";

export default function AssignmentLayout({ children }: { children: React.ReactNode }) {
  const { assignment_id } = useParams();
  return <AssignmentProvider assignment_id={Number(assignment_id)}>{children}</AssignmentProvider>;
}
