"use client";

import { useCourse } from "@/hooks/useCourseController";
import { Box, Button, Heading, HStack, Icon, Link, List, PopoverTrigger, Text, VStack } from "@chakra-ui/react";
import { createBrowserClient } from "@supabase/ssr";
import { BsGithub, BsInfoCircle } from "react-icons/bs";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot } from "../ui/popover";
import { useIdentity } from "@/hooks/useIdentities";
function HelpDialog() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button colorPalette="green" variant="subtle">
          <BsInfoCircle />
          <Text fontSize="sm">More info</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent width="lg">
        <PopoverHeader>
          <Heading size="sm">FAQs about GitHub and Pawtograder</Heading>
        </PopoverHeader>
        <PopoverBody>
          <List.Root>
            <List.Item>
              <Heading size="sm">What if I don&apos;t have a GitHub.com account?</Heading>
              <Text>
                First,{" "}
                <Link bg="bg.info" href="https://github.com/join" target="_blank">
                  create a GitHub.com account
                </Link>
                . Use any username and email address that you like. Then return to this page and click &quot;Sign in
                with GitHub&quot;.
              </Text>
            </List.Item>
            <List.Item>
              <Heading size="sm">I have a &quot;personal&quot; GitHub.com account, should I use that?</Heading>
              If you already have a GitHub.com account we suggest that you use that, so that: 1) you do not need to
              remember a new username and password and manage multiple accounts, and 2) if your class permits making
              your project repository &quot;public&quot; at the end of the semester, you can do so and have it show up
              on your existing profile.
            </List.Item>
            <List.Item>
              <Heading size="sm">
                What if my personal GitHub.com account uses a totally different email address?
              </Heading>
              <Text>It doesn&apos;t matter, thanks to the magic of OAuth!</Text>
            </List.Item>
            <List.Item>
              <Heading size="sm">Can I change which GitHub.com account I use?</Heading>
              <Text>This is not currently possible.</Text>
            </List.Item>
          </List.Root>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
export default function LinkAccount() {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  );
  const course = useCourse();
  const { identities } = useIdentity();
  const githubIdentity = identities?.find((identity) => identity.provider === "github");
  if (!identities || githubIdentity) {
    return null;
  }
  return (
    <Box
      borderWidth="1px"
      p="2"
      borderColor="border.success"
      borderRadius="md"
      width="100%"
      mt="0"
      mb="5"
      bg="bg.success"
      mx="auto"
    >
      <HStack alignItems="flex-start">
        <VStack alignItems="flex-start" gap="0">
          <HStack>
            <Icon size="xl" as={BsGithub} /> <Heading size="lg">Connect to GitHub to access assignments</Heading>
          </HStack>
          <Text fontSize="sm">
            Pawtograder will automatically create repositories for your assignments, using the{" "}
            <Link href={`https://github.com/${course.github_org}`} target="_blank">
              {course.github_org}
            </Link>{" "}
            github.com organization.
          </Text>
          <Text fontSize="sm">
            You can connect any GitHub.com account to Pawtograder, and we do not suggest that you make a new one just
            for this purpose.
          </Text>
        </VStack>
        <HelpDialog />
        <Button
          mr="0"
          colorPalette="green"
          onClick={async () => {
            const { error } = await supabase.auth.linkIdentity({
              provider: "github",
              options: {
                redirectTo: `${window.location.origin}/course/${course.id}`
              }
            });
            if (error) {
              console.error(error);
            }
          }}
        >
          <BsGithub /> Sign in with GitHub
        </Button>
      </HStack>
    </Box>
  );
}
