import { Tag } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";

export default function useTags(): {
  tags: Tag[];
} {
  const { course_id } = useParams();
  const { data: tags, isLoading: tagsLoading } = useList<Tag>({
    resource: "tags",
    queryOptions: {
      staleTime: Infinity
    },
    pagination: {
      pageSize: 1000
    },
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id as string) }],
    liveMode: "auto"
  });
  if (tagsLoading) {
    return {
      tags: []
    };
  }
  return {
    tags: tags?.data || []
  };
}
