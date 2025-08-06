import { confirmEmailAction } from "@/app/actions";
import { FormMessage, type Message } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import Logo from "@/components/ui/logo";
import { createClient } from "@/utils/supabase/server";
import { Box, Container, HStack, Heading, Separator, Stack, Text, VStack } from "@chakra-ui/react";

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
        <VStack gap="2" textAlign="center" mt="4">
          <Logo width={100} />
          <Heading size="3xl">Pawtograder</Heading>
          <Text color="fg.muted">Your pawsome course companion</Text>
        </VStack>

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
              <Button
                type="submit"
                name="action"
                value="confirm-email"
                width="100%"
                colorPalette="green"
                disabled={!token_hash}
              >
                Confirm email and sign in
              </Button>
            </Box>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
