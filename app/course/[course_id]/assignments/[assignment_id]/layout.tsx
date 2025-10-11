import { AssignmentProvider } from "@/hooks/useAssignment";

export default async function AssignmentLayout({
  params,
  children
}: {
  params: { assignment_id: string };
  children: React.ReactNode;
}) {
  const { assignment_id } = params;
  return <AssignmentProvider assignment_id={Number(assignment_id)}>{children}</AssignmentProvider>;
}
