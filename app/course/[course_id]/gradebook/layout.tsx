import GradebookLayoutClient from "./layout-client";

export const metadata = {
  title: "Gradebook"
};

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  return <GradebookLayoutClient>{children}</GradebookLayoutClient>;
}
