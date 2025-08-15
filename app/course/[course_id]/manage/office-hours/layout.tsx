import { Box, Flex } from "@chakra-ui/react";
import HelpRequestList from "./helpRequestList";
export default function HelpManageLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Box>
      <Flex flex="1" direction={{ base: "column", md: "row" }} minH={0}>
        <Box
          w={{ base: "100%", md: "314px" }}
          borderRightWidth={{ base: "0px", md: "1px" }}
          borderBottomWidth={{ base: "1px", md: "0px" }}
          borderColor="border.emphasized"
          pt={{ base: "3", md: "4" }}
          flexShrink={0}
        >
          <HelpRequestList />
        </Box>
        <Box
          p={{ base: "3", md: "4" }}
          overflowY={{ base: "visible", md: "auto" }}
          width="100%"
          height={{ base: "auto", md: "100vh" }}
          minH={0}
        >
          {children}
        </Box>
      </Flex>
    </Box>
  );
}
