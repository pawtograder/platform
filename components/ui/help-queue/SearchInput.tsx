import { Input, Group, type InputProps } from "@chakra-ui/react";
import { BsSearch } from "react-icons/bs";

export const SearchInput = (props: InputProps) => {
  return (
    <Group attached>
      <BsSearch />
      <Input placeholder="Search messages..." {...props} />
    </Group>
  );
};
