import HelpManageLayoutClient from "./layout-client";

export const metadata = {
  title: "Office Hours"
};

export default function HelpManageLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <HelpManageLayoutClient>{children}</HelpManageLayoutClient>;
}
