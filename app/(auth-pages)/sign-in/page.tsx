import { setNewPasswordAction, signInOrSignUpWithEmailAction, signInWithMicrosoftAction } from "@/app/actions";
import { FormMessage, Message } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import Logo from "@/components/ui/logo";
import { createClient } from "@/utils/supabase/server";
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
import { redirect, RedirectType } from "next/navigation";
import { NextResponse } from "next/server";
import { BsMicrosoft } from 'react-icons/bs';


type SearchParams = Message & {
  email?: string;
  code?: string;
}
async function ResetPassword({ code, message }: { code: string, message: Message }) {
  return (<Container maxW="md" py={{ base: '12', md: '24' }}>
    <Stack gap="6">

      <VStack gap="2" textAlign="center" mt="4">
        <Logo width={100} />
        <Heading size="3xl">Pawtograder</Heading>
        <Text color="fg.muted">
          Your pawsome course companion
        </Text>
      </VStack>


      <HStack gap="6" w="100%">
        <Separator flex="1" />
        <Text flexShrink="0" textStyle="sm" color="fg.muted">Reset Password</Text>
        <Separator flex="1" />
      </HStack>

      <Stack gap="4">
        <form action={setNewPasswordAction}>
          <FormMessage message={message} />
          <Box>
            <Input name="password" placeholder="new password" type="password" aria-label="Sign in password" />
          </Box>
          <Box mt="4">
            <Button
              type="submit" name="action" value="set-new-password" width="100%">Reset Password</Button>
          </Box>
        </form>
      </Stack>

    </Stack>
  </Container>
  );
}
export default async function Login(props: { searchParams: Promise<SearchParams> }) {
  const { email, code, ...message } = await props.searchParams;
  if (code) {
    return <ResetPassword code={code} message={message} />
  }
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
              <Input name="email" placeholder="name@company.com" aria-label="Sign in email" defaultValue={email} />
              <Input name="password" placeholder="password" type="password" aria-label="Sign in password" />
            </Box>
            <Box mt="4">
              <Button
                type="submit" name="action" value="signin" width="100%">Sign in with email</Button>
            </Box>
            <HStack gap="4" w="100%" mt="4">
              <Button
                type="submit" variant="outline" name="action" value="signup" flex="1">Sign up</Button>
              <Button
                type="submit" variant="outline" name="action" value="reset-password" flex="1">Forgot password</Button>
            </HStack>
          </form>
        </Stack>

      </Stack>
    </Container>
  );
}
