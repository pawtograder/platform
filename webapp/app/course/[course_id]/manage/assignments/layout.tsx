import { Box } from "@chakra-ui/react";

export default function ManageAssignmentsLayout({ children }: { children: React.ReactNode }) {
    return <Box height="calc(100vh - var(--nav-height))" overflowY="auto">
        {children}
    </Box>
}