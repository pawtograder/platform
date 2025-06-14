import { Box, Flex } from "@chakra-ui/react";
import DiscussionThreadList from "./DiscussionThreadList";

const DiscussionLayout = async ({ children }: Readonly<{ children: React.ReactNode }>) => {
  return (
    <Box>
      <Flex flex="1" wrap={{ base: "wrap", md: "nowrap" }}>
        <Box
          width={{ base: "100%", md: "314px" }}
          borderRightWidth={{ base: "0", md: "1px" }}
          borderBottomWidth={{ base: "1px", md: "0" }}
          borderStyle="solid"
          borderColor="border.emphasized"
          pt="4"
        >
          <DiscussionThreadList />
        </Box>
        <Box p={{ base: "4", md: "8" }} width="100%">
          {children}
        </Box>
      </Flex>
    </Box>
  );
};

export default DiscussionLayout;
