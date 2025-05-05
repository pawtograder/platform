import { Box, Flex, Text } from "@chakra-ui/react";

export type Message =
  | { success: string }
  | { error: string; error_code?: string; error_description?: string }
  | { message: string };

export function FormMessage({ message }: { message: Message }) {
  return (
    <Flex flexDirection="column" gap="2" w="full" maxW="md" textStyle="sm">
      {"success" in message && (
        <Box borderLeft="4px solid" borderColor="border.success" pl="4" bg="bg.success" mb="4">
          <Text colorPalette="green">{message.success}</Text>
        </Box>
      )}
      {"error" in message && (
        <Box borderLeft="4px solid" borderColor="border.error" pl="4" bg="bg.error" mb="4">
          <Text fontWeight="bold" colorPalette="red">
            Error: {message.error}
          </Text>
          {message.error_code && (
            <Text fontWeight="bold" colorPalette="red">
              Error code: {message.error_code}
            </Text>
          )}
          {message.error_description && <Text colorPalette="red">{message.error_description}</Text>}
        </Box>
      )}
      {"message" in message && (
        <Box borderLeft="4px solid" borderColor="border.gray" pl="4" bg="bg.gray" mb="4">
          <Text colorPalette="gray">{message.message}</Text>
        </Box>
      )}
    </Flex>
  );
}
