"use client";

import { Button, VStack } from "@chakra-ui/react";
import { createBrowserClient } from "@supabase/ssr";
import { Alert } from "../ui/alert";
import { BsGithub } from "react-icons/bs";
export default function LinkAccount() {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  );

  return (
    <Alert w="lg" m="5" status="error">
      <VStack>
        In order to use this application, you need to link your GitHub account.
        <Button
          colorPalette="gray"
          onClick={async () => {
            const { error } = await supabase.auth.linkIdentity({ provider: "github" });
            if (error) {
              console.error(error);
            }
          }}
        >
          <BsGithub /> Sign in with GitHub
        </Button>
      </VStack>
    </Alert>
  );
}
