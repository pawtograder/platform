import { confirmEmailAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import AuthBrandHeader from "@/components/branding/auth-brand-header";
import { createClient } from "@/utils/supabase/server";
import { Box, Container, HStack, Separator, Stack, Text } from "@chakra-ui/react";

type SearchParams = Message & { token_hash?: string };
export default async function ConfirmEmail(props: { searchParams: Promise<SearchParams> }) {
  const supabase = await createClient();
  //If the user is already logged in, force logout
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (user) {
    await supabase.auth.signOut();
  }
  const { ...message } = await props.searchParams;
  const token_hash = message.token_hash;
  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <AuthBrandHeader />

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">
            Confirm your email
          </Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={confirmEmailAction}>
            <input type="hidden" name="token_hash" value={token_hash} />
            <FormMessage message={message} />
            <Box mt="4">
              <SubmitButton
                name="action"
                value="confirm-email"
                width="100%"
                colorPalette="green"
                disabled={!token_hash}
                pendingText="Confirming…"
              >
                Confirm email and sign in
              </SubmitButton>
            </Box>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
