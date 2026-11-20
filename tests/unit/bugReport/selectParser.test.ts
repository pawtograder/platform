import { classifyResponse, classifyRows, parseSelect, resolveEmbed } from "@/lib/bugReport/selectParser";

const REST = "https://api.example.test/rest/v1";
const FN = "https://api.example.test/functions/v1";

function kinds(result: { values: { value: string; kind: string; source: string }[] }) {
  return result.values.map((v) => [v.value, v.kind, v.source]);
}

describe("parseSelect", () => {
  it("parses aliases, hints, embeds, and star", () => {
    const tree = parseSelect(
      "*, assignment_groups_members(*), mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)"
    );
    expect(tree.star).toBe(true);
    expect(tree.items).toEqual([
      {
        key: "assignment_groups_members",
        name: "assignment_groups_members",
        hints: [],
        children: { star: true, items: [] }
      },
      {
        key: "mentor",
        name: "profiles",
        hints: ["assignment_groups_mentor_profile_id_fkey"],
        children: { star: false, items: [{ key: "name", name: "name", hints: [] }] }
      }
    ]);
  });

  it("handles stacked hints, column aliases, json paths, casts, and whitespace", () => {
    const tree = parseSelect(`
      id,
      submissions!grader_result_tests_submission_id_fkey!inner(id, assignment_id),
      display:sortable_name,
      data->>label,
      raw:data->nested->>x,
      score::text
    `);
    expect(tree.items.map((i) => [i.key, i.name, i.hints])).toEqual([
      ["id", "id", []],
      ["submissions", "submissions", ["grader_result_tests_submission_id_fkey", "inner"]],
      ["display", "sortable_name", []],
      ["label", "data", []],
      ["raw", "data", []],
      ["score", "score", []]
    ]);
  });
});

describe("resolveEmbed", () => {
  it("uses the relation name when the embed names a relation", () => {
    expect(resolveEmbed("user_roles", { key: "profiles", name: "profiles", hints: ["private_profile_id"] })).toBe(
      "profiles"
    );
  });
  it("resolves an FK column or constraint name to the referenced table, not a view", () => {
    expect(resolveEmbed("help_requests", { key: "assignee", name: "assignee", hints: [] })).toBe("profiles");
    expect(resolveEmbed("help_requests", { key: "a", name: "help_requests_assignee_fkey", hints: [] })).toBe(
      "profiles"
    );
  });
  it("resolves through a hint when the name is neither", () => {
    expect(resolveEmbed("help_requests", { key: "x", name: "nope", hints: ["help_requests_assignee_fkey"] })).toBe(
      "profiles"
    );
    expect(resolveEmbed("help_requests", { key: "x", name: "nope", hints: [] })).toBeNull();
  });
});

