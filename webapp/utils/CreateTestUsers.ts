import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config({ path: ".env.local" });
const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const createTestUsers = async () => {
  for (let i = 2; i < 50; i++) {
    const password = require("crypto").randomBytes(32).toString("hex");
    const { data, error } = await adminSupabase.auth.admin.createUser({
      email: `testUser${i}@ripley.cloud`,
      password,
      email_confirm: true,
    });
    await fs.promises.writeFile(
      `./playwright/.auth/${i}_login.json`,
      JSON.stringify({
        email: `testUser${i}@ripley.cloud`,
        password,
      }),
    );
  }
};

createTestUsers();
