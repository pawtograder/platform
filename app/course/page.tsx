import LinkAccount from "@/components/github/link-account";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import SemesterText from "@/components/ui/semesterText";
import { createClient } from "@/utils/supabase/server";
import { Card, Flex, Heading, Stack, VStack } from "@chakra-ui/react";
import { Box } from "lucide-react";
import { redirect } from "next/navigation";
import { signOutAction } from "../actions";
export default async function ProtectedPage() {
  const supabase = await createClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/sign-in");
  }

  //list identities
  const identities = await supabase.auth.getUserIdentities();
  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");
  const courses = await supabase
    .from("classes")
    .select("*")
    .order("semester", { ascending: false })
    .order("name", { ascending: true });

  if (courses.data?.length === 1) {
    return redirect(`/course/${courses.data[0].id}`);
  }
  let actions = <></>;
  if (!githubIdentity) {
    actions = <LinkAccount />;
  }
  return (
    <VStack>
      <VStack px={{ base: 4, md: 4 }} bg="bg.subtle" borderBottomWidth="1px" borderBottomColor="border.emphasized">
        <Flex width="100%" height="20" alignItems="center" justifyContent={{ base: "space-between" }}>
          <Box fontSize="2xl" fontWeight="bold">
            Pawtograder
          </Box>
          <Button onClick={signOutAction}>Sign out</Button>
        </Flex>
        {actions}
        <Heading size="xl">Your courses</Heading>
        <Flex>
          <Stack gap="4" direction="row" wrap="wrap">
            {courses.data!.map((course) => (
              <Link key={course.id} href={`/course/${course.id}`}>
                <Card.Root key={course.id} p="4" w="300px" _hover={{ bg: "bg.subtle", cursor: "pointer" }}>
                  <Card.Body>
                    <Card.Title>{course.name}</Card.Title>
                    <Card.Description>
                      Semester: <SemesterText semester={course.semester} />
                    </Card.Description>
                  </Card.Body>
                </Card.Root>
              </Link>
            ))}
          </Stack>
        </Flex>
      </VStack>
    </VStack>
  );
}
