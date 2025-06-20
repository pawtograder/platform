import { Collapsible, HStack, Icon, Text } from "@chakra-ui/react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";

type Props = {
  icon: React.ElementType;
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
};

/**
 * A collapsible group header component for organizing help requests by category.
 * Displays an icon, title with optional count, and expandable content section.
 */
export const ChatGroupHeader = (props: Props) => {
  const { icon, title, count, children, defaultOpen = true } = props;

  return (
    <Collapsible.Root defaultOpen={defaultOpen}>
      <Collapsible.Trigger asChild>
        <HStack
          color="fg.muted"
          cursor="pointer"
          _hover={{ color: "fg.default" }}
          transition="color 0.2s"
          role="button"
          tabIndex={0}
        >
          <Icon as={icon} />
          <Text fontWeight="semibold" textTransform="uppercase" fontSize="xs">
            {title} {typeof count !== "undefined" && `(${count})`}
          </Text>
          <Collapsible.Context>
            {(collapsible) => <Icon as={collapsible.open ? LuChevronDown : LuChevronRight} fontSize="xs" ml="auto" />}
          </Collapsible.Context>
        </HStack>
      </Collapsible.Trigger>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
};
