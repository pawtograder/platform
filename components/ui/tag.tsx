import { Tag, Tag as TagType } from "@/utils/supabase/DatabaseTypes";
import { Button, Tag as ChakraTag, Icon } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { FaX } from "react-icons/fa6";
import { toaster } from "./toaster";
import { Tooltip } from "./tooltip";
import { ReportBlock } from "@/components/bugReport/ReportBlock";

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
        <ReportBlock>{tag.name}</ReportBlock>
        {showRemove && (
          <Tooltip content="Remove tag">
            <Button
              h={"1em"}
              onClick={() =>
                removeTag({ id: tag.id, resource: "tags" }).catch((error: Error) => {
                  toaster.error({ title: "Failed to remove tag", description: error.message });
                })
              }
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
