/**
 * #1010: moderating discussions follows moderate_discussion
 * (20261123140100_discussion_by_capability.sql).
 *
 * Moderation: pinning, editing someone else's post, marking an answer (discussion_threads UPDATE),
 * and the RPCs set_discussion_thread_topic, mark_discussion_thread_duplicate,
 * toggle_discussion_thread_author_anonymity and set_discussion_thread_visibility (staff part).
 *
 * The capability is on the default instructor role, the default grader role and every custom role,
 * so a plain grader keeps moderating. A custom role with it turned off is refused, a student is
 * refused but still edits their own post, and the capability doesn't reach another class.
 *
 * A refused UPDATE changes 0 rows and returns no error, so each UPDATE check reads the row back.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

type Result = { error: { code?: string; message?: string } | null };

function expectRefused({ error }: Result, what: string) {
  expect(error?.code, `${what} must be refused with 42501`).toBe("42501");
}

test.describe("Discussion moderation follows moderate_discussion (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let noModTa: TestingUser;
  let student: TestingUser;
  let otherStudent: TestingUser;
  let studentB: TestingUser;
  const topics: Record<number, number[]> = {};
  let unique = 0;

  async function classTopics(class_id: number) {
    const { data, error } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", class_id)
      .order("ordinal", { ascending: true })
      .limit(2);
    expect(error).toBeNull();
    expect(data!.length, "classes come with default discussion topics").toBeGreaterThanOrEqual(2);
    return data!.map((t) => t.id);
  }

  /** A root post by `author` in `class_id`, written as the service role. */
  async function newRoot(class_id: number, author: TestingUser, is_question = true) {
    unique++;
    const { data, error } = await supabase
      .from("discussion_threads")
      .insert({
        subject: `E2E moderation ${Date.now().toString(36)}-${unique}`,
        body: "Original body",
        topic_id: topics[class_id][0],
        is_question,
        instructors_only: false,
        author: author.private_profile_id,
        class_id,
        draft: false,
        root_class_id: class_id
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const id = data!.id;
    expect((await supabase.from("discussion_threads").update({ root: id }).eq("id", id)).error).toBeNull();
    return id;
  }

  /** A reply to `root` by `author`, written as the service role. */
  async function newReply(class_id: number, root: number, author: TestingUser) {
    const { data, error } = await supabase
      .from("discussion_threads")
      .insert({
        subject: "Re",
        body: "A reply",
        topic_id: topics[class_id][0],
        is_question: false,
        instructors_only: false,
        author: author.private_profile_id,
        class_id,
        draft: false,
        root_class_id: class_id,
        parent: root,
        root
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function thread(id: number) {
    const { data, error } = await supabase
      .from("discussion_threads")
      .select("pinned, body, answer, topic_id, author, instructors_only, root")
      .eq("id", id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  /** Tries every moderation action as `user` on a fresh question by `student` in `class_id`. */
  async function moderateAs(user: TestingUser, class_id: number, author: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const root = await newRoot(class_id, author);
    const reply = await newReply(class_id, root, author);
    const dup = await newRoot(class_id, author, false);

    await client.from("discussion_threads").update({ pinned: true }).eq("id", root);
    await client.from("discussion_threads").update({ body: "Edited by moderator" }).eq("id", reply);
    await client.from("discussion_threads").update({ answer: reply }).eq("id", root);
    const rpc = {
      topic: await client.rpc("set_discussion_thread_topic", { p_thread_id: root, p_topic_id: topics[class_id][1] }),
      anonymity: await client.rpc("toggle_discussion_thread_author_anonymity", {
        p_thread_id: root,
        p_make_anonymous: true
      }),
      visibility: await client.rpc("set_discussion_thread_visibility", { p_thread_id: root, p_instructors_only: true }),
      duplicate: await client.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: dup,
        p_original_root_id: root
      })
    };
    return {
      root,
      reply,
      dup,
      rpc,
      rootRow: await thread(root),
      replyRow: await thread(reply),
      dupRow: await thread(dup)
    };
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Discussion By Capability A" });
    classB = await createClass({ name: "E2E Discussion By Capability B" });
    topics[classA.id] = await classTopics(classA.id);
    topics[classB.id] = await classTopics(classB.id);
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    noModTa = await createUserInClass({ role: "grader", class_id: classA.id });
    student = await createUserInClass({ role: "student", class_id: classA.id });
    otherStudent = await createUserInClass({ role: "student", class_id: classA.id });
    studentB = await createUserInClass({ role: "student", class_id: classB.id });

    // A custom role with moderate_discussion turned off (it starts as a copy of the grader role).
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: "No Moderation TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", "moderate_discussion");
    const { data: left } = await supabase
      .from("role_capabilities")
      .select("capability")
      .eq("role_id", role!.id)
      .eq("capability", "moderate_discussion");
    expect(left).toEqual([]);
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", noModTa.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();
  });

  test("the instructor, default grader and custom roles hold moderate_discussion", async () => {
    const { data, error } = await supabase
      .from("class_roles")
      .select("name, default_for, role_capabilities(capability)")
      .eq("class_id", classA.id);
    expect(error).toBeNull();
    const holds = (r: { role_capabilities: { capability: string }[] }) =>
      r.role_capabilities.some((rc) => rc.capability === "moderate_discussion");
    expect(holds(data!.find((r) => r.default_for === "instructor")!)).toBe(true);
    expect(holds(data!.find((r) => r.default_for === "grader")!)).toBe(true);
    expect(holds(data!.find((r) => r.default_for === "student")!)).toBe(false);
    // A new custom role starts as a copy of the grader role, so it has it until turned off.
    const { data: fresh, error: freshError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: `Fresh TA ${Date.now().toString(36)}` })
      .select("id")
      .single();
    expect(freshError).toBeNull();
    // Read in a second request: the copy runs after the insert, so the insert's own reply can't see it.
    const { data: copied, error: copiedError } = await supabase
      .from("role_capabilities")
      .select("capability")
      .eq("role_id", fresh!.id);
    expect(copiedError).toBeNull();
    expect(copied!.map((rc) => rc.capability)).toContain("moderate_discussion");
  });

  test("a default grader still moderates", async () => {
    const r = await moderateAs(plainGrader, classA.id, student);
    expect(r.rootRow.pinned, "pin").toBe(true);
    expect(r.replyRow.body, "edit someone else's reply").toBe("Edited by moderator");
    expect(r.rootRow.answer, "mark an answer").toBe(r.reply);
    expect(r.rpc.topic.error, "move to a topic").toBeNull();
    expect(r.rootRow.topic_id).toBe(topics[classA.id][1]);
    expect(r.rpc.anonymity.error, "hide the poster").toBeNull();
    expect(r.rootRow.author).toBe(student.public_profile_id);
    expect(r.rpc.visibility.error, "change visibility").toBeNull();
    expect(r.rootRow.instructors_only).toBe(true);
    expect(r.rpc.duplicate.error, "mark a duplicate").toBeNull();
    expect(r.dupRow.root).toBe(r.root);
  });

  test("a custom role without moderate_discussion is refused each one", async () => {
    const r = await moderateAs(noModTa, classA.id, student);
    expect(r.rootRow.pinned, "pin").toBe(false);
    expect(r.replyRow.body, "edit someone else's reply").toBe("A reply");
    expect(r.rootRow.answer, "mark an answer").toBeNull();
    expectRefused(r.rpc.topic, "move to a topic");
    expectRefused(r.rpc.anonymity, "hide the poster");
    expectRefused(r.rpc.visibility, "change visibility");
    expectRefused(r.rpc.duplicate, "mark a duplicate");
    expect(r.rootRow.topic_id).toBe(topics[classA.id][0]);
    expect(r.rootRow.author).toBe(student.private_profile_id);
    expect(r.rootRow.instructors_only).toBe(false);
    expect(r.dupRow.root).toBe(r.dup);
  });

  test("a student can't moderate someone else's post but still edits their own", async () => {
    const r = await moderateAs(otherStudent, classA.id, student);
    expect(r.rootRow.pinned).toBe(false);
    expect(r.replyRow.body).toBe("A reply");
    expect(r.rootRow.answer).toBeNull();
    expectRefused(r.rpc.topic, "a student moving a topic");
    expectRefused(r.rpc.anonymity, "a student hiding a poster");
    expectRefused(r.rpc.visibility, "a student changing someone else's visibility");
    expectRefused(r.rpc.duplicate, "a student marking a duplicate");

    const client = await createAuthenticatedClient(student);
    expect(
      (await client.from("discussion_threads").update({ body: "My own edit" }).eq("id", r.reply)).error
    ).toBeNull();
    expect((await thread(r.reply)).body, "an author edits their own post").toBe("My own edit");
    expect(
      (await client.rpc("set_discussion_thread_visibility", { p_thread_id: r.root, p_instructors_only: true })).error,
      "an author sets their own thread's visibility"
    ).toBeNull();
  });

  test("an author can't pin their own post, and only the question's author or a moderator marks an answer", async () => {
    const root = await newRoot(classA.id, student);
    const reply = await newReply(classA.id, root, otherStudent);
    const otherRoot = await newRoot(classA.id, otherStudent);
    const otherReply = await newReply(classA.id, otherRoot, otherStudent);
    const author = await createAuthenticatedClient(student);
    const replier = await createAuthenticatedClient(otherStudent);

    expectRefused(await author.from("discussion_threads").update({ pinned: true }).eq("id", root), "pinning own post");
    expect((await thread(root)).pinned).toBe(false);

    // The reply's author can't mark it as the answer to someone else's question.
    await replier.from("discussion_threads").update({ answer: reply }).eq("id", root);
    expect((await thread(root)).answer, "a reply author marking someone else's question").toBeNull();

    // The answer must be a reply in this thread.
    const { error: wrongThread } = await author
      .from("discussion_threads")
      .update({ answer: otherReply })
      .eq("id", root);
    expect(wrongThread?.code, "an answer from another thread must be refused with 23514").toBe("23514");
    expect((await thread(root)).answer).toBeNull();

    // The question's author marks and unmarks a reply in their thread.
    expect((await author.from("discussion_threads").update({ answer: reply }).eq("id", root)).error).toBeNull();
    expect((await thread(root)).answer, "the question's author marks an answer").toBe(reply);
    expect((await author.from("discussion_threads").update({ answer: null }).eq("id", root)).error).toBeNull();
    expect((await thread(root)).answer, "and unmarks it").toBeNull();

    // A custom role without moderate_discussion can't pin either.
    await (await createAuthenticatedClient(noModTa)).from("discussion_threads").update({ pinned: true }).eq("id", root);
    expect((await thread(root)).pinned).toBe(false);
  });

  test("moderate_discussion in one class doesn't reach another class", async () => {
    const r = await moderateAs(plainGrader, classB.id, studentB);
    expect(r.rootRow.pinned).toBe(false);
    expect(r.replyRow.body).toBe("A reply");
    expect(r.rootRow.answer).toBeNull();
    expectRefused(r.rpc.topic, "moving a topic in another class");
    expectRefused(r.rpc.anonymity, "hiding a poster in another class");
    expectRefused(r.rpc.visibility, "changing visibility in another class");
    expectRefused(r.rpc.duplicate, "marking a duplicate in another class");
  });

  test("an instructor still moderates", async () => {
    const r = await moderateAs(instructor, classA.id, student);
    expect(r.rootRow.pinned).toBe(true);
    expect(r.replyRow.body).toBe("Edited by moderator");
    expect(r.rootRow.answer).toBe(r.reply);
    for (const [what, res] of Object.entries(r.rpc)) {
      expect(res.error, what).toBeNull();
    }
  });
});
