import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { termToTermText } from "@/components/ui/semesterText";
import { createClient } from "@/utils/supabase/server";
import { Box, Card, Flex, Heading, Stack, VStack } from "@chakra-ui/react";
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
  const roles = await supabase
    .from("user_roles")
    .select("role, classes(*)")
    .eq("user_id", user.id)
    .eq("disabled", false);

  const sortedRoles = roles.data?.sort((a, b) => {
    if (!a.classes.term || !b.classes.term) {
      return 0;
    }
    return b.classes.term - a.classes.term;
  });

  if (sortedRoles?.length === 1) {
    return redirect(`/course/${sortedRoles[0].classes.id}`);
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
            {sortedRoles!.map((role) => (
              <Link key={role.classes.id} href={`/course/${role.classes.id}`}>
                <Card.Root key={role.classes.id} p="4" w="300px" _hover={{ bg: "bg.subtle", cursor: "pointer" }}>
                  <Card.Body>
                    <Card.Title>
                      {role.classes.name}, {termToTermText(role.classes.term ?? 0)}
                    </Card.Title>
                    <Card.Description>{role.classes.course_title ?? role.classes.name}</Card.Description>
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
