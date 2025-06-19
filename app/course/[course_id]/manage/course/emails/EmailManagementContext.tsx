import { createContext, useContext, useState } from "react";

// an email going to a single recipient which may have been chosen because they are
// part of a larger category
export type EmailCreateData = {
  id: string;
  subject: string;
  body: string;
  cc_ids: { email: string; user_id: string }[];
  to: { email: string; user_id: string };
  why: JSX.Element;
  reply_to?: string;
};

export type EmailCreateDataWithoutId = {
  subject: string;
  body: string;
  cc_ids: { email: string; user_id: string }[];
  to: { email: string; user_id: string };
  why: JSX.Element;
  reply_to?: string;
};

export type EmailManagementContextType = {
  emailsToCreate: EmailCreateData[];
  addEmail: (email: EmailCreateDataWithoutId) => void;
  addEmails: (emails: EmailCreateDataWithoutId[]) => void;
  removeEmail: (id: string) => void;
  updateEmailField: (
    id: string,
    field: string,
    value: string | string[] | { email: string; user_id: string }[]
  ) => void;
  clearEmails: () => void;
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
        cc_ids: email.cc_ids.filter((cc) => {
          return cc.user_id != email.to.user_id;
        }),
        to: email.to,
        why: email.why,
        reply_to: email.reply_to
      }
    ]);
  };

  const addEmails = (emails: EmailCreateDataWithoutId[]) => {
    const properEmails = emails.map((email) => {
      return {
        id: crypto.randomUUID(),
        subject: email.subject,
        body: email.body,
        cc_ids: email.cc_ids.filter((cc) => {
          return cc.user_id != email.to.user_id;
        }),
        to: email.to,
        why: email.why,
        reply_to: email.reply_to
      };
    });
    setEmailsToCreate(emailsToCreate.concat(properEmails));
  };

  const removeEmail = (id: string) => {
    setEmailsToCreate(
      emailsToCreate.filter((e) => {
        return e.id != id;
      })
    );
  };

  const clearEmails = () => {
    setEmailsToCreate([]);
  };

  const updateEmailField = (
    id: string,
    field: string,
    value: string | string[] | { email: string; user_id: string }[]
  ) => {
    setEmailsToCreate((prev) => prev.map((email) => (email.id === id ? { ...email, [field]: value } : email)));
  };

  return (
    <EmailManagementContext.Provider
      value={{
        emailsToCreate,
        addEmail,
        addEmails,
        removeEmail,
        updateEmailField,
        clearEmails
      }}
    >
      {children}
    </EmailManagementContext.Provider>
  );
}
