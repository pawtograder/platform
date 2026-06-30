import Logo from "@/components/ui/logo";
import { getBranding } from "@/lib/branding";
import { Heading, Text, VStack } from "@chakra-ui/react";

/**
 * Wordmark shown at the top of the auth screens (sign-in, magic link, confirm,
 * reset, accept invitation). Server component so it can read the deployment
 * branding directly; the `Logo` it renders picks up the same branding on the
 * client via context.
 */
export default function AuthBrandHeader() {
  const branding = getBranding();
  return (
    <VStack gap="2" textAlign="center" mt="4">
      <Logo width={100} />
      <Heading size="3xl" color="colorPalette.fg">
        {branding.name}
      </Heading>
      <Text color="fg.muted">{branding.tagline}</Text>
    </VStack>
  );
}
