import { createContext, useCallback, useContext, useState } from "react";

// an email going to a single recipient which may have been chosen because they are
// part of a larger category
export type EmailCreateData = {
  id: string;
  batch_id: string;
  subject: string;
  body: string;
  cc_ids: { email: string; user_id: string }[];
  to: { email: string; user_id: string };
  why: JSX.Element;
  reply_to: string;
};

export type EmailCreateDataWithoutId = Omit<EmailCreateData, "id">;

export type Batch = {
  id: string;
  subject: string;
  body: string;
  assignment_id?: number;
  cc_ids: { email: string; user_id: string }[];
  reply_to: string;
};

export type BatchWithoutId = Omit<Batch, "id">;

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
  addBatch: (data: BatchWithoutId) => Batch;
  clearEmails: () => void;
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
  const addEmail = useCallback(
    (email: EmailCreateDataWithoutId) => {
      setEmailsToCreate([
        ...emailsToCreate,
        {
          id: crypto.randomUUID(),
          batch_id: email.batch_id,
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
    },
    [emailsToCreate]
  );

  const addBatch = useCallback(
    (batch: BatchWithoutId) => {
      const created = {
        id: crypto.randomUUID(),
        subject: batch.subject,
        body: batch.body,
        assignment_id: batch.assignment_id,
        cc_ids: batch.cc_ids,
        reply_to: batch.reply_to
      };
      setBatches([...batches, created]);
      return created;
    },
    [batches]
  );

  const addEmails = useCallback(
    (emails: EmailCreateDataWithoutId[]) => {
      const properEmails = emails.map((email) => {
        return {
          id: crypto.randomUUID(),
          batch_id: email.batch_id,
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
    },
    [emailsToCreate]
  );

  const removeEmail = useCallback(
    (id: string) => {
      setEmailsToCreate(
        emailsToCreate.filter((e) => {
          return e.id != id;
        })
      );
    },
    [emailsToCreate]
  );

  const clearEmails = useCallback(() => {
    setEmailsToCreate([]);
    setBatches([]);
  }, []);

  const updateEmailField = useCallback(
    (id: string, field: string, value: string | string[] | { email: string; user_id: string }[]) => {
      setEmailsToCreate((prev) => prev.map((email) => (email.id === id ? { ...email, [field]: value } : email)));
    },
    []
  );

  return (
    <EmailManagementContext.Provider
      value={{
        emailsToCreate,
        addEmail,
        addEmails,
        addBatch,
        removeEmail,
        updateEmailField,
        clearEmails,
        batches
      }}
    >
      {children}
    </EmailManagementContext.Provider>
  );
}
