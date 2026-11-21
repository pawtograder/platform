import { expect, test } from "@playwright/test";
import { supabase } from "./TestingUtils";

test("user deletion preserves Forgejo token cleanup until revocation", async () => {
  const userId = crypto.randomUUID();
  const { error: userError } = await supabase.from("users").insert({ user_id: userId });
  expect(userError).toBeNull();
  const { error: tokenError } = await supabase.from("forgejo_repo_tokens").insert({
    user_id: userId,
    repository_id: 123456789,
    instance_url: "https://forgejo.example.test"
  });
  expect(tokenError).toBeNull();
  try {
    const { error } = await supabase.from("users").delete().eq("user_id", userId);
    expect(error?.code).toBe("23503");
    expect(error?.message).toContain("forgejo_repo_tokens_user_id_fkey");
    const { data, error: readError } = await supabase.from("forgejo_repo_tokens").select("id").eq("user_id", userId);
    expect(readError).toBeNull();
    expect(data).toHaveLength(1);
  } finally {
    await supabase.from("forgejo_repo_tokens").delete().eq("user_id", userId);
    await supabase.from("users").delete().eq("user_id", userId);
  }
});
