
import { NotificationProvider } from "@/hooks/useNotifications";
import { createClient } from "@/utils/supabase/server";
import { AuthStateProvider } from "@/hooks/useAuthState";
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
    const supabase = await createClient();
    const { data: user } = await supabase.auth.getUser();
    const {data : courses} = await supabase.from("user_roles").select('*, classes(*)'); 

    if (!user?.user || !courses) {
        return <div>Not logged in (TODO redirect to login from layout)</div>
    }
    return <AuthStateProvider user={user?.user} roles={courses}>
        <NotificationProvider>{children}</NotificationProvider>
    </AuthStateProvider>;
}