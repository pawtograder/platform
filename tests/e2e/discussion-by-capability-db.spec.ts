/**
 * #1010: moderating discussions follows moderate_discussion
 * (20261124150500_discussion_by_capability.sql).
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
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  insertPreBakedSubmission,
  type TestingUser
} from "./TestingUtils";

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
    // Signed-in users can't write class_id at all (column privileges).
    expectRefused(moved, "moving a post to another class together with its author");
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
      // Signed-in users can't write root or parent at all (column privileges).
      expectRefused(result, `a student moving their reply (${Object.keys(change).join(", ")})`);
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

  test("a private thread can't be merged as a duplicate, either way, even with the same person's", async () => {
    const client = await createAuthenticatedClient(plainGrader);
    for (const [dupPrivate, origPrivate] of [
      [true, false],
      [false, true],
      [true, true]
    ]) {
      const dup = dupPrivate ? await privateRoot(classA.id, student) : await newRoot(classA.id, student);
      const orig = origPrivate ? await privateRoot(classA.id, student) : await newRoot(classA.id, otherStudent);
      const result = await client.rpc("mark_discussion_thread_duplicate", {
        p_duplicate_root_id: dup,
        p_original_root_id: orig
      });
      expect(result.error?.code, `merging ${dupPrivate}/${origPrivate} (private duplicate/original)`).toBe("22023");
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
      { duplicate_marked_by_display_name: "Prof. Fake" },
      // The app never publishes or unpublishes a post by updating it (a published reply changed its
      // question's count with the reply locked first).
      { draft: true }
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

    // A reply's visibility is set when it is posted: its author can't make it private later. And
    // setting the thread's visibility to what it already is doesn't make a private reply public.
    expectRefused(
      await (await createAuthenticatedClient(otherStudent))
        .from("discussion_threads")
        .update({ instructors_only: true })
        .eq("id", publicReply),
      "making a reply private later"
    );
    expect((await thread(publicReply)).instructors_only).toBe(false);
    const privateReply = await replyAs(otherStudent, publicThread, { instructors_only: true });
    expect(
      (
        await studentClient.rpc("set_discussion_thread_visibility", {
          p_thread_id: publicThread,
          p_instructors_only: false
        })
      ).error
    ).toBeNull();
    expect((await thread(privateReply)).instructors_only, "the private reply stays private").toBe(true);

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

  test("a merge keeps private replies private", async () => {
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

  /** The ids among `ids` that `user` can read, signed in as them. */
  async function readable(user: TestingUser, ids: number[]) {
    const { data, error } = await (await createAuthenticatedClient(user))
      .from("discussion_threads")
      .select("id")
      .in("id", ids);
    expect(error).toBeNull();
    return data!.map((r) => r.id).sort((a, b) => a - b);
  }

  /** A reply written as `user`, signed in. */
  async function replyAs(
    user: TestingUser,
    root: number,
    values: { parent?: number; instructors_only?: boolean } = {}
  ) {
    const { data, error } = await (
      await createAuthenticatedClient(user)
    )
      .from("discussion_threads")
      .insert({
        subject: "Re",
        body: `E2E reply ${++unique}`,
        topic_id: topics[classA.id][0],
        author: user.private_profile_id,
        class_id: classA.id,
        parent: values.parent ?? root,
        root,
        instructors_only: values.instructors_only ?? false
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  test("hiding a thread and showing it again keeps a reply that was private before private", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const root = await newRoot(classA.id, student);
    const publicReply = await newReply(classA.id, root, otherStudent);
    const ownPrivateReply = await replyAs(otherStudent, root, { instructors_only: true });

    const setVisibility = (p_instructors_only: boolean) =>
      studentClient.rpc("set_discussion_thread_visibility", { p_thread_id: root, p_instructors_only });
    expect((await setVisibility(true)).error).toBeNull();
    expect((await thread(publicReply)).instructors_only, "hidden with the thread").toBe(true);
    // A staff reply posted while the thread is private.
    const staffReply = await replyAs(plainGrader, root);
    expect((await thread(staffReply)).instructors_only).toBe(true);

    expect((await setVisibility(false)).error).toBeNull();
    expect((await thread(publicReply)).instructors_only, "shown again with the thread").toBe(false);
    expect((await thread(staffReply)).instructors_only, "a reply posted while hidden is shown too").toBe(false);
    expect((await thread(ownPrivateReply)).instructors_only, "private before, so it stays private").toBe(true);
  });

  test("a private post is readable only by staff, its author, and a private thread's question author", async () => {
    const third = await createUserInClass({ role: "student", class_id: classA.id });

    // A public question by `student`, with a public reply by otherStudent and private replies by a
    // grader and by `third`. Before, everyone with a post in the thread could read the private ones.
    const publicRoot = await newRoot(classA.id, student);
    const publicReply = await newReply(classA.id, publicRoot, otherStudent);
    const staffPrivate = await replyAs(plainGrader, publicRoot, { instructors_only: true });
    const thirdPrivate = await replyAs(third, publicRoot, { instructors_only: true });
    const all = [publicRoot, publicReply, staffPrivate, thirdPrivate].sort((a, b) => a - b);
    const publicOnly = [publicRoot, publicReply].sort((a, b) => a - b);

    expect(await readable(student, all), "the public question's author").toEqual(publicOnly);
    expect(await readable(otherStudent, all), "someone with a post in the thread").toEqual(publicOnly);
    expect(await readable(third, all), "a private reply's own author").toEqual(
      [...publicOnly, thirdPrivate].sort((a, b) => a - b)
    );
    expect(await readable(instructor, all), "staff").toEqual(all);
    expect(await readable(plainGrader, all), "staff").toEqual(all);

    // The question's author makes their thread private for a moment: the replies that were private on
    // their own stay unreadable to them (only replies hidden with the thread are theirs to read).
    const studentClient = await createAuthenticatedClient(student);
    expect(
      (
        await studentClient.rpc("set_discussion_thread_visibility", {
          p_thread_id: publicRoot,
          p_instructors_only: true
        })
      ).error
    ).toBeNull();
    expect(await readable(student, all), "the author of a thread made private").toEqual(publicOnly);
    expect(
      (
        await studentClient.rpc("set_discussion_thread_visibility", {
          p_thread_id: publicRoot,
          p_instructors_only: false
        })
      ).error
    ).toBeNull();
    expect((await thread(staffPrivate)).instructors_only, "still private").toBe(true);

    // A private question by `student`: they read the staff replies; another student reads nothing.
    const privateQuestion = await privateRoot(classA.id, student);
    const staffAnswer = await replyAs(plainGrader, privateQuestion);
    const privateIds = [privateQuestion, staffAnswer].sort((a, b) => a - b);
    expect(await readable(student, privateIds), "the private question's author").toEqual(privateIds);
    expect(await readable(otherStudent, privateIds), "another student").toEqual([]);
  });

  test("a merge doesn't let a student with a post in the duplicate read the original's private replies", async () => {
    const orig = await newRoot(classA.id, otherStudent);
    const origPrivate = await replyAs(plainGrader, orig, { instructors_only: true });
    const dup = await newRoot(classA.id, student);
    const merged = await (
      await createAuthenticatedClient(plainGrader)
    ).rpc("mark_discussion_thread_duplicate", { p_duplicate_root_id: dup, p_original_root_id: orig });
    expect(merged.error).toBeNull();
    expect((await thread(dup)).root).toBe(orig);
    // `student` now has a post in the original's thread, which used to unlock its private posts.
    expect(await readable(student, [orig, dup, origPrivate]), "signed in as the student").toEqual(
      [orig, dup].sort((a, b) => a - b)
    );
  });

  /** Watches `root` for each user, as the service role. */
  async function watch(root: number, ...users: TestingUser[]) {
    for (const user of users) {
      const { error } = await supabase
        .from("discussion_thread_watchers")
        .upsert(
          { user_id: user.user_id, class_id: classA.id, discussion_thread_root_id: root, enabled: true },
          { onConflict: "user_id,discussion_thread_root_id" }
        );
      expect(error).toBeNull();
    }
  }

  /** Reply notifications `user` got about post `postId`. */
  async function replyNotices(user: TestingUser, postId: number) {
    const { data, error } = await supabase
      .from("notifications")
      .select("id")
      .eq("user_id", user.user_id)
      .eq("body->>new_comment_id", String(postId))
      .eq("body->>action", "reply");
    expect(error).toBeNull();
    return data!.length;
  }

  /** The users with an unread mark row for post `postId`. */
  async function markedFor(postId: number) {
    const { data, error } = await supabase
      .from("discussion_thread_read_status")
      .select("user_id")
      .eq("discussion_thread_id", postId);
    expect(error).toBeNull();
    return data!.map((r) => r.user_id);
  }

  /** The digest's copy of the read rule must say exactly what reading as `user` says. */
  async function expectDigestRuleMatches(user: TestingUser, ids: number[]) {
    const { data, error } = await supabase.rpc("discussion_threads_readable_by", {
      p_user_id: user.user_id,
      p_thread_ids: ids
    });
    expect(error).toBeNull();
    expect(
      ((data ?? []) as number[]).sort((a, b) => a - b),
      "discussion_threads_readable_by matches the read policy"
    ).toEqual(await readable(user, ids));
  }

  test("a reply's author can't make it private later and read the private replies under it", async () => {
    // A public question by otherStudent; `third` replies publicly, and `student` answers that reply
    // privately. Making their reply private would have let `third` read what's under it.
    const third = await createUserInClass({ role: "student", class_id: classA.id });
    const root = await newRoot(classA.id, otherStudent);
    const thirdReply = await replyAs(third, root);
    const privateUnder = await replyAs(student, root, { parent: thirdReply, instructors_only: true });
    expectRefused(
      await (await createAuthenticatedClient(third))
        .from("discussion_threads")
        .update({ instructors_only: true })
        .eq("id", thirdReply),
      "making their reply private"
    );
    const all = [root, thirdReply, privateUnder].sort((a, b) => a - b);
    expect(await readable(third, all)).toEqual([root, thirdReply].sort((a, b) => a - b));
    expect(await replyNotices(third, privateUnder), "watching the thread, but can't read it").toBe(0);
    expect(await markedFor(privateUnder)).not.toContain(third.user_id);
    for (const user of [third, student, otherStudent, plainGrader]) {
      await expectDigestRuleMatches(user, all);
    }
  });

  test("a private question's author is notified of the staff answers, and other watchers aren't", async () => {
    const question = await privateRoot(classA.id, student);
    await watch(question, student, otherStudent);
    const answer = await replyAs(plainGrader, question);
    expect((await thread(answer)).instructors_only).toBe(true);
    expect(await replyNotices(student, answer), "the question's author").toBe(1);
    expect(await replyNotices(otherStudent, answer), "another student watching").toBe(0);
    await expectDigestRuleMatches(student, [question, answer]);
    await expectDigestRuleMatches(otherStudent, [question, answer]);
  });

  test("the reply count and unread marks show only replies every reader of the question can read", async () => {
    const third = await createUserInClass({ role: "student", class_id: classA.id });
    const root = await newRoot(classA.id, student);
    const publicReply = await newReply(classA.id, root, otherStudent);
    const thirdPrivate = await replyAs(third, root, { instructors_only: true });
    // Read as a student, the way every list and realtime row carries it.
    const count = async () => {
      const { data, error } = await (await createAuthenticatedClient(otherStudent))
        .from("discussion_threads")
        .select("children_count")
        .eq("id", root)
        .single();
      expect(error).toBeNull();
      return data!.children_count;
    };
    expect(await count(), "a private reply isn't counted").toBe(1);

    // A mark made before #1010 for a private reply its owner can't read: the cleanup the migration
    // runs once removes it.
    expect(
      (
        await supabase.from("discussion_thread_read_status").insert({
          user_id: otherStudent.user_id,
          discussion_thread_id: thirdPrivate,
          discussion_thread_root_id: root
        })
      ).error
    ).toBeNull();
    expect((await supabase.rpc("prune_discussion_thread_read_status", { p_root: root })).error).toBeNull();
    expect(await markedFor(thirdPrivate)).not.toContain(otherStudent.user_id);
    expect(await markedFor(thirdPrivate), "its author keeps theirs").toContain(third.user_id);

    // `third` had unread marks for the question and the public reply while they were public.
    expect(await markedFor(root)).toContain(third.user_id);
    expect(await markedFor(publicReply)).toContain(third.user_id);

    // Hidden: the public reply is now private with the thread, which its question's author reads.
    const studentClient = await createAuthenticatedClient(student);
    expect(
      (await studentClient.rpc("set_discussion_thread_visibility", { p_thread_id: root, p_instructors_only: true }))
        .error
    ).toBeNull();
    const asStaff = async () =>
      (await supabase.from("discussion_threads").select("children_count").eq("id", root).single()).data!.children_count;
    expect(await asStaff(), "hidden with the thread, so its author still counts it").toBe(1);
    // `third` can't read the question or that reply now, so their marks for them are gone; their own
    // private reply keeps its mark.
    expect(await markedFor(root)).not.toContain(third.user_id);
    expect(await markedFor(publicReply)).not.toContain(third.user_id);
    expect(await markedFor(publicReply), "its author keeps theirs").toContain(otherStudent.user_id);
    expect(await markedFor(thirdPrivate)).toContain(third.user_id);

    // A staff reply while hidden counts; showing the thread again keeps the count.
    await replyAs(plainGrader, root);
    expect(await asStaff()).toBe(2);
    expect(
      (await studentClient.rpc("set_discussion_thread_visibility", { p_thread_id: root, p_instructors_only: false }))
        .error
    ).toBeNull();
    expect(await count()).toBe(2);
  });

  test("a merge recounts only the original's thread", async () => {
    const orig = await newRoot(classA.id, otherStudent);
    await newReply(classA.id, orig, student);
    const dup = await newRoot(classA.id, student);
    await newReply(classA.id, dup, otherStudent);
    await newReply(classA.id, dup, otherStudent);
    // Another thread in the class with a wrong count: the old class-wide recount would have fixed it,
    // so it staying wrong shows the merge only recounted the original's thread.
    const bystander = await newRoot(classA.id, otherStudent);
    expect(
      (await supabase.from("discussion_threads").update({ children_count: 99 }).eq("id", bystander)).error
    ).toBeNull();
    const merged = await (
      await createAuthenticatedClient(plainGrader)
    ).rpc("mark_discussion_thread_duplicate", { p_duplicate_root_id: dup, p_original_root_id: orig });
    expect(merged.error).toBeNull();
    const { data } = await supabase.from("discussion_threads").select("children_count").eq("id", orig).single();
    expect(data!.children_count, "its reply, the duplicate and the duplicate's two replies").toBe(4);
    const { data: other } = await supabase
      .from("discussion_threads")
      .select("children_count")
      .eq("id", bystander)
      .single();
    expect(other!.children_count, "another thread in the class isn't recounted").toBe(99);
  });

  test("a reply's thread must be in the reply's class, even for someone in both classes", async () => {
    // One person enrolled in both classes, so both threads are visible to them.
    const both = await createUserInClass({ role: "student", class_id: classA.id });
    const bothB = await createUserInClass({ role: "student", class_id: classB.id, email: both.email });
    expect(bothB.user_id).toBe(both.user_id);
    const rootB = await newRoot(classB.id, studentB);
    // Inconsistent old data, written as the service role: a class A post whose thread is in class B.
    const strayA = await servicePost({
      class_id: classA.id,
      topic_id: topics[classA.id][0],
      author: otherStudent.private_profile_id,
      parent: rootB,
      root: rootB
    });
    expectRefused(
      await (await createAuthenticatedClient(both)).from("discussion_threads").insert({
        subject: "Re",
        body: `E2E cross-class reply ${++unique}`,
        topic_id: topics[classA.id][0],
        author: both.private_profile_id,
        class_id: classA.id,
        parent: strayA,
        root: rootB
      }),
      "a class A reply in a class B thread"
    );
  });

  test("new-post notifications skip disabled enrollments, and a private post's unread rows go only to its readers", async () => {
    const follower = await createUserInClass({ role: "student", class_id: classA.id });
    const disabledFollower = await createUserInClass({ role: "student", class_id: classA.id });
    const topic = topics[classA.id][1];
    for (const user of [follower, disabledFollower]) {
      expect(
        (
          await supabase
            .from("discussion_topic_followers")
            .insert({ user_id: user.user_id, class_id: classA.id, topic_id: topic, following: true })
        ).error
      ).toBeNull();
    }
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ disabled: true })
          .eq("user_id", disabledFollower.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();

    const post = async (instructors_only: boolean) => {
      const { data, error } = await (
        await createAuthenticatedClient(student)
      )
        .from("discussion_threads")
        .insert({
          subject: `E2E followed post ${++unique}`,
          body: "Body",
          topic_id: topic,
          author: student.private_profile_id,
          class_id: classA.id,
          is_question: true,
          instructors_only
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id;
    };
    const publicPost = await post(false);
    const newPostNotices = async (user: TestingUser) =>
      (
        await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", user.user_id)
          .eq("body->>root_thread_id", String(publicPost))
          .eq("body->>action", "new_post")
      ).data!.length;
    expect(await newPostNotices(follower), "an enrolled follower").toBe(1);
    expect(await newPostNotices(disabledFollower), "a disabled enrollment").toBe(0);

    // A private question: unread rows only for staff (and not for other students).
    const privatePost = await post(true);
    const unreadFor = async (threadId: number) =>
      (
        await supabase.from("discussion_thread_read_status").select("user_id").eq("discussion_thread_id", threadId)
      ).data!.map((r) => r.user_id);
    const privateRows = await unreadFor(privatePost);
    expect(privateRows).toEqual(expect.arrayContaining([instructor.user_id, plainGrader.user_id, student.user_id]));
    expect(privateRows).not.toContain(otherStudent.user_id);
    expect(privateRows).not.toContain(follower.user_id);
    // A staff reply in it: the question's author gets a row, other students don't.
    const staffReply = await replyAs(plainGrader, privatePost);
    const replyRows = await unreadFor(staffReply);
    expect(replyRows).toContain(student.user_id);
    expect(replyRows).not.toContain(otherStudent.user_id);
    // A public post still marks everyone.
    expect(await unreadFor(publicPost)).toEqual(expect.arrayContaining([otherStudent.user_id, follower.user_id]));
  });

  test("a like uses your named profile and can't go on your own post", async () => {
    const studentClient = await createAuthenticatedClient(student);
    const like = (discussion_thread: number, creator: string) =>
      studentClient.from("discussion_thread_likes").insert({ discussion_thread, creator, emoji: "👍" });
    const others = await newRoot(classA.id, otherStudent);
    expectRefused(await like(others, student.public_profile_id), "a like with the anonymous profile");
    const own = await newRoot(classA.id, student);
    expectRefused(await like(own, student.private_profile_id), "a like on your own post");
    expect((await like(others, student.private_profile_id)).error, "a like as the app sends it").toBeNull();
  });

  test("a topic stays in its class, and an error pin's thread must be in the pin's class", async () => {
    // One instructor of both classes.
    const instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    const instructorB = await createUserInClass({ role: "instructor", class_id: classB.id, email: instructorA.email });
    expect(instructorB.user_id).toBe(instructorA.user_id);
    const client = await createAuthenticatedClient(instructorA);

    const topicId = topics[classA.id][1];
    expectRefused(
      await client.from("discussion_topics").update({ class_id: classB.id }).eq("id", topicId),
      "moving a topic to another class"
    );
    const { data: topicRow } = await supabase.from("discussion_topics").select("class_id").eq("id", topicId).single();
    expect(topicRow!.class_id).toBe(classA.id);
    const renamed = await client
      .from("discussion_topics")
      .update({ description: `E2E description ${++unique}` })
      .eq("id", topicId)
      .select("id");
    expect(renamed.data, "other topic edits still work").toHaveLength(1);

    const threadB = await newRoot(classB.id, studentB);
    const threadA = await newRoot(classA.id, student);
    const pin = (discussion_thread_id: number) =>
      client
        .from("error_pins")
        .insert({ discussion_thread_id, class_id: classA.id, created_by: instructorA.private_profile_id });
    expectRefused(await pin(threadB), "a class A pin on a class B thread");
    expect((await pin(threadA)).error, "a pin on its own class's thread").toBeNull();
  });

  test("error-pin matches leave out private threads", async () => {
    const assignment = await insertAssignment({
      class_id: classA.id,
      due_date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      assignment_slug: `e2e-pins-${Date.now().toString(36)}`
    });
    const { submission_id } = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classA.id
    });
    const publicThread = await newRoot(classA.id, otherStudent);
    const privateThread = await privateRoot(classA.id, otherStudent);
    for (const discussion_thread_id of [publicThread, privateThread]) {
      const { data: pin, error } = await supabase
        .from("error_pins")
        .insert({
          discussion_thread_id,
          class_id: classA.id,
          assignment_id: assignment.id,
          created_by: instructor.private_profile_id
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      expect(
        (await supabase.from("error_pin_submission_matches").insert({ error_pin_id: pin!.id, submission_id })).error
      ).toBeNull();
    }
    const { data, error } = await (
      await createAuthenticatedClient(student)
    ).rpc("get_error_pin_matches_for_submission", { p_submission_id: submission_id });
    expect(error).toBeNull();
    const threads = (data as { discussion_thread_id: number }[]).map((m) => m.discussion_thread_id);
    expect(threads, "the student sees the public thread's pin only").toEqual([publicThread]);
  });

  test("the unused watcher cache and ordinal counter tables are gone", async () => {
    for (const table of ["discussion_thread_watcher_cache", "discussion_thread_ordinal_counters"]) {
      const { error } = await supabase
        .from(table as "discussion_threads")
        .select("*")
        .limit(1);
      expect(error, `${table} no longer exists`).not.toBeNull();
    }
  });
});
