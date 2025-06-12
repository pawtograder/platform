import type { Tag, Tag as TagType } from "@/utils/supabase/DatabaseTypes";
import { Button, Tag as ChakraTag, Icon } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { FaX } from "react-icons/fa6";
import { Tooltip } from "./tooltip";

export default function TagDisplay({ tag, showRemove }: { tag: TagType; showRemove?: boolean }) {
  const { mutateAsync: removeTag } = useDelete<Tag>({});
  return (
    <ChakraTag.Root
      colorPalette={tag.color}
      justifyContent={"center"}
      variant="subtle"
      minW="fit-content"
      flexShrink={0}
    >
      <ChakraTag.Label>
        {!tag.visible && "~"}
        {tag.name}
        {showRemove && (
          <Tooltip content="Remove tag">
            <Button
              h={"1em"}
              onClick={() => removeTag({ id: tag.id, resource: "tags" })}
              variant="surface"
              m={0}
              p={0}
              minW={0}
              w={"1em"}
            >
              <Icon as={FaX} h={"0.5em"} w={"0.5em"} />
            </Button>
          </Tooltip>
        )}
      </ChakraTag.Label>
    </ChakraTag.Root>
  );
}
