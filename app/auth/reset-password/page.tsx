import { setNewPasswordAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { Box, Container, HStack, Heading, Input, Separator, Stack, Text, VStack } from "@chakra-ui/react";
import Logo from "@/components/ui/logo";

type SearchParams = Message & { token_hash?: string };
export default async function ResetPassword(props: { searchParams: Promise<SearchParams> }) {
  const { ...message } = await props.searchParams;
  const token_hash = message.token_hash;
  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <VStack gap="2" textAlign="center" mt="4">
          <Logo width={100} />
          <Heading size="3xl">Pawtograder</Heading>
          <Text color="fg.muted">Your pawsome course companion</Text>
        </VStack>

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">
            Reset Password
          </Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={setNewPasswordAction}>
            <input type="hidden" name="token_hash" value={token_hash} />
            <FormMessage message={message} />
            <Box>
              <Input name="password" placeholder="new password" type="password" aria-label="Sign in password" />
            </Box>
            <Box mt="4">
              <SubmitButton name="action" value="set-new-password" width="100%" pendingText="Setting password…">
                Reset Password
              </SubmitButton>
            </Box>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
