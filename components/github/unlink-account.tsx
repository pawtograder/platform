"use client";

import { Button, VStack } from "@chakra-ui/react";
import { createBrowserClient } from "@supabase/ssr";
import { BsGithub } from "react-icons/bs";
import { PopConfirm } from "../ui/popconfirm";
export default function UnlinkAccount() {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  );
  return (
    <VStack>
      Currently linked to GitHub.
      <PopConfirm
        triggerLabel="Unlink GitHub"
        trigger={
          <Button colorPalette="gray">
            <BsGithub /> Sign out of GitHub
          </Button>
        }
        confirmHeader="Unlink GitHub"
        confirmText="Are you sure you want to unlink your GitHub account?"
        onConfirm={async () => {
          // retrieve all identites linked to a user
          const identities = await supabase.auth.getUserIdentities();

          // find the google identity
          const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");
          if (!githubIdentity) {
            throw new Error("GitHub identity not found");
          }

          // unlink the google identity
          const { error } = await supabase.auth.unlinkIdentity(githubIdentity);
          if (error) {
            throw new Error(error.message);
          }
        }}
        onCancel={() => {
          console.log("Canceled");
        }}
      ></PopConfirm>
    </VStack>
  );
}
