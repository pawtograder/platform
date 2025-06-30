"use client";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";

const NoSSRMeeting = dynamic(() => import("./meeting"), { ssr: false });

export default function HelpRequestMeetPage() {
  const { course_id } = useParams();

  return (
    <ModerationBanNotice classId={Number(course_id)}>
      <NoSSRMeeting />
    </ModerationBanNotice>
  );
}
