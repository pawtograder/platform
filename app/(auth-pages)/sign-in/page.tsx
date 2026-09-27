import { signInOrSignUpWithEmailAction, signInWithSSOAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import AuthBrandHeader from "@/components/branding/auth-brand-header";
import SsoIcon from "@/components/branding/sso-icon";
import { Box, Container, HStack, Input, Separator, Stack, Text } from "@chakra-ui/react";
import { isSignupsEnabled } from "@/lib/features";
import { getBranding } from "@/lib/branding";

export async function generateMetadata() {
  return {
    title: `Sign in · ${getBranding().name}`
  };
}

type SearchParams = Message & { email?: string; code?: string; redirect?: string };
export default async function Login(props: { searchParams: Promise<SearchParams> }) {
  const { email, redirect: redirectParam, ...message } = await props.searchParams;
  const redirectSafe = redirectParam && redirectParam.startsWith("/") ? redirectParam : undefined;
  const enableSignup = isSignupsEnabled();
  const ssoProviders = getBranding().ssoProviders;

  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <AuthBrandHeader />

        {ssoProviders.length > 0 && (
          <>
            <Stack gap="3" colorPalette="gray">
              {ssoProviders.map((sso, index) => (
                <form key={`${sso.provider}-${index}`} action={signInWithSSOAction}>
                  {redirectSafe && <input type="hidden" name="redirect" value={redirectSafe} />}
                  <input type="hidden" name="sso_index" value={index} />
                  <SubmitButton
                    variant="outline"
                    width="100%"
                    aria-label={sso.label}
                    pendingText={
                      <>
                        <SsoIcon name={sso.icon} />
                        Connecting…
                      </>
                    }
                  >
                    <SsoIcon name={sso.icon} />
                    {sso.label}
                  </SubmitButton>
                </form>
              ))}
            </Stack>

            <HStack gap="6" w="100%">
              <Separator flex="1" />
              <Text flexShrink="0" textStyle="sm" color="fg.muted">
                or
              </Text>
              <Separator flex="1" />
            </HStack>
          </>
        )}

        <Stack gap="4">
          <form action={signInOrSignUpWithEmailAction}>
            <FormMessage message={message} />
            <Box>
              <Input name="email" placeholder="name@company.com" aria-label="Sign in email" defaultValue={email} />
              <Input name="password" placeholder="password" type="password" aria-label="Sign in password" />
            </Box>
            {redirectSafe && <input type="hidden" name="redirect" value={redirectSafe} />}
            <Box mt="4">
              <SubmitButton name="action" value="signin" width="100%" pendingText="Signing in…">
                Sign in with email
              </SubmitButton>
            </Box>
            <HStack gap="4" w="100%" mt="4">
              {enableSignup && (
                <SubmitButton variant="outline" name="action" value="signup" flex="1" pendingText="Creating account…">
                  Sign up
                </SubmitButton>
              )}
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
