import { VStack, Container, Stack, Heading, Text } from "@chakra-ui/react";

export default async function ErrorPage({
  searchParams
}: {
  searchParams: Promise<{ error: string; error_code: string; error_description: string }>;
}) {
  const { error, error_description } = await searchParams;
  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <VStack gap="2" textAlign="center" mt="4">
          <Heading size="3xl">Error</Heading>
          {error_description ? (
            <>
              <Text color="fg.muted">{error_description}</Text>
              <Text color="fg.muted">
                Try using your browser&apos;s back button to go back to the previous page, and **TODO** file a bug
                report.
              </Text>
            </>
          ) : (
            <Text color="fg.muted">
              {error}
              <br />
              Try using your browser&apos;s back button to go back to the previous page.
            </Text>
          )}
        </VStack>
      </Stack>
    </Container>
  );
}
