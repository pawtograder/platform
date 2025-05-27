import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";

dotenv.config({ path: ".env.local" });

const createTestUsers = async () => {
  for (let i = 2; i < 50; i++) {
    const password = crypto.randomBytes(32).toString("hex");
    await fs.promises.writeFile(
      `./playwright/.auth/${i}_login.json`,
      JSON.stringify({
        email: `testUser${i}@ripley.cloud`,
        password
      })
    );
  }
};

createTestUsers();
