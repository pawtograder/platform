import { Stack, StackProps } from "@chakra-ui/react";

export const ChatMessages = (props: StackProps) => {
  return (
    <Stack
      maxW="prose"
      overflowY="auto"
      mx="auto"
      paddingX={{ base: "4", md: "0" }}
      // divide={
      //   <Box marginLeft="14!">
      //     <StackDivider />
      //   </Box>
      // }
      spaceY="10"
      {...props}
    />
  );
};
