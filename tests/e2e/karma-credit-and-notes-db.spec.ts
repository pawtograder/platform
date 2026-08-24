import { expect, test } from "@playwright/test";
import { createAuthenticatedClient, createClass, createUserInClass, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// Regression coverage for the two karma defects fixed in
// supabase/migrations/20260824120100_karma_credits_authoring_profile_and_karma_notes_broadcast.sql.
// Both shipped with ZERO tests, which is how one of them stayed 100% broken for
// eleven months. These are pure DB-integration tests: no browser, so they pin the
// trigger/RPC contracts the UI depends on.
//
// PART B: broadcast_help_request_staff_data_change() read NEW/OLD.help_request_id
//   in its student_karma_notes branch. That column does not exist on that table,
//   and plpgsql only resolves record fields at execution time, so every write to
//   student_karma_notes aborted with `record "new" has no field "help_request_id"`.
// PART A: update_discussion_karma() credited the author's PRIVATE profile even for
//   anonymous posts, while discussion bylines render the karma of `thread.author`
//   verbatim (hooks/useUserProfiles.tsx via useUserProfile(thread.author)), so karma
//   earned pseudonymously always displayed as 0.
test.describe("discussion karma credit + office-hours karma notes", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let topicId: number;
  let instructor: TestingUser;
  let author: TestingUser;
  let liker: TestingUser;

  async function karmaOf(profileId: string): Promise<number> {
    const { data, error } = await supabase.from("profiles").select("discussion_karma").eq("id", profileId).single();
    expect(error).toBeNull();
    return data!.discussion_karma;
  }

  async function insertThread(authorProfileId: string, subject: string): Promise<number> {
    const { data, error } = await supabase
      .from("discussion_threads")
      .insert({
        subject,
        body: "Karma regression fixture body.",
        topic_id: topicId,
        is_question: false,
        instructors_only: false,
        author: authorProfileId,
        class_id: classId,
        draft: false,
        root_class_id: classId
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function like(threadId: number, creatorProfileId: string): Promise<void> {
    const { error } = await supabase
      .from("discussion_thread_likes")
      .insert({ discussion_thread: threadId, creator: creatorProfileId, emoji: "👍" });
    expect(error).toBeNull();
  }

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Karma ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Karma Instructor ${suffix}`,
      email: `e2e-karma-instructor-${suffix}@pawtograder.net`
    });
    author = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Karma Author ${suffix}`,
      email: `e2e-karma-author-${suffix}@pawtograder.net`
    });
    liker = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Karma Liker ${suffix}`,
      email: `e2e-karma-liker-${suffix}@pawtograder.net`
    });

    // Classes are provisioned with default discussion topics.
    const { data: topicRow, error: topicErr } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", classId)
      .order("ordinal", { ascending: true })
      .limit(1)
      .maybeSingle();
    expect(topicErr).toBeNull();
    if (!topicRow) {
      throw new Error(`No discussion topic provisioned for class ${classId}`);
    }
    topicId = topicRow.id;
  });

  // PART B. Fails with `record "new" has no field "help_request_id"` if the
  // student_karma_notes branch of broadcast_help_request_staff_data_change() ever
  // reads a column that table does not have. The broadcast trigger is AFTER ... FOR
  // EACH ROW with nothing catching it, so the exception aborts the caller's write:
  // the round trip below is the whole feature.
  test("student_karma_notes survives an insert/update/delete round trip", async () => {
    const { data: created, error: insertError } = await supabase
      .from("student_karma_notes")
      .insert({
        class_id: classId,
        student_profile_id: author.private_profile_id,
        karma_score: 5,
        internal_notes: "Helped a classmate debug their submission.",
        created_by_id: instructor.user_id,
        last_activity_at: new Date().toISOString()
      })
      .select("id, karma_score")
      .single();
    expect(insertError).toBeNull();
    expect(created!.karma_score).toBe(5);

    const { data: updated, error: updateError } = await supabase
      .from("student_karma_notes")
      .update({ karma_score: 7 })
      .eq("id", created!.id)
      .select("id, karma_score")
      .single();
    expect(updateError).toBeNull();
    expect(updated!.karma_score).toBe(7);

    const { error: deleteError } = await supabase.from("student_karma_notes").delete().eq("id", created!.id);
    expect(deleteError).toBeNull();

    const { data: gone, error: readError } = await supabase
      .from("student_karma_notes")
      .select("id")
      .eq("id", created!.id)
      .maybeSingle();
    expect(readError).toBeNull();
    expect(gone).toBeNull();
  });

  // PART A. A like on an anonymous post must credit the PUBLIC profile, because that
  // is the profile the byline renders. Crediting the private profile instead is not
  // just invisible: showing the private profile's total on a pseudonymous byline
  // would let a classmate match a distinctive number against the same student's
  // named posts and deanonymize them. Karma is per-identity on purpose.
  test("a like on a pseudonymous post credits the public profile the byline renders", async () => {
    const publicBefore = await karmaOf(author.public_profile_id);
    const privateBefore = await karmaOf(author.private_profile_id);

    const threadId = await insertThread(author.public_profile_id, "Pseudonymous karma post");
    await like(threadId, liker.private_profile_id);

    expect(await karmaOf(author.public_profile_id)).toBe(publicBefore + 1);
    expect(await karmaOf(author.private_profile_id)).toBe(privateBefore);

    // Unliking must decrement the same row it credited.
    const { error: unlikeError } = await supabase
      .from("discussion_thread_likes")
      .delete()
      .eq("discussion_thread", threadId);
    expect(unlikeError).toBeNull();

    expect(await karmaOf(author.public_profile_id)).toBe(publicBefore);
    expect(await karmaOf(author.private_profile_id)).toBe(privateBefore);
  });

  test("a like on a named post credits the private profile", async () => {
    const publicBefore = await karmaOf(author.public_profile_id);
    const privateBefore = await karmaOf(author.private_profile_id);

    const threadId = await insertThread(author.private_profile_id, "Named karma post");
    await like(threadId, liker.private_profile_id);

    expect(await karmaOf(author.private_profile_id)).toBe(privateBefore + 1);
    expect(await karmaOf(author.public_profile_id)).toBe(publicBefore);
  });

  // The per-identity split must not cost instructors their whole-student view.
  // get_discussion_engagement sums both profiles; it is the only place that is
  // allowed to, because it is staff-only.
  test("get_discussion_engagement sums both identities for staff and refuses students", async () => {
    const namedThread = await insertThread(author.private_profile_id, "Named post for engagement roll-up");
    await like(namedThread, liker.private_profile_id);
    const pseudoThread = await insertThread(author.public_profile_id, "Pseudonymous post for engagement roll-up");
    await like(pseudoThread, liker.private_profile_id);

    const publicKarma = await karmaOf(author.public_profile_id);
    const privateKarma = await karmaOf(author.private_profile_id);
    expect(publicKarma).toBeGreaterThan(0);
    expect(privateKarma).toBeGreaterThan(0);

    const instructorClient = await createAuthenticatedClient(instructor);
    const { data: engagement, error: engagementError } = await instructorClient.rpc("get_discussion_engagement", {
      p_class_id: classId
    });
    expect(engagementError).toBeNull();
    const row = engagement!.find((r) => r.profile_id === author.private_profile_id);
    expect(row).toBeDefined();
    // The roll-up is keyed on the private profile but counts both identities, so
    // pseudonymous karma is not lost to instructors.
    expect(row!.discussion_karma).toBe(publicKarma + privateKarma);
    expect(row!.likes_received).toBe(publicKarma + privateKarma);

    // Students must not be able to read the aggregated cross-identity total.
    const studentClient = await createAuthenticatedClient(liker);
    const { error: deniedError } = await studentClient.rpc("get_discussion_engagement", { p_class_id: classId });
    expect(deniedError).not.toBeNull();
    expect(deniedError!.message).toContain("Access denied");
  });
});
