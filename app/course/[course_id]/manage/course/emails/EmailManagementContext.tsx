import { Assignment, Tag } from "@/utils/supabase/DatabaseTypes";
import { createContext, useContext, useState } from "react";

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

export type EmailCreateData = {
  id: string;
  subject: string;
  body: string;
  audience: AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;
};

export type EmailCreateDataWithoutId = {
  subject: string;
  body: string;
  audience: AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;
};

export type EmailManagementContextType = {
  emailsToCreate: EmailCreateData[];
  addEmail: (email: EmailCreateDataWithoutId) => void;
  removeEmail: (id: string) => void;
  updateEmailField: (
    id: string,
    field: string,
    value: string | string[] | AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo
  ) => void;
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

  const addEmail = (email: EmailCreateDataWithoutId) => {
    setEmailsToCreate([
      ...emailsToCreate,
      {
        id: crypto.randomUUID(),
        subject: email.subject,
        body: email.body,
        audience: email.audience
      }
    ]);
  };

  const removeEmail = (id: string) => {
    setEmailsToCreate(
      emailsToCreate.filter((e) => {
        return e.id != id;
      })
    );
  };

  const updateEmailField = (
    id: string,
    field: string,
    value: string | string[] | AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo
  ) => {
    setEmailsToCreate((prev) => prev.map((email) => (email.id === id ? { ...email, [field]: value } : email)));
  };

  return (
    <EmailManagementContext.Provider
      value={{
        emailsToCreate,
        addEmail,
        removeEmail,
        updateEmailField
      }}
    >
      {children}
    </EmailManagementContext.Provider>
  );
}
