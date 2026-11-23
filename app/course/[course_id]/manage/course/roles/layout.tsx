import { Suspense } from "react";
import StaffRolesWorkspace from "./StaffRolesWorkspace";

export const metadata = { title: "Staff Roles" };

export default function StaffRolesLayout({ children }: { children: React.ReactNode }) {
  // Keep pending saves and dialogs mounted when moving between the section's routes.
  return (
    <>
      <Suspense fallback={<p>Loading staff roles...</p>}>
        <StaffRolesWorkspace />
      </Suspense>
      {children}
    </>
  );
}
