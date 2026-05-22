import FilesView from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/files/page";

export const metadata = {
  title: "Files"
};

export default function GradeFilesView() {
  return <FilesView />;
}
