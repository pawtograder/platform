"use client";

import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Link, useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

export default function HelpPage() {
  const { course_id } = useParams();
  const queues = useList<HelpQueue>({
    resource: "help_queues",
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });
  if (queues.isLoading) {
    return <div>Loading...</div>;
  }
  if (queues.error) {
    return <div>Error: {queues.error.message}</div>;
  }
  if (queues.data?.data.length === 1) {
    //Directly enter the queue
    return redirect(`/course/${course_id}/help/${queues.data?.data[0].id}`);
  }
  return (
    <div>
      Help
      {queues.data?.data.map((queue) => (
        <div key={queue.id}>
          <h2>{queue.name}</h2>
          <Link to={`/course/${course_id}/help/${queue.id}`}>Enter</Link>
        </div>
      ))}
    </div>
  );
}
