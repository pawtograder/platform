import { Box, Flex } from "@chakra-ui/react";
import HelpRequestList from "./HelpRequestList";
export default function HelpManageLayout({ children, params }: Readonly<{
    children: React.ReactNode;
    params: Promise<{ course_id: string }>
}>) {
    return (
        <Box height="calc(100vh - var(--nav-height))">
             <Flex flex="1">
                <Box w="314px"
                    borderRight="1px solid"
                    borderColor="border.emphasized"
                    pt="4">
                    <HelpRequestList />
                </Box>
                <Box p="4" overflowY="auto"  width="100%" height="calc(100vh - var(--nav-height))">
                    {children}
                </Box>
            </Flex>
        </Box>
    )
}