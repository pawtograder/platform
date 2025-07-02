import { Input, InputGroup, InputProps } from "@chakra-ui/react";
import { BsSearch } from "react-icons/bs";

export type SearchInputProps = InputProps & {
  value?: string;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export const SearchInput = ({ value, onChange, ...props }: SearchInputProps) => {
  return (
    <InputGroup startElement={<BsSearch />}>
      <Input placeholder="Search messages..." value={value} onChange={onChange} {...props} />
    </InputGroup>
  );
};
