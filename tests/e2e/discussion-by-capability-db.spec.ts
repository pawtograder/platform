/**
 * #1010: moderating discussions follows moderate_discussion
 * (20261123180300_discussion_by_capability.sql).
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
import type { Database } from "@/utils/supabase/SupabaseTypes";
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
      // Before the visibility change: a public and a private thread can't be merged.
      duplicate: await client.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: dup,
        p_original_root_id: root
      }),
      visibility: await client.rpc("set_discussion_thread_visibility", { p_thread_id: root, p_instructors_only: true })
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

  test("only a moderator creates a pinned or answered post or moves a topic, and an author can't move a post to another class", async () => {
    const newPost = (author: TestingUser, extra: { pinned?: boolean; answer?: number }) => ({
      subject: `E2E guard ${Date.now().toString(36)}-${++unique}`,
      body: "New post",
      topic_id: topics[classA.id][0],
      is_question: false,
      instructors_only: false,
      author: author.private_profile_id,
      class_id: classA.id,
      draft: false,
      root_class_id: classA.id,
      ...extra
    });
    const studentClient = await createAuthenticatedClient(student);
    const graderClient = await createAuthenticatedClient(plainGrader);

    // Creating a post that is already pinned or answered.
    expectRefused(
      await studentClient.from("discussion_threads").insert(newPost(student, { pinned: true })),
      "a student creating a pinned post"
    );
    const existing = await newRoot(classA.id, student);
    expectRefused(
      await studentClient.from("discussion_threads").insert(newPost(student, { answer: existing })),
      "a student creating a post with an answer"
    );
    const { data: pinnedByGrader, error: graderInsertError } = await graderClient
      .from("discussion_threads")
      .insert(newPost(plainGrader, { pinned: true }))
      .select("id, pinned")
      .single();
    expect(graderInsertError, "a moderator creates a pinned post").toBeNull();
    expect(pinnedByGrader!.pinned).toBe(true);
    // A normal post is still fine.
    expect((await studentClient.from("discussion_threads").insert(newPost(student, {}))).error).toBeNull();

    // Moving a post to another topic.
    const root = await newRoot(classA.id, student);
    expectRefused(
      await studentClient.from("discussion_threads").update({ topic_id: topics[classA.id][1] }).eq("id", root),
      "an author moving their own post to another topic"
    );
    expect((await thread(root)).topic_id).toBe(topics[classA.id][0]);
    expect(
      (await graderClient.from("discussion_threads").update({ topic_id: topics[classA.id][1] }).eq("id", root)).error,
      "a moderator moves a post to another topic"
    ).toBeNull();
    expect((await thread(root)).topic_id).toBe(topics[classA.id][1]);

    // Moving a post into another class.
    const own = await newRoot(classA.id, student);
    expectRefused(
      await studentClient.from("discussion_threads").update({ class_id: classB.id }).eq("id", own),
      "an author moving their own post into another class"
    );
    const { data: still } = await supabase.from("discussion_threads").select("class_id").eq("id", own).single();
    expect(still!.class_id).toBe(classA.id);
  });

  test("a new post can't start with an answer, and nobody signed in moves a post to another class", async () => {
    // A moderator can't create a post that already has an answer: a new post has no replies yet.
    const existing = await newRoot(classA.id, student);
    const graderClient = await createAuthenticatedClient(plainGrader);
    expectRefused(
      await graderClient.from("discussion_threads").insert({
        subject: `E2E answered ${Date.now().toString(36)}-${++unique}`,
        body: "New post",
        topic_id: topics[classA.id][0],
        is_question: true,
        instructors_only: false,
        author: plainGrader.private_profile_id,
        class_id: classA.id,
        draft: false,
        root_class_id: classA.id,
        answer: existing
      }),
      "a moderator creating a post with an answer"
    );

    // Someone enrolled in two classes changes class_id and author together.
    const inA = await createUserInClass({ role: "student", class_id: classA.id });
    const inB = await createUserInClass({ role: "student", class_id: classB.id, email: inA.email });
    expect(inB.user_id, "the same person in both classes").toBe(inA.user_id);
    const post = await newRoot(classA.id, inA);
    const client = await createAuthenticatedClient(inA);
    const moved = await client
      .from("discussion_threads")
      .update({ class_id: classB.id, author: inB.private_profile_id })
      .eq("id", post);
    expectRefused(moved, "moving a post to another class together with its author");
    expect(moved.error?.message, "refused by the class rule").toContain("can't move to another class");
    const { data: still } = await supabase
      .from("discussion_threads")
      .select("class_id, author")
      .eq("id", post)
      .single();
    expect(still).toEqual({ class_id: classA.id, author: inA.private_profile_id });
  });

  test("nobody moves a post under another thread directly, and a new question still gets its root", async () => {
    // A student's own new question: the notification trigger sets its root to itself, as the student.
    const studentClient = await createAuthenticatedClient(student);
    const { data: own, error: ownError } = await studentClient
      .from("discussion_threads")
      .insert({
        subject: `E2E own question ${Date.now().toString(36)}-${++unique}`,
        body: "My question",
        topic_id: topics[classA.id][0],
        is_question: true,
        instructors_only: false,
        author: student.private_profile_id,
        class_id: classA.id,
        draft: false,
        root_class_id: classA.id
      })
      .select("id")
      .single();
    expect(ownError).toBeNull();
    expect((await thread(own!.id)).root, "a new question is its own root").toBe(own!.id);

    // The student's reply in one thread, moved under another thread.
    const first = await newRoot(classA.id, otherStudent);
    const second = await newRoot(classA.id, otherStudent);
    const reply = await newReply(classA.id, first, student);
    const parentOf = async (id: number) =>
      (await supabase.from("discussion_threads").select("root, parent").eq("id", id).single()).data;

    for (const change of [{ root: second, parent: second }, { root: second }, { parent: second }]) {
      const result = await studentClient.from("discussion_threads").update(change).eq("id", reply);
      expectRefused(result, `a student moving their reply (${Object.keys(change).join(", ")})`);
      expect(result.error?.message).toContain("by marking its thread a duplicate");
    }

    // A moderator can't either: posts only move through Mark Duplicate.
    const graderClient = await createAuthenticatedClient(plainGrader);
    for (const change of [{ root: second, parent: second }, { root: second }, { parent: second }]) {
      const result = await graderClient.from("discussion_threads").update(change).eq("id", reply);
      expectRefused(result, `a moderator moving a reply (${Object.keys(change).join(", ")})`);
    }
    expect(await parentOf(reply)).toEqual({ root: first, parent: first });
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

  // Older gaps on discussion posts, closed in the same migration (sections 4 to 8).

  /** A post written as the service role, with any columns. */
  async function servicePost(
    values: Omit<Database["public"]["Tables"]["discussion_threads"]["Insert"], "subject" | "body">
  ) {
    const { data, error } = await supabase
      .from("discussion_threads")
      .insert({ subject: `E2E gap ${Date.now().toString(36)}-${++unique}`, body: "Body", draft: false, ...values })
      .select("id")
      .single();
    expect(error).toBeNull();
    if (!values.root) {
      expect(
        (await supabase.from("discussion_threads").update({ root: data!.id }).eq("id", data!.id)).error
      ).toBeNull();
    }
    return data!.id;
  }

  const privateRoot = (class_id: number, author: TestingUser) =>
    servicePost({
      class_id,
      root_class_id: class_id,
      topic_id: topics[class_id][0],
      author: author.private_profile_id,
      is_question: true,
      instructors_only: true
    });

  test("a private and a public thread can't be merged as duplicates, either way", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    for (const [dupPrivate, origPrivate] of [
      [true, false],
      [false, true]
    ]) {
      const dup = dupPrivate ? await privateRoot(classA.id, student) : await newRoot(classA.id, student);
      const orig = origPrivate ? await privateRoot(classA.id, otherStudent) : await newRoot(classA.id, otherStudent);
      const result = await client.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: dup,
        p_original_root_id: orig
      });
      expect(result.error?.code, `merging a ${dupPrivate ? "private" : "public"} thread into the other`).toBe("22023");
      const row = await thread(dup);
      expect(row.root, "the duplicate stays its own thread").toBe(dup);
      expect(row.instructors_only).toBe(dupPrivate);
    }
  });

  test("a moderator can't hand a post to someone else, and an author still switches to anonymous", async () => {
    const post = await newRoot(classA.id, student);
    const graderClient = await createAuthenticatedClient(plainGrader);
    const handed = await graderClient
      .from("discussion_threads")
      .update({ author: otherStudent.private_profile_id })
      .eq("id", post);
    expectRefused(handed, "a moderator giving a post to another student");
    expect((await thread(post)).author).toBe(student.private_profile_id);

    const studentClient = await createAuthenticatedClient(student);
    const anonymous = await studentClient
      .from("discussion_threads")
      .update({ author: student.public_profile_id })
      .eq("id", post)
      .select("id");
    expect(anonymous.error).toBeNull();
    expect(anonymous.data).toHaveLength(1);
    expect((await thread(post)).author).toBe(student.public_profile_id);

    // And the moderator's anonymity switch, which changes author on the post and the author's replies.
    const named = await graderClient.rpc("toggle_discussion_thread_author_anonymity", {
      p_thread_id: post,
      p_make_anonymous: false
    });
    expect(named.error).toBeNull();
    expect((await thread(post)).author).toBe(student.private_profile_id);
  });

  test("a post's topic must be in its class", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const inserted = await studentClient.from("discussion_threads").insert({
      subject: `E2E foreign topic ${++unique}`,
      body: "Body",
      topic_id: topics[classB.id][0],
      is_question: true,
      instructors_only: false,
      author: student.private_profile_id,
      class_id: classA.id
    });
    expectRefused(inserted, "a post with another class's topic");
    expect(inserted.error?.message).toContain("topic must be in the post's class");

    const post = await newRoot(classA.id, student);
    const graderClient = await createAuthenticatedClient(plainGrader);
    const moved = await graderClient
      .from("discussion_threads")
      .update({ topic_id: topics[classB.id][0] })
      .eq("id", post);
    expectRefused(moved, "a moderator moving a post to another class's topic");
    expect((await thread(post)).topic_id).toBe(topics[classA.id][0]);
  });

  test("only the database sets counts, times, duplicate fields and root_class_id", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const post = await newRoot(classA.id, student);
    const before = (
      await supabase
        .from("discussion_threads")
        .select("likes_count, created_at, duplicate_marked_by_display_name")
        .eq("id", post)
        .single()
    ).data;
    for (const values of [
      { likes_count: 999 },
      { created_at: "2000-01-01T00:00:00Z" },
      { duplicate_marked_by_display_name: "Prof. Fake" }
    ]) {
      expectRefused(
        await studentClient.from("discussion_threads").update(values).eq("id", post),
        `a student setting ${Object.keys(values)[0]}`
      );
    }
    expect(
      (
        await supabase
          .from("discussion_threads")
          .select("likes_count, created_at, duplicate_marked_by_display_name")
          .eq("id", post)
          .single()
      ).data
    ).toEqual(before);

    // A new post can't start with counts either.
    expectRefused(
      await studentClient.from("discussion_threads").insert({
        subject: `E2E forged ${++unique}`,
        body: "Body",
        topic_id: topics[classA.id][0],
        author: student.private_profile_id,
        class_id: classA.id,
        children_count: 50
      }),
      "a new post with a children_count"
    );

    // root_class_id and edited_at are accepted from the client, but the database sets their value.
    const { data: created, error } = await studentClient
      .from("discussion_threads")
      .insert({
        subject: `E2E root class ${++unique}`,
        body: "Body",
        topic_id: topics[classA.id][0],
        is_question: true,
        author: student.private_profile_id,
        class_id: classA.id,
        root_class_id: classB.id
      })
      .select("id, root_class_id")
      .single();
    expect(error).toBeNull();
    expect(created!.root_class_id, "a question's root_class_id is its own class").toBe(classA.id);

    const edited = await studentClient
      .from("discussion_threads")
      .update({ body: "Edited", edited_at: "2000-01-01T00:00:00Z" })
      .eq("id", created!.id)
      .select("edited_at")
      .single();
    expect(edited.error).toBeNull();
    expect(new Date(edited.data!.edited_at + "Z").getUTCFullYear(), "the server's edit time").toBeGreaterThan(2020);
  });

  test("a like goes only on a post you can see in your class, and can't be moved", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const like = (discussion_thread: number) =>
      studentClient
        .from("discussion_thread_likes")
        .insert({ discussion_thread, creator: student.private_profile_id, emoji: "👍" })
        .select("id")
        .single();

    const otherClassPost = await newRoot(classB.id, studentB);
    expectRefused(await like(otherClassPost), "a like on another class's post");
    const hiddenPost = await privateRoot(classA.id, otherStudent);
    expectRefused(await like(hiddenPost), "a like on a private post the student can't see");

    const first = await newRoot(classA.id, otherStudent);
    const second = await newRoot(classA.id, otherStudent);
    const liked = await like(first);
    expect(liked.error).toBeNull();
    expectRefused(
      await studentClient
        .from("discussion_thread_likes")
        .update({ discussion_thread: second })
        .eq("id", liked.data!.id),
      "moving a like to another post"
    );
    const { data: counts } = await supabase
      .from("discussion_threads")
      .select("id, likes_count")
      .in("id", [first, second]);
    expect(Object.fromEntries(counts!.map((r) => [r.id, r.likes_count]))).toEqual({ [first]: 1, [second]: 0 });

    // Unliking still works.
    const removed = await studentClient.from("discussion_thread_likes").delete().eq("id", liked.data!.id).select("id");
    expect(removed.data).toHaveLength(1);
  });

  test("a watch must be on a thread you can see, and reply notifications stay in the class", async () => {
    const watch = (user: TestingUser, class_id: number, root: number, enabled = true) =>
      createAuthenticatedClient(user).then((c) =>
        c
          .from("discussion_thread_watchers")
          .insert({ user_id: user.user_id, class_id, discussion_thread_root_id: root, enabled })
          .select("id")
          .single()
      );

    const otherClassPost = await newRoot(classB.id, studentB);
    expectRefused(await watch(student, classB.id, otherClassPost), "watching another class's thread");
    expectRefused(await watch(student, classA.id, otherClassPost), "watching it under your own class");
    const hiddenPost = await privateRoot(classA.id, otherStudent);
    expectRefused(await watch(student, classA.id, hiddenPost), "watching a private thread you can't see");

    // A watch you can make, and turning it off.
    const visible = await newRoot(classA.id, otherStudent);
    const ok = await watch(student, classA.id, visible);
    expect(ok.error).toBeNull();
    const off = await (await createAuthenticatedClient(student))
      .from("discussion_thread_watchers")
      .update({ enabled: false })
      .eq("id", ok.data!.id)
      .select("id");
    expect(off.data).toHaveLength(1);

    // An old watch row from someone outside the class (written as the service role) gets no
    // notification; a watcher enrolled in the class does. The reply's author is watched automatically.
    for (const [user, class_id] of [
      [studentB, classB.id],
      [instructor, classA.id]
    ] as const) {
      expect(
        (
          await supabase
            .from("discussion_thread_watchers")
            .insert({ user_id: user.user_id, class_id, discussion_thread_root_id: visible, enabled: true })
        ).error
      ).toBeNull();
    }
    const replyText = `E2E watched reply ${Date.now().toString(36)}`;
    const replied = await (await createAuthenticatedClient(student)).from("discussion_threads").insert({
      subject: "Re",
      body: replyText,
      topic_id: topics[classA.id][0],
      author: student.private_profile_id,
      class_id: classA.id,
      parent: visible,
      root: visible
    });
    expect(replied.error).toBeNull();

    const notified = async (user: TestingUser) =>
      (
        await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", user.user_id)
          .eq("body->>root_thread_id", String(visible))
          .eq("body->>action", "reply")
      ).data!.length;
    expect(await notified(instructor), "an enrolled watcher").toBe(1);
    expect(await notified(studentB), "a watcher from another class").toBe(0);

    const { data: autoWatch } = await supabase
      .from("discussion_thread_watchers")
      .select("enabled")
      .eq("user_id", student.user_id)
      .eq("discussion_thread_root_id", visible);
    expect(autoWatch, "the student's earlier watch is kept as it was").toEqual([{ enabled: false }]);
  });

  test("a new reply must be in a thread its author can see, in the same class", async () => {
    const replyAs = async (user: TestingUser, values: { class_id: number; parent: number; root: number }) =>
      (await createAuthenticatedClient(user))
        .from("discussion_threads")
        .insert({
          subject: "Re",
          body: `E2E reply target ${++unique}`,
          topic_id: topics[values.class_id][0],
          author: user.private_profile_id,
          ...values
        })
        .select("id")
        .single();

    const hidden = await privateRoot(classA.id, otherStudent);
    const visible = await newRoot(classA.id, otherStudent);
    const otherVisible = await newRoot(classA.id, otherStudent);
    const visibleReply = await newReply(classA.id, visible, otherStudent);
    const otherClass = await newRoot(classB.id, studentB);

    for (const [what, values] of [
      ["into a private thread the student can't see", { class_id: classA.id, parent: hidden, root: hidden }],
      ["with a private thread as root under a visible parent", { class_id: classA.id, parent: visible, root: hidden }],
      ["under a private parent with a visible root", { class_id: classA.id, parent: hidden, root: visible }],
      ["into another class's thread", { class_id: classA.id, parent: otherClass, root: otherClass }],
      ["whose root isn't its parent's thread", { class_id: classA.id, parent: visibleReply, root: otherVisible }]
    ] as const) {
      expectRefused(await replyAs(student, values), `a reply ${what}`);
    }
    const { data: none } = await supabase
      .from("discussion_threads")
      .select("id")
      .in("root", [hidden, otherClass])
      .neq("author", otherStudent.private_profile_id)
      .neq("author", studentB.private_profile_id);
    expect(none, "nothing was posted into those threads").toEqual([]);

    // A new question can't name another thread as its root.
    expectRefused(
      await (await createAuthenticatedClient(student)).from("discussion_threads").insert({
        subject: `E2E question with a root ${++unique}`,
        body: "Body",
        topic_id: topics[classA.id][0],
        author: student.private_profile_id,
        class_id: classA.id,
        root: hidden
      }),
      "a new question joining a private thread"
    );

    // Still allowed: a reply to a public thread, a nested reply, a reply to your own private
    // thread, and staff replying to anyone's private thread.
    const ownPrivate = await privateRoot(classA.id, student);
    const ok = [
      await replyAs(student, { class_id: classA.id, parent: visible, root: visible }),
      await replyAs(student, { class_id: classA.id, parent: visibleReply, root: visible }),
      await replyAs(student, { class_id: classA.id, parent: ownPrivate, root: ownPrivate }),
      await replyAs(plainGrader, { class_id: classA.id, parent: hidden, root: hidden })
    ];
    for (const r of ok) expect(r.error).toBeNull();
  });

  test("a moderator in two classes can't move or merge a post into the other class", async () => {
    // A new person who is a default grader (so a moderator) in both classes.
    const graderA = await createUserInClass({ role: "grader", class_id: classA.id });
    const graderB = await createUserInClass({ role: "grader", class_id: classB.id, email: graderA.email });
    expect(graderB.user_id, "the same person in both classes").toBe(graderA.user_id);
    const client = await createAuthenticatedClient(graderA);

    const rootA = await newRoot(classA.id, student);
    const reply = await newReply(classA.id, rootA, student);
    const rootB = await newRoot(classB.id, studentB);

    expectRefused(
      await client.from("discussion_threads").update({ root: rootB, parent: rootB }).eq("id", reply),
      "moving a reply under another class's thread"
    );
    const merged = await client.rpc("mark_discussion_thread_duplicate", {
      p_duplicate_root_id: rootA,
      p_original_root_id: rootB
    });
    expect(merged.error, "merging into another class's thread").not.toBeNull();
    expect((await thread(reply)).root).toBe(rootA);
    expect((await thread(rootA)).root).toBe(rootA);
  });

  test("a reply in a private thread is always private, and only the visibility setting makes a thread public", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const graderClient = await createAuthenticatedClient(plainGrader);
    const ownPrivate = await privateRoot(classA.id, student);

    // A reply sent as public into a private thread is stored as private.
    const { data: reply, error } = await studentClient
      .from("discussion_threads")
      .insert({
        subject: "Re",
        body: `E2E private reply ${++unique}`,
        topic_id: topics[classA.id][0],
        author: student.private_profile_id,
        class_id: classA.id,
        parent: ownPrivate,
        root: ownPrivate,
        instructors_only: false
      })
      .select("id, instructors_only")
      .single();
    expect(error).toBeNull();
    expect(reply!.instructors_only, "a reply in a private thread").toBe(true);

    // Its author can't make it public, and nobody can change a thread's visibility directly.
    expectRefused(
      await studentClient.from("discussion_threads").update({ instructors_only: false }).eq("id", reply!.id),
      "making a reply public"
    );
    for (const [what, client, values] of [
      ["the author making their private thread public directly", studentClient, { instructors_only: false }],
      ["a moderator making a private thread public directly", graderClient, { instructors_only: false }]
    ] as const) {
      expectRefused(await client.from("discussion_threads").update(values).eq("id", ownPrivate), what);
    }
    const publicThread = await newRoot(classA.id, student);
    expectRefused(
      await studentClient.from("discussion_threads").update({ instructors_only: true }).eq("id", publicThread),
      "making a thread private directly"
    );

    // A moderator can't move a reply between a public and a private thread, even while changing its
    // visibility in the same update.
    const publicReply = await newReply(classA.id, publicThread, otherStudent);
    for (const [what, id, dest, instructors_only] of [
      ["a public reply made private and moved under a private thread", publicReply, ownPrivate, true],
      ["a private reply made public and moved under a public thread", reply!.id, publicThread, false]
    ] as const) {
      expectRefused(
        await graderClient
          .from("discussion_threads")
          .update({ root: dest, parent: dest, instructors_only })
          .eq("id", id),
        what
      );
    }

    // A reply in a public thread can be made private by its author, and setting the thread's
    // visibility to what it already is doesn't make it public again.
    const madePrivate = await (await createAuthenticatedClient(otherStudent))
      .from("discussion_threads")
      .update({ instructors_only: true })
      .eq("id", publicReply)
      .select("instructors_only")
      .single();
    expect(madePrivate.error).toBeNull();
    expect(madePrivate.data!.instructors_only).toBe(true);
    expect(
      (
        await studentClient.rpc("set_discussion_thread_visibility", {
          p_thread_id: publicThread,
          p_instructors_only: false
        })
      ).error
    ).toBeNull();
    expect((await thread(publicReply)).instructors_only, "the private reply stays private").toBe(true);

    // The visibility setting still changes the thread and its replies together.
    expect(
      (
        await studentClient.rpc("set_discussion_thread_visibility", {
          p_thread_id: ownPrivate,
          p_instructors_only: false
        })
      ).error
    ).toBeNull();
    expect((await thread(ownPrivate)).instructors_only).toBe(false);
    expect((await thread(reply!.id)).instructors_only).toBe(false);
  });

  test("a merge keeps private replies private, and two people's private threads don't merge", async () => {
    const client = await createAuthenticatedClient(plainGrader);

    // A public duplicate with one private reply, merged into a public original.
    const dup = await newRoot(classA.id, student);
    const orig = await newRoot(classA.id, otherStudent);
    const privateReply = await servicePost({
      class_id: classA.id,
      topic_id: topics[classA.id][0],
      author: student.private_profile_id,
      instructors_only: true,
      parent: dup,
      root: dup
    });
    const publicReply = await newReply(classA.id, dup, otherStudent);
    const merged = await client.rpc("mark_discussion_thread_duplicate", {
      p_duplicate_root_id: dup,
      p_original_root_id: orig
    });
    expect(merged.error).toBeNull();
    expect(await thread(privateReply)).toMatchObject({ root: orig, instructors_only: true });
    expect(await thread(publicReply)).toMatchObject({ root: orig, instructors_only: false });
    expect(await thread(dup)).toMatchObject({ root: orig, instructors_only: false });

    // Two private threads by different people: refused either way.
    const mine = await privateRoot(classA.id, student);
    const theirs = await privateRoot(classA.id, otherStudent);
    for (const [d, o] of [
      [mine, theirs],
      [theirs, mine]
    ]) {
      const result = await client.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: d,
        p_original_root_id: o
      });
      expect(result.error?.code).toBe("22023");
      expect(result.error?.message).toContain("different people");
      expect((await thread(d)).root).toBe(d);
    }

    // Two private threads by the same person still merge.
    const mineAgain = await privateRoot(classA.id, student);
    const sameAuthor = await client.rpc("mark_discussion_thread_duplicate", {
      p_duplicate_root_id: mineAgain,
      p_original_root_id: mine
    });
    expect(sameAuthor.error).toBeNull();
    expect(await thread(mineAgain)).toMatchObject({ root: mine, instructors_only: true });
  });

  test("a private reply in a public thread notifies only staff watchers", async () => {
    const root = await newRoot(classA.id, otherStudent);
    for (const user of [instructor, otherStudent]) {
      expect(
        (
          await supabase
            .from("discussion_thread_watchers")
            .insert({ user_id: user.user_id, class_id: classA.id, discussion_thread_root_id: root, enabled: true })
        ).error
      ).toBeNull();
    }
    const inserted = await (await createAuthenticatedClient(student)).from("discussion_threads").insert({
      subject: "Re",
      body: `E2E private reply in a public thread ${++unique}`,
      topic_id: topics[classA.id][0],
      author: student.private_profile_id,
      class_id: classA.id,
      parent: root,
      root,
      instructors_only: true
    });
    expect(inserted.error).toBeNull();
    const notified = async (user: TestingUser) =>
      (
        await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", user.user_id)
          .eq("body->>root_thread_id", String(root))
          .eq("body->>action", "reply")
      ).data!.length;
    expect(await notified(instructor), "a staff watcher").toBe(1);
    expect(await notified(otherStudent), "a student watcher").toBe(0);
  });
});
