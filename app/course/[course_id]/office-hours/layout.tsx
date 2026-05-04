import OfficeHoursLayoutClient from "./layout-client";

export const metadata = {
  title: "Office Hours"
};

export default function OfficeHoursLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <OfficeHoursLayoutClient>{children}</OfficeHoursLayoutClient>;
}
