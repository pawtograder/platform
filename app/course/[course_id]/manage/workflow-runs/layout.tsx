import WorkflowRunsLayoutClient from "./layout-client";

export const metadata = {
  title: "Workflow Runs"
};

export default function WorkflowRunsLayout({ children }: { children: React.ReactNode }) {
  return <WorkflowRunsLayoutClient>{children}</WorkflowRunsLayoutClient>;
}
