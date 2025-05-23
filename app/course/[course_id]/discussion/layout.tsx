import { Box, Flex } from "@chakra-ui/react";
import DiscussionThreadList from "./DiscussionThreadList";
const DiscussionLayout = async ({ children }: Readonly<{ children: React.ReactNode }>) => {
  return (
    <Box>
      <Flex flex="1">
        <Box w="314px" borderRight="1px solid" borderColor="border.emphasized" pt="4">
          <DiscussionThreadList />
        </Box>
        <Box p="8" width="100%">
          {children}
        </Box>
      </Flex>
    </Box>
  );
};

export default DiscussionLayout;