describe("classifyResponse: PostgREST", () => {
  it("maps an alias with an FK hint to the embedded table's columns (D2 shape)", () => {
    const url = `${REST}/assignment_groups?select=*,assignment_groups_members(*),mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)&class_id=eq.1`;
    const body = [
      {
        id: 1,
        class_id: 1,
        name: "Team Rocket",
        mentor_profile_id: "0b0f5a7e-0000-0000-0000-000000000001",
        assignment_groups_members: [{ id: 5, profile_id: "0b0f5a7e-0000-0000-0000-000000000002" }],
        mentor: { name: "Canary Mentorsson" }
      }
    ];
    const result = classifyResponse(url, "GET", body);
    expect(result.handled).toBe(true);
    expect(kinds(result)).toEqual([
      ["Team Rocket", "free_text", "assignment_groups.name"],
      ["Canary Mentorsson", "name", "profiles.name"]
    ]);
    expect(result.unclassified).toEqual([]);
  });

  it("follows a column-name hint and a second embed", () => {
    const url = `${REST}/user_roles?select=private_profile_id,profiles!private_profile_id(name,sortable_name),users(email)`;
    const body = [
      {
        private_profile_id: "p1",
        profiles: { name: "Jane Canary", sortable_name: "Canary, Jane" },
        users: { email: "jane.canary@example.test" }
      }
    ];
    expect(kinds(classifyResponse(url, "GET", body))).toEqual([
      ["Jane Canary", "name", "profiles.name"],
      ["Canary, Jane", "name", "profiles.sortable_name"],
      ["jane.canary@example.test", "email", "users.email"]
    ]);
  });

  it("walks nested embeds of arrays and objects", () => {
    const url = `${REST}/help_requests?select=id,request,help_request_messages(message,author,profiles!help_request_messages_author_fkey(name))`;
    const body = {
      id: 3,
      request: "My code prints Jane's name",
      help_request_messages: [
        { message: "Try again", author: "p1", profiles: { name: "Ta Canary" } },
        { message: null, author: "p2", profiles: null }
      ]
    };
    expect(kinds(classifyResponse(url, "POST", body))).toEqual([
      ["My code prints Jane's name", "free_text", "help_requests.request"],
      ["Try again", "free_text", "help_request_messages.message"],
      ["Ta Canary", "name", "profiles.name"]
    ]);
  });

  it("maps every key through the relation's columns for select=* and for no select", () => {
    const row = {
      id: "p1",
      name: "Star Canary",
      sortable_name: "Canary, Star",
      avatar_url: null,
      discussion_karma: 12
    };
    const expected = [
      ["Star Canary", "name", "profiles.name"],
      ["Canary, Star", "name", "profiles.sortable_name"],
      ["12", "grade", "profiles.discussion_karma"]
    ];
    expect(kinds(classifyResponse(`${REST}/profiles?select=*`, "GET", [row]))).toEqual(expected);
    expect(kinds(classifyResponse(`${REST}/profiles?id=eq.p1`, "GET", [row]))).toEqual(expected);
  });

  it("uses the aliased column's kind and the base column of a json path", () => {
    const url = `${REST}/profiles?select=display:sortable_name,id`;
    expect(kinds(classifyResponse(url, "GET", [{ display: "Canary, Al", id: "x" }]))).toEqual([
      ["Canary, Al", "name", "profiles.sortable_name"]
    ]);
    const jsonUrl = `${REST}/survey_responses?select=id,answer:response->q1`;
    expect(kinds(classifyResponse(jsonUrl, "GET", [{ id: "r", answer: { text: "I am Al" } }]))).toEqual([
      ["I am Al", "free_text", "survey_responses.response"]
    ]);
  });

  it("reports keys it cannot classify instead of guessing", () => {
    const url = `${REST}/profiles?select=id,name,mystery(*)`;
    const result = classifyResponse(url, "GET", [{ id: "p", name: "Al Canary", mystery: [{ x: 1 }], extra: "?" }]);
    expect(kinds(result)).toEqual([["Al Canary", "name", "profiles.name"]]);
    expect(result.unclassified.sort()).toEqual(["profiles.extra", "profiles.mystery (embed)"]);
  });

  it("skips count aggregates and nulls", () => {
    const url = `${REST}/assignment_groups?select=id,assignment_groups_members(count)`;
    const result = classifyResponse(url, "GET", [{ id: 1, assignment_groups_members: [{ count: 3 }] }]);
    expect(result.values).toEqual([]);
    expect(result.unclassified).toEqual([]);
  });
});

