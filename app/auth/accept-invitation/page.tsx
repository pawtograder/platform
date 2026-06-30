import { acceptInvitationAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { Box, Container, HStack, Input, Separator, Stack, Text } from "@chakra-ui/react";
import AuthBrandHeader from "@/components/branding/auth-brand-header";
import { getBranding } from "@/lib/branding";
import { createClient } from "@/utils/supabase/server";

type SearchParams = Message & { token_hash?: string };
export default async function AcceptInvitation(props: { searchParams: Promise<SearchParams> }) {
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
  const branding = getBranding();
  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <AuthBrandHeader />

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">
            Choose a password to join {branding.name}
          </Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={acceptInvitationAction}>
            <input type="hidden" name="token_hash" value={token_hash} />
            <FormMessage message={message} />
            <Box>
              <Input name="password" placeholder="new password" type="password" aria-label="Sign in password" />
            </Box>
            <Box mt="4">
              <SubmitButton name="action" value="set-new-password" width="100%" pendingText="Accepting…">
                Accept Invitation
              </SubmitButton>
            </Box>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
