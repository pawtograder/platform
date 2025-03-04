import { Box, Flex, Heading, Stack, VStack } from "@chakra-ui/react";
import DiscussionThreadList from "./DiscussionThreadList";
const DiscussionLayout = async ({ children, params }: Readonly<{
    children: React.ReactNode;
    params: Promise<{ course_id: string }>
}>) => {
    const { course_id } = await params;

    return (
        <Box>
            <Flex flex="1">
                <Box w="314px"
                    borderRight="1px solid"
                    borderColor="border.emphasized"
                    pt="4">
                    <DiscussionThreadList />
                </Box>
                <Box p="8" width="100%">
                    {children}
                </Box>
            </Flex>
        </Box>
    )
}

export default DiscussionLayout