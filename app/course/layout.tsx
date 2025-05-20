import { AuthStateProvider } from "@/hooks/useAuthState";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/server";
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user?.user) {
    return <div>Not logged in (TODO redirect to login from layout)</div>;
  }
  const { data: courses } = await supabase.from("user_roles").select("*, classes(*)").eq("user_id", user.user.id);

  if (!user?.user || !courses) {
    return <div>Not logged in (TODO redirect to login from layout)</div>;
  }
  return (
    <AuthStateProvider user={user?.user} roles={courses}>
      <ClassProfileProvider>{children}</ClassProfileProvider>
    </AuthStateProvider>
  );
}
