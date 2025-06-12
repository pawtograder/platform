import { Assignment, Tag } from "@/utils/supabase/DatabaseTypes";
import { createContext, Dispatch, SetStateAction, useContext, useState } from "react";

export type AssignmentEmailInfo = {
  type: "assignment";
  assignment: Assignment;
  submissionType: "submitted" | "not submitted";
};

export type TagEmailInfo = {
  type: "tag";
  tag: Tag;
};

export type GeneralEmailInfo = {
  type: "general";
  includeInstructors: boolean;
  includeStudents: boolean;
  includeGraders: boolean;
};

export type EmailAudience = AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;

export type EmailCreateData = {
  subject: string;
  body: string;
  cc_emails: string[];
  audience: EmailAudience;
};

export type EmailManagementContextType = {
  emailsToCreate: EmailCreateData[];
  setEmailsToCreate: Dispatch<SetStateAction<EmailCreateData[]>>;
};

export const EmailManagementContext = createContext<EmailManagementContextType>({} as EmailManagementContextType);

export const useEmailManagement = () => {
  const ctx = useContext(EmailManagementContext);
  if (!ctx) {
    throw new Error("useGroupManagement must be used within a GroupManagementProvider");
  }
  return ctx;
};

export function EmailManagementProvider({ children }: { children: React.ReactNode }) {
  const [emailsToCreate, setEmailsToCreate] = useState<EmailCreateData[]>([]);

  return (
    <EmailManagementContext.Provider
      value={{
        emailsToCreate,
        setEmailsToCreate
      }}
    >
      {children}
    </EmailManagementContext.Provider>
  );
}
