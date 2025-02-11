import { Box } from "@chakra-ui/react";

const DiscussionLayout = async ({ children, params }: Readonly<{
    children: React.ReactNode;
    params: Promise<{ course_id: string }>
}>) => {
    const { course_id } = await params;

    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <Box minH="100vh">
            {/* mobilenav */}
            <Box p="4">
                {children}
            </Box>
        </Box>
    )
}

export default DiscussionLayout