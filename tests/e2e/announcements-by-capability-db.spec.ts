/**
 * #1010: the Emailer follows send_announcements (20261123160000_announcements_by_capability.sql).
 *
 * - Reading and creating email_batches and emails needs send_announcements in the row's class. The
 *   default instructor role holds it; the default grader role doesn't.
 * - Changing and deleting them stay instructor-only (staging's policies, unchanged).
 * - A new email must go to someone enrolled in its class, and its batch must be in the same class.
 * - A new email becomes a notification for its recipient (the email_notifications() trigger),
 *   whoever sends it.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

type Result = { data: unknown; error: { code?: string; message?: string } | null };

function expectRefused({ error }: Result, what: string) {
  expect(error?.code, `${what} must be refused with 42501`).toBe("42501");
}

test.describe("The Emailer follows send_announcements (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let instructorB: TestingUser;

  const batchValues = (class_id: number) => ({
    class_id,
    subject: `E2E batch ${Date.now().toString(36)}`,
    body: "Hello class",
    cc_emails: { emails: [] }
  });

  const emailValues = (class_id: number, batch_id: number, to: TestingUser) => ({
    class_id,
    batch_id,
    user_id: to.user_id,
    subject: "E2E email",
    body: "Hello",
    cc_emails: { emails: [] }
  });

  /** A batch written as the service role. */
  async function serviceBatch(class_id: number) {
    const { data, error } = await supabase.from("email_batches").insert(batchValues(class_id)).select("id").single();
    expect(error).toBeNull();
    return data!.id;
  }

  /** Sends one email to `to` as `user`, the way the Emailer does: a batch, then its emails. */
  async function sendAs(user: TestingUser, class_id: number, to: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const batch = await client.from("email_batches").insert(batchValues(class_id)).select("id").single();
    if (batch.error) return { batch, email: null };
    const email = await client
      .from("emails")
      .insert(emailValues(class_id, batch.data.id, to))
      .select("id")
      .single();
    return { batch, email };
  }

  async function emailsOfBatch(batch_id: number) {
    const { data, error } = await supabase.from("emails").select("id").eq("batch_id", batch_id);
    expect(error).toBeNull();
    return data!;
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Announcements By Capability A" });
    classB = await createClass({ name: "E2E Announcements By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    studentB = await createUserInClass({ role: "student", class_id: classB.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });

    // A Head TA: a custom role with send_announcements turned on, and nothing else.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: "Announcements TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "send_announcements" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();
  });

  test("the default instructor role holds send_announcements and the default grader role doesn't", async () => {
    const { data, error } = await supabase
      .from("class_roles")
      .select("default_for, role_capabilities(capability)")
      .eq("class_id", classA.id)
      .in("default_for", ["instructor", "grader"]);
    expect(error).toBeNull();
    const holds = (default_for: string) =>
      data!
        .find((r) => r.default_for === default_for)!
        .role_capabilities.some((rc: { capability: string }) => rc.capability === "send_announcements");
    expect(holds("instructor")).toBe(true);
    expect(holds("grader")).toBe(false);
  });

  test("a Head TA with send_announcements can send an email and read it back", async () => {
    const { batch, email } = await sendAs(headTa, classA.id, studentA);
    expect(batch.error).toBeNull();
    expect(email?.error).toBeNull();

    const client = await createAuthenticatedClient(headTa);
    const { data, error } = await client
      .from("email_batches")
      .select("id, emails!emails_batch_id_fkey(user_id)")
      .eq("id", batch.data!.id)
      .single();
    expect(error).toBeNull();
    expect(data!.emails).toEqual([{ user_id: studentA.user_id }]);
  });

  test("a Head TA's email becomes a notification for the student", async () => {
    const subject = `E2E notified ${Date.now().toString(36)}`;
    const client = await createAuthenticatedClient(headTa);
    const batch = await client
      .from("email_batches")
      .insert({ ...batchValues(classA.id), subject })
      .select("id")
      .single();
    expect(batch.error).toBeNull();
    const email = await client.from("emails").insert({ ...emailValues(classA.id, batch.data!.id, studentA), subject });
    expect(email.error).toBeNull();

    const { data: notes, error } = await supabase
      .from("notifications")
      .select("class_id, style, body")
      .eq("user_id", studentA.user_id)
      .eq("class_id", classA.id)
      .eq("style", "email")
      .eq("body->>subject", subject);
    expect(error).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes![0].body).toMatchObject({ type: "email", action: "create", subject, body: "Hello" });
  });

  test("a default grader is refused, and sees no emails", async () => {
    const { batch } = await sendAs(plainGrader, classA.id, studentA);
    expectRefused(batch, "a grader's batch");

    // Even with a batch that exists, the grader can't add an email to it or read it.
    const batchId = await serviceBatch(classA.id);
    const client = await createAuthenticatedClient(plainGrader);
    expectRefused(await client.from("emails").insert(emailValues(classA.id, batchId, studentA)), "a grader's email");
    expect(await emailsOfBatch(batchId)).toEqual([]);
    const { data } = await client.from("email_batches").select("id").eq("id", batchId);
    expect(data).toEqual([]);
  });

  test("an email to someone outside the class, or with another class's batch, is refused", async () => {
    const client = await createAuthenticatedClient(headTa);
    const batchA = await serviceBatch(classA.id);
    expectRefused(
      await client.from("emails").insert(emailValues(classA.id, batchA, studentB)),
      "an email to a student of another class"
    );

    const batchB = await serviceBatch(classB.id);
    expectRefused(
      await client.from("emails").insert(emailValues(classA.id, batchB, studentA)),
      "an email with another class's batch"
    );
    expect(await emailsOfBatch(batchA)).toEqual([]);
    expect(await emailsOfBatch(batchB)).toEqual([]);
  });

  test("send_announcements in one class doesn't reach another class", async () => {
    const { batch } = await sendAs(headTa, classB.id, studentB);
    expectRefused(batch, "a batch in another class");

    const batchB = await serviceBatch(classB.id);
    const client = await createAuthenticatedClient(headTa);
    const { data } = await client.from("email_batches").select("id").eq("id", batchB);
    expect(data).toEqual([]);
  });

  test("only an instructor can change or delete emails and batches", async () => {
    const { batch, email } = await sendAs(headTa, classA.id, studentA);
    expect(email?.error).toBeNull();
    const emailId = email!.data!.id;
    const batchId = batch.data!.id;

    // A Head TA with send_announcements and a default grader: there is no update or delete policy
    // for them, so these match no rows and nothing changes.
    for (const user of [headTa, plainGrader]) {
      const client = await createAuthenticatedClient(user);
      await client.from("emails").update({ subject: "changed" }).eq("id", emailId);
      await client.from("email_batches").update({ class_id: classB.id, subject: "changed" }).eq("id", batchId);
      await client.from("emails").delete().eq("id", emailId);
      await client.from("email_batches").delete().eq("id", batchId);
    }
    const { data: row } = await supabase.from("emails").select("subject, user_id, batch_id").eq("id", emailId).single();
    expect(row).toEqual({ subject: "E2E email", user_id: studentA.user_id, batch_id: batchId });
    const { data: batchRow } = await supabase.from("email_batches").select("class_id").eq("id", batchId).single();
    expect(batchRow).toEqual({ class_id: classA.id });

    // An instructor still can, as before.
    const instructorClient = await createAuthenticatedClient(instructor);
    const changed = await instructorClient
      .from("emails")
      .update({ subject: "changed by instructor" })
      .eq("id", emailId)
      .select("id");
    expect(changed.error).toBeNull();
    expect(changed.data).toHaveLength(1);
    expect((await instructorClient.from("emails").delete().eq("id", emailId).select("id")).data).toHaveLength(1);
    expect((await instructorClient.from("email_batches").delete().eq("id", batchId).select("id")).data).toHaveLength(1);
    expect(await emailsOfBatch(batchId)).toEqual([]);
  });

  test("an instructor can still send an email and read it back", async () => {
    const { batch, email } = await sendAs(instructor, classA.id, studentA);
    expect(batch.error).toBeNull();
    expect(email?.error).toBeNull();
    expect(await emailsOfBatch(batch.data!.id)).toHaveLength(1);

    // And an instructor of another class can't read it.
    const clientB = await createAuthenticatedClient(instructorB);
    const { data } = await clientB.from("email_batches").select("id").eq("id", batch.data!.id);
    expect(data).toEqual([]);
  });
});
