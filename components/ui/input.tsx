import * as React from "react";
import { Input as ChakraInput, type InputProps as ChakraInputProps } from "@chakra-ui/react";

const Input = React.forwardRef<HTMLInputElement, ChakraInputProps>(({ ...props }, ref) => {
  return (
    <ChakraInput
      ref={ref}
      h="40px"
      w="full"
      borderRadius="md"
      border="1px"
      borderColor="gray.300"
      bg="white"
      px={3}
      py={2}
      fontSize={{ base: "16px", md: "sm" }}
      transition="border-color 0.2s, box-shadow 0.2s"
      placeholder={""}
      _placeholder={{
        color: "gray.500"
      }}
      _focusVisible={{
        outline: "2px solid",
        outlineColor: "blue.500",
        outlineOffset: "2px",
        borderColor: "blue.500"
      }}
      _disabled={{
        cursor: "not-allowed",
        opacity: 0.5
      }}
      _dark={{
        bg: "gray.800",
        borderColor: "gray.600",
        color: "white",
        _placeholder: {
          color: "gray.400"
        }
      }}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
