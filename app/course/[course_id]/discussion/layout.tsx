import DiscussionLayoutClient from "./layout-client";

export const metadata = {
  title: "Discussion"
};

export default function DiscussionLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <DiscussionLayoutClient>{children}</DiscussionLayoutClient>;
}
