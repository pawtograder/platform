import { signInOrSignUpWithEmailAction, signInWithMicrosoftAction, signInWithEmailAction, signUpWithEmailAction } from "@/app/actions";
import { Message, FormMessage } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import {
  Container,
  Flex,
  HStack,
  Heading,
  Icon,
  Input,
  Link,
  Separator,
  Span,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'
import { BsApple, BsGithub, BsGoogle, BsInfoCircle, BsMicrosoft } from 'react-icons/bs'


export default async function Login(props: { searchParams: Promise<Message> }) {
  const message = await props.searchParams;
  return (
    <Container maxW="md" py={{ base: '12', md: '24' }}>
      <Stack gap="6">

        <VStack gap="2" textAlign="center" mt="4">
          <Heading size="3xl">Log in to Pawtograder</Heading>
          <Text color="fg.muted">
          </Text>
        </VStack>

        <Stack gap="3" colorPalette="gray">
          <Button variant="outline" onClick={signInWithMicrosoftAction} aria-label="Sign in with Microsoft (Northeastern Login)">
            <BsMicrosoft />
            Continue with Microsoft (Northeastern Login)
          </Button>
        </Stack>

        <HStack gap="6">
          <Separator />
          <Text textStyle="sm" color="fg.muted">
            or
          </Text>
          <Separator />
        </HStack>

        <Stack gap="4">
          <form action={signInOrSignUpWithEmailAction}>
            <FormMessage message={message} />
            <Input name="email" placeholder="name@company.com" aria-label="Sign in email" />
            <Input name="password" placeholder="password" type="password" aria-label="Sign in password" />
            <Button type="submit" name="action" value="signin">Sign in with email</Button>
            <Button type="submit" variant="outline" name="action" value="signup">Sign up</Button>
          </form>
        </Stack>

      </Stack>
    </Container>
  );
}
