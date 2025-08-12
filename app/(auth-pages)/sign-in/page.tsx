import { signInOrSignUpWithEmailAction, signInWithMicrosoftAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import Logo from "@/components/ui/logo";
import { Box, Container, HStack, Heading, Input, Separator, Stack, Text, VStack } from "@chakra-ui/react";
import { BsMicrosoft } from "react-icons/bs";

type SearchParams = Message & { email?: string; code?: string };
export default async function Login(props: { searchParams: Promise<SearchParams> }) {
  const { email, ...message } = await props.searchParams;

  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <VStack gap="2" textAlign="center" mt="4">
          <Logo width={100} />
          <Heading size="3xl">Pawtograder</Heading>
          <Text color="fg.muted">Your pawsome course companion</Text>
        </VStack>

        <Stack gap="3" colorPalette="gray">
          <form action={signInWithMicrosoftAction}>
            <SubmitButton
              variant="outline"
              aria-label="Sign in with Microsoft (Northeastern Login)"
              pendingText={
                <>
                  <BsMicrosoft />
                  Connecting to Microsoft…
                </>
              }
            >
              <BsMicrosoft />
              Continue with Microsoft (Northeastern Login)
            </SubmitButton>
          </form>
        </Stack>

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">
            or
          </Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={signInOrSignUpWithEmailAction}>
            <FormMessage message={message} />
            <Box>
              <Input name="email" placeholder="name@company.com" aria-label="Sign in email" defaultValue={email} />
              <Input name="password" placeholder="password" type="password" aria-label="Sign in password" />
            </Box>
            <Box mt="4">
              <SubmitButton name="action" value="signin" width="100%" pendingText="Signing in…">
                Sign in with email
              </SubmitButton>
            </Box>
            <HStack gap="4" w="100%" mt="4">
              <SubmitButton variant="outline" name="action" value="signup" flex="1" pendingText="Creating account…">
                Sign up
              </SubmitButton>
              <SubmitButton
                variant="outline"
                name="action"
                value="reset-password"
                flex="1"
                pendingText="Sending reset…"
              >
                Forgot password
              </SubmitButton>
            </HStack>
          </form>
        </Stack>
      </Stack>
    </Container>
  );
}
