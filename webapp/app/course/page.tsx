import { createClient } from "@/utils/supabase/server";
import { InfoIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { jwtDecode } from "jwt-decode";
import { CardBody, CardHeader, CardRoot, Flex, Heading, List, Stack, VStack } from "@chakra-ui/react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import LinkAccount from "@/components/github/link-account";
import { linkGitHubAction } from "../actions";
export default async function ProtectedPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/sign-in");
  }

  //list identities
  const identities = await supabase.auth.getUserIdentities();
  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");
  const courses = await supabase.from("classes").select("*");

  let actions = <></>;
  if(!githubIdentity){
    actions = <LinkAccount />
  }
  return (
    <VStack>
      {actions}
      <Heading size="xl">Your courses</Heading>
      <Flex>
        <Stack gap="4" direction="row" wrap="wrap">
          {courses.data!.map((course) => (
            <CardRoot key={course.id} p="4" w="300px">
              <CardHeader><Link href={`/course/${course.id}`}>{course.name}</Link></CardHeader>
              <CardBody>
                Canvas ID: {course.canvas_id}
                Semester: {course.semester}
              </CardBody>
            </CardRoot>
          ))}
        </Stack>
      </Flex>
    </VStack>
  );
}
