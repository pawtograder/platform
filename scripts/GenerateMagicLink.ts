import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

export async function generateMagicLink(email: string) {
  const adminSupabase = createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["SUPABASE_SERVICE_ROLE_KEY"]!
  );
  const { data, error } = await adminSupabase.auth.admin.generateLink({
    email,
    type: "magiclink"
  });
  if (error) {
    throw new Error(error.message);
  }
  return data;
}
const email = process.argv[2];

if (email) {
  generateMagicLink(email)
    .then((data) => {
      // eslint-disable-next-line no-console
      console.log(
        `${process.env["NEXT_PUBLIC_PAWTOGRADER_WEB_URL"]}/auth/callback?token_hash=${data.properties?.hashed_token}`
      );
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
} else {
  // eslint-disable-next-line no-console
  console.log("No email specified");
}
