import { createContext, useContext, useState } from "react";

// an email going to a single recipient which may have been chosen because they are
// part of a larger category
export type EmailCreateData = {
  id: string;
  batch_id: string;
  subject?: string;
  body?: string;
  to: { email: string; user_id: string };
  why: JSX.Element;
};

export type EmailCreateDataWithoutId = {
  batch_id: string;
  subject?: string;
  body?: string;
  to: { email: string; user_id: string };
  why: JSX.Element;
};

// a base email going out to a set of students.  if emails are not personalized futher in staging,
// they will use the subject/body in the base
export type Batch = {
  id: string;
  subject: string;
  body: string;
  assignment_id?: number;
};

export type BatchWithoutId = {
  subject: string;
  body: string;
  assignment_id?: number;
};

export type EmailManagementContextType = {
  emailsToCreate: EmailCreateData[];
  addEmail: (email: EmailCreateDataWithoutId) => void;
  addEmails: (emails: EmailCreateDataWithoutId[]) => void;
  removeEmail: (id: string) => void;
  updateEmailField: (id: string, field: string, value: string | string[]) => void;
  addBatch: (data: BatchWithoutId) => Batch;
  batches: Batch[];
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
  const [batches, setBatches] = useState<Batch[]>([]);
  const addEmail = (email: EmailCreateDataWithoutId) => {
    setEmailsToCreate([
      ...emailsToCreate,
      {
        id: crypto.randomUUID(),
        batch_id: email.batch_id,
        subject: email.subject,
        body: email.body,
        to: email.to,
        why: email.why
      }
    ]);
  };

  const addBatch = (batch: BatchWithoutId) => {
    const created = {
      id: crypto.randomUUID(),
      subject: batch.subject,
      body: batch.body,
      assignment_id: batch.assignment_id
    };
    setBatches([...batches, created]);
    return created;
  };

  const addEmails = (emails: EmailCreateDataWithoutId[]) => {
    const properEmails = emails.map((email) => {
      return {
        id: crypto.randomUUID(),
        batch_id: email.batch_id,
        subject: email.subject,
        body: email.body,
        to: email.to,
        why: email.why
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

  const updateEmailField = (id: string, field: string, value: string | string[]) => {
    setEmailsToCreate((prev) => prev.map((email) => (email.id === id ? { ...email, [field]: value } : email)));
  };

  return (
    <EmailManagementContext.Provider
      value={{
        emailsToCreate,
        addEmail,
        addEmails,
        addBatch,
        removeEmail,
        updateEmailField,
        batches
      }}
    >
      {children}
    </EmailManagementContext.Provider>
  );
}
