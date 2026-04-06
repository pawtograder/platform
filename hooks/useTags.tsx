"use client";
import { Tag } from "@/utils/supabase/DatabaseTypes";
import { useMemo } from "react";
import { useTagsQuery } from "./course-data";

export function useTagsForProfile(profile_id: string): {
  tags: Tag[];
} {
  const { data: allTags = [] } = useTagsQuery();
  const tags = useMemo(() => allTags.filter((t) => t.profile_id === profile_id), [allTags, profile_id]);
  return { tags };
}

export default function useTags(): {
  tags: Tag[];
} {
  const { data: tags = [] } = useTagsQuery();
  return { tags };
}
