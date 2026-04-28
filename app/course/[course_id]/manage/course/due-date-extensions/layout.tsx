import DueDateExtensionsLayoutClient from "./layout-client";

export const metadata = {
  title: "Due Date Extensions"
};

export default function DueDateExtensionsLayout({ children }: { children: React.ReactNode }) {
  return <DueDateExtensionsLayoutClient>{children}</DueDateExtensionsLayoutClient>;
}
