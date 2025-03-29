import { signInOrSignUpWithEmailAction, signInWithMicrosoftAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { useColorMode } from "@/components/ui/color-mode";
import Logo from "@/components/ui/logo";
import {
  Box,
  Container,
  HStack,
  Heading,
  Input,
  Separator,
  Stack,
  Text,
  VStack
} from '@chakra-ui/react';
import { BsMicrosoft } from 'react-icons/bs';


export default async function Login(props: { searchParams: Promise<Message> }) {
  const message = await props.searchParams;
  return (
    <Container maxW="md" py={{ base: '12', md: '24' }}>
      <Stack gap="6">

        <VStack gap="2" textAlign="center" mt="4">
          <Logo width={100} />
          <Heading size="3xl">Pawtograder</Heading>
          <Text color="fg.muted">
            Your pawsome course companion
          </Text>
        </VStack>

        <Stack gap="3" colorPalette="gray">
          <Button variant="outline" onClick={signInWithMicrosoftAction} aria-label="Sign in with Microsoft (Northeastern Login)">
            <BsMicrosoft />
            Continue with Microsoft
          </Button>
        </Stack>

        <HStack gap="6" w="100%">
          <Separator flex="1" />
          <Text flexShrink="0" textStyle="sm" color="fg.muted">or</Text>
          <Separator flex="1" />
        </HStack>

        <Stack gap="4">
          <form action={signInOrSignUpWithEmailAction}>
            <FormMessage message={message} />
            <Box>
              <Input name="email" placeholder="name@company.com" aria-label="Sign in email" />
              <Input name="password" placeholder="password" type="password" aria-label="Sign in password" />
            </Box>
            <Box mt="4">
              <Button 
              type="submit" name="action" value="signin" width="100%">Sign in with email</Button>
            </Box>
              <Button 
              type="submit" variant="outline" name="action" value="signup" width="100%">Sign up</Button>
          </form>
        </Stack>

      </Stack>
    </Container>
  );
}
