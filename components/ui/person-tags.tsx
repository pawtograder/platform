"use client";
import { useTagsForProfile } from "@/hooks/useTags";
import { Flex } from "@chakra-ui/react";
import TagDisplay from "./tag";

export default function PersonTags({ profile_id, showRemove }: { profile_id: string; showRemove?: boolean }) {
  const { tags } = useTagsForProfile(profile_id);
  return (
    <Flex flexDir={"row"} gap={1} flexWrap={"wrap"}>
      {tags.map((tag) => (
        <TagDisplay key={tag.id} tag={tag} showRemove={showRemove} />
      ))}
    </Flex>
  );
}
