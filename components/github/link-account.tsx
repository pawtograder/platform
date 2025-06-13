"use client";

import { Button, VStack } from "@chakra-ui/react";
import { createBrowserClient } from "@supabase/ssr";
import { Alert } from "../ui/alert";
import { BsGithub } from "react-icons/bs";
import { toaster } from "../ui/toaster";

export default function LinkAccount() {
  const supabase = createBrowserClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"] || "",
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] || ""
  );

  return (
    <Alert width="lg" mt="5" mb="5" status="error" maxWidth="100%">
      <VStack>
        In order to use this application, you need to link your GitHub account.
        <Button
          mr="0"
          colorPalette="gray"
          onClick={async () => {
            const { error } = await supabase.auth.linkIdentity({ provider: "github" });
            if (error) {
              toaster.error({
                title: "Error linking GitHub account",
                description: error.message
              });
            }
          }}
        >
          <BsGithub /> Sign in with GitHub
        </Button>
      </VStack>
    </Alert>
  );
}
