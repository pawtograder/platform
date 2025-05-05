import { Input, Group, InputProps } from "@chakra-ui/react";
import { BsSearch } from "react-icons/bs";
import { InputGroup } from "../input-group";

export const SearchInput = (props: InputProps) => {
  return (
    <Group attached>
      <BsSearch />
      <Input placeholder="Search messages..." {...props} />
    </Group>
  );
};
