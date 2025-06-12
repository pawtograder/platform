import useTags from "@/hooks/useTags";
import type { Tag } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useState } from "react";
import TagDisplay from "./tag";

interface TagOption {
  label: string;
  value: string;
  tag: Tag;
}

export default function InlineRemoveTag({
  removeTag,
  tagOptions
}: {
  removeTag: (tagName: string, tagColor: string, tagVisibility: boolean) => void;
  tagOptions: Tag[];
}) {
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);
  const tags = useTags();

  /**
   * - tag options contains the shared tags between selected profiles
   * - box to select existing shared tags to remove multi react select
   */
  return (
    <Flex gap="5px" minWidth="150" alignItems={"center"} direction={"row"}>
      <Select<TagOption>
        isMulti={false}
        options={tagOptions.map((tag) => ({ label: tag.name, value: tag.id, tag: tag }))}
        value={selectedTag ? { label: selectedTag.name, value: selectedTag.id, tag: selectedTag } : null}
        onChange={(option) => {
          if (option) {
            const tag = option.tag ?? tags.tags.find((t) => t.id == option.value);
            if (tag) {
              setSelectedTag(tag);
            }
          }
        }}
        chakraStyles={{
          container: (provided) => ({
            ...provided,
            minWidth: "150px",
            width: "100%",
            display: "flex",
            flexDir: "row"
          })
        }}
        components={{
          Option: ({ data, ...props }) => (
            <Box {...props.innerProps} p="4px 8px" cursor="pointer" _hover={{ bg: "gray.100" }}>
              <TagDisplay tag={data.tag} />
            </Box>
          )
        }}
        placeholder="Select tag..."
        size="sm"
      />{" "}
      <Button
        disabled={!selectedTag}
        onClick={() => {
          if (selectedTag) {
            removeTag(selectedTag.name, selectedTag.color, selectedTag.visible);
          }
          // call remove tag here
        }}
      >
        Submit
      </Button>
    </Flex>
  );
}
