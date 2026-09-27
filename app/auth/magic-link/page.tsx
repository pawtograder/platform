import { signInWithMagicLinkAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import AuthBrandHeader from "@/components/branding/auth-brand-header";
import { Box, Container, HStack, Separator, Stack, Text } from "@chakra-ui/react";

type SearchParams = Message & { token_hash?: string };
export default async function ResetPassword(props: { searchParams: Promise<SearchParams> }) {
  const { ...message } = await props.searchParams;
  const token_hash = message.token_hash;
  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <AuthBrandHeader />

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">
            Sign in by link
          </Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={signInWithMagicLinkAction}>
            <input type="hidden" name="token_hash" value={token_hash} />
            <FormMessage message={message} />
            <Box mt="4">
              <SubmitButton
                name="action"
                value="sign-in-with-magic-link"
                width="100%"
                colorPalette="green"
                disabled={!token_hash}
                pendingText="Signing in…"
              >
                Sign in with magic link
              </SubmitButton>
            </Box>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
