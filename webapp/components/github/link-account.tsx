'use client';

import { Button } from "@chakra-ui/react";
import { createBrowserClient } from "@supabase/ssr";
import { Alert } from "../ui/alert";

export default function LinkAccount() {
  const supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '');

  return (
    <Alert>This appliction works best when linked with your GitHub profile.
      <Button onClick={async () => {
        const { data, error } = await supabase.auth.linkIdentity({ provider: 'github' })
        if(error){
          console.error(error)
        }
      }}>Sign in with GitHub</Button></Alert>
  );
}