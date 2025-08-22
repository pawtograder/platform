import { AuthStateProvider } from "@/hooks/useAuthState";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user?.user) {
    redirect("/sign-in");
  }
  return (
    <AuthStateProvider user={user?.user}>
      <ClassProfileProvider>{children}</ClassProfileProvider>
    </AuthStateProvider>
  );
}