describe("classifyResponse: RPC", () => {
  it("classifies a Json return through its JSONPath map (D6 shape)", () => {
    const body = {
      help_requests: [{ id: 1, request: "Help with Canary's bug" }],
      assignments: [{ id: 2, title: "HW1", autograder_score: 87.31, total_score: 90 }]
    };
    const result = classifyResponse(`${REST}/rpc/get_student_summary`, "POST", body);
    expect(kinds(result)).toEqual([
      ["Help with Canary's bug", "free_text", "rpc:get_student_summary $.help_requests[*].request"],
      ["87.31", "grade", "rpc:get_student_summary $.assignments[*].autograder_score"],
      ["90", "grade", "rpc:get_student_summary $.assignments[*].total_score"]
    ]);
    expect(result.unclassified).toEqual([]);
  });

  it("classifies SETOF table rows through COLUMNS, honoring select=", () => {
    const result = classifyResponse(`${REST}/rpc/get_submission_checks?select=actor_login,id`, "POST", [
      { actor_login: "canary-gh", id: 1 }
    ]);
    expect(kinds(result)).toEqual([["canary-gh", "handle", "workflow_events.actor_login"]]);
  });

  it("classifies scalar and array-of-scalar returns with the RPC's kind", () => {
    expect(kinds(classifyResponse(`${REST}/rpc/class_team_member_usernames`, "POST", ["gh-a", "gh-b"]))).toEqual([
      ["gh-a", "handle", "rpc:class_team_member_usernames"],
      ["gh-b", "handle", "rpc:class_team_member_usernames"]
    ]);
    expect(classifyResponse(`${REST}/rpc/authorizeforclass`, "POST", true).values).toEqual([]);
  });

  it("classifies RETURNS TABLE results by column", () => {
    const result = classifyResponse(`${REST}/rpc/admin_get_disabled_users`, "POST", [
      { user_email: "x.canary@example.test", user_name: "X Canary", user_role_id: 4 }
    ]);
    expect(kinds(result)).toEqual([
      ["x.canary@example.test", "email", "rpc:admin_get_disabled_users $[*].user_email"],
      ["X Canary", "name", "rpc:admin_get_disabled_users $[*].user_name"]
    ]);
  });

  it("reports an unknown RPC", () => {
    expect(classifyResponse(`${REST}/rpc/not_a_function`, "POST", {}).unclassified).toEqual(["rpc:not_a_function"]);
  });
});

describe("classifyResponse: edge functions", () => {
  it("classifies GitHub usernames and commit authors (D7 shape)", () => {
    const body = {
      commits: [
        {
          sha: "abc",
          commit: { message: "fix", author: { name: "Git Canary", email: "git.canary@example.test", date: "d" } },
          author: { login: "canary-gh", id: 7, avatar_url: "https://avatars.example/u/7" }
        }
      ],
      has_more: false
    };
    const result = classifyResponse(`${FN}/repository-list-commits`, "POST", body);
    expect(kinds(result)).toEqual([
      ["fix", "free_text", "edge:repository-list-commits $.commits[*].commit.message"],
      ["Git Canary", "name", "edge:repository-list-commits $.commits[*].commit.author.name"],
      ["git.canary@example.test", "email", "edge:repository-list-commits $.commits[*].commit.author.email"],
      ["canary-gh", "handle", "edge:repository-list-commits $.commits[*].author.login"],
      ["https://avatars.example/u/7", "handle", "edge:repository-list-commits $.commits[*].author.avatar_url"]
    ]);
  });

  it("unions the wrappers that share a slug and classifies error bodies", () => {
    const status = { email: "i.canary@example.test", githubUsername: "i-canary", courseId: 1 };
    const result = classifyResponse(`${FN}/github-user-sync`, "POST", { message: "ok", status });
    expect(kinds(result)).toEqual([
      ["ok", "free_text", "edge:github-user-sync $.message"],
      ["i.canary@example.test", "email", "edge:github-user-sync $.status.email"],
      ["i-canary", "handle", "edge:github-user-sync $.status.githubUsername"]
    ]);
    const error = { error: { recoverable: false, message: "i-canary is not in the org", details: "same" } };
    expect(kinds(classifyResponse(`${FN}/assignment-group-join`, "POST", error))).toEqual([
      ["i-canary is not in the org", "free_text", "edge:assignment-group-join $.error.message"],
      ["same", "free_text", "edge:assignment-group-join $.error.details"]
    ]);
  });

  it("reports an edge function no wrapper classifies", () => {
    expect(classifyResponse(`${FN}/submission-serve-artifact`, "POST", { url: "x" }).unclassified).toEqual([
      "edge:submission-serve-artifact"
    ]);
  });
});

describe("classifyResponse: other URLs", () => {
  it("does not handle non-Supabase URLs or HEAD requests", () => {
    expect(classifyResponse("/api/tunnel", "POST", {}).handled).toBe(false);
    expect(classifyResponse(`${REST}/profiles`, "HEAD", null).handled).toBe(false);
  });
});

describe("classifyRows", () => {
  it("classifies realtime / TableController rows of a relation", () => {
    expect(
      kinds(classifyRows("users", { user_id: "u", github_username: "rt-canary", sis_user_id: 123456789 }))
    ).toEqual([
      ["rt-canary", "handle", "users.github_username"],
      ["123456789", "handle", "users.sis_user_id"]
    ]);
  });
});
