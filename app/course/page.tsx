import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import SemesterText from "@/components/ui/semesterText";
import { createClient } from "@/utils/supabase/server";
import Logo from "@/components/ui/logo";
import { Card, Container, Flex, Heading, Stack, Text, VStack } from "@chakra-ui/react";
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
  const courses = await supabase
    .from("classes")
    .select("*")
    .order("semester", { ascending: false })
    .order("name", { ascending: true });

  const courseList = courses.data ?? [];

  if (courseList.length === 0) {
    return (
      <Container maxW="md" py={{ base: "12", md: "24" }}>
        <Stack gap="6">
          <VStack gap="2" textAlign="center" mt="4">
            <Logo width={100} />
            <Heading size="3xl">Pawtograder</Heading>
            <Text color="fg.muted">Your pawsome course companion</Text>
          </VStack>

          <Card.Root p="4" colorPalette="red" variant="outline">
            <Card.Body>
              <Card.Title>You don\'t have access to any courses</Card.Title>
              <Card.Description>
                You do not currently have access to any courses on Pawtograder. Please check with your instructor.
              </Card.Description>
            </Card.Body>
          </Card.Root>

          <Button onClick={signOutAction} variant="outline" width="100%">
            Sign out
          </Button>
        </Stack>
      </Container>
    );
  }

  if (courseList.length === 1) {
    return redirect(`/course/${courseList[0].id}`);
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
        <Heading size="xl">Your courses</Heading>
        <Flex>
          <Stack gap="4" direction="row" wrap="wrap">
            {courseList.map((course) => (
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
