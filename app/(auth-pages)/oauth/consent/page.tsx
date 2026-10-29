import AuthBrandHeader from "@/components/branding/auth-brand-header";
import { FormMessage } from "@/components/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { getBranding } from "@/lib/branding";
import { getAuthorizationDetails, isAutoApproved, OAuthServerError } from "@/lib/oauthServer";
import { createClient } from "@/utils/supabase/server";
import { Box, Container, HStack, List, Stack, Text } from "@chakra-ui/react";
import { redirect } from "next/navigation";
import { decideOAuthConsentAction } from "./actions";

export async function generateMetadata() {
  return {
    title: `Authorize access · ${getBranding().name}`
  };
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm that you are signed in to your account",
  email: "See your email address",
  profile: "See your name",
  phone: "See your phone number"
};

type SearchParams = { authorization_id?: string; error?: string };

export default async function OAuthConsent(props: { searchParams: Promise<SearchParams> }) {
  const { authorization_id: authorizationId, error } = await props.searchParams;
  const brandName = getBranding().name;

  if (!authorizationId) {
    return (
      <Container maxW="md" py={{ base: "12", md: "24" }}>
        <Stack gap="6">
          <AuthBrandHeader />
          <FormMessage message={{ error: "This sign-in link is missing its authorization request." }} />
        </Stack>
      </Container>
    );
  }

  const consentPath = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  if (!claims?.claims || !session) {
    redirect(`/sign-in?redirect=${encodeURIComponent(consentPath)}`);
  }

  let details;
  try {
    details = await getAuthorizationDetails(session.access_token, authorizationId);
  } catch (e) {
    const message =
      e instanceof OAuthServerError && e.status === 404
        ? "This sign-in request has expired or was already used. Go back to the app and try again."
        : "Could not load this sign-in request.";
    return (
      <Container maxW="md" py={{ base: "12", md: "24" }}>
        <Stack gap="6">
          <AuthBrandHeader />
          <FormMessage message={{ error: message }} />
        </Stack>
      </Container>
    );
  }

  if (isAutoApproved(details)) {
    redirect(details.redirect_url);
  }

  const scopes = details.scope.split(/\s+/).filter(Boolean);

  return (
    <Container maxW="md" py={{ base: "12", md: "24" }}>
      <Stack gap="6">
        <AuthBrandHeader />
        {error && <FormMessage message={{ error }} />}
        <Stack gap="2">
          <Text as="h1" textStyle="xl" fontWeight="semibold">
            {details.client.name} wants to use your {brandName} account
          </Text>
          <Text color="fg.muted" textStyle="sm">
            Signed in as {details.user.email}
          </Text>
        </Stack>
        <Box>
          <Text textStyle="sm" mb="2">
            This will let {details.client.name}:
          </Text>
          <List.Root ps="5" textStyle="sm" gap="1">
            {scopes.map((scope) => (
              <List.Item key={scope}>{SCOPE_DESCRIPTIONS[scope] ?? scope}</List.Item>
            ))}
          </List.Root>
        </Box>
        <form action={decideOAuthConsentAction}>
          <input type="hidden" name="authorization_id" value={details.authorization_id} />
          <HStack gap="4">
            <SubmitButton name="decision" value="deny" variant="outline" flex="1" pendingText="Denying…">
              Deny
            </SubmitButton>
            <SubmitButton name="decision" value="approve" flex="1" pendingText="Authorizing…">
              Authorize
            </SubmitButton>
          </HStack>
        </form>
      </Stack>
    </Container>
  );
}
