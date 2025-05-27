import { Tag } from "@/utils/supabase/DatabaseTypes";
import { useEffect, useState } from "react";
import { useCourseController } from "./useCourseController";

export function useTagsForProfile(profile_id: string): {
  tags: Tag[];
} {
  const courseController = useCourseController();
  const [tags, setTags] = useState<Tag[]>([]);
  useEffect(() => {
    const { unsubscribe, data } = courseController.getTagsForProfile(profile_id, setTags);
    setTags(data ?? []);
    return () => unsubscribe();
  }, [courseController, profile_id]);
  return { tags };
}

export default function useTags(): {
  tags: Tag[];
} {
  const courseController = useCourseController();
  const [tags, setTags] = useState<Tag[]>([]);
  useEffect(() => {
    const { unsubscribe, data } = courseController.listTags(setTags);
    setTags(data);
    return () => unsubscribe();
  }, [courseController]);
  return { tags };
}
