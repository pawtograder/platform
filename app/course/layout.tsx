import { AuthStateProvider } from "@/hooks/useAuthState";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/server";
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user?.user) {
    return <div>Not logged in (TODO redirect to login from layout)</div>;
  }
  return (
    <AuthStateProvider user={user?.user}>
      <ClassProfileProvider>{children}</ClassProfileProvider>
    </AuthStateProvider>
  );
}
