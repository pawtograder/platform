import GradeLayoutClient from "./layout-client";

export const metadata = {
  title: "Grade Submission"
};

export default function GradeLayout({ children }: { children: React.ReactNode }) {
  return <GradeLayoutClient>{children}</GradeLayoutClient>;
}
