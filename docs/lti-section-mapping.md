# LTI Section Mapping & Provisioning Governance — Design

Status: **Proposed** · Owner: Jon Bell · Companion to [`lti-1.3-integration.md`](./lti-1.3-integration.md)

This document specifies how Pawtograder maps Canvas (LMS) courses and sections onto
Pawtograder classes, lecture sections, and lab sections over LTI 1.3, and the
admin/instructor governance model around provisioning. It exists because the current
LTI roster sync enrolls every member **course-wide** (both section CRNs are hardcoded
`null`), which does not satisfy Northeastern's requirement that sections — including a
separately-provisioned lab — are mandatory.

## 1. Requirements

1. **Sections are mandatory.** Students synced from Canvas must land in the correct
   Pawtograder lecture section and/or lab section, not course-wide.
2. **Lab is a separate Canvas course.** The lab is provisioned as its own Canvas
   course, distinct from the lecture course. The Pawtograder LTI tool is installed on
   **both**, and both link to the **same** Pawtograder class.
3. **Two lab topologies must both be supported** (the actual provisioning is not yet
   locked down, so we build for either):
   - **(A) One Canvas course per lab section** — section is implied by which context
     launched / synced.
   - **(B) One Canvas course containing many lab sections** — members must be split into
     the right Pawtograder lab section using per-member section data.
4. **Multiple Canvas courses → one Pawtograder class.** A general, admin-configured
   case (of which lecture+lab is one instance): several Canvas courses — e.g. each
   lecture section provisioned as its own Canvas course, or cross-listed sections — all
   bind to a single Pawtograder class. Roster sync must union them without cross-dropping,
   and grade push must route each student's score to the line item in _their_ Canvas
   course. Binding the set of contexts to a class is an **admin** action.
5. **Governance / self-serve model:**
   - **Site admins** configure platforms/deployments, bind a context to a Pawtograder
     class, define **course-code rules** (auto-binding for all instances of a course
     code), and exclusively control **which GitHub org pairs with which class**.
   - **Instructors** get self-serve mapping, but only within classes an admin has
     **pre-configured**. They may link their launched context, designate lecture vs lab,
     and map sections — but may **not** choose the GitHub org or create classes.

## 2. Current state (what we have)

The data model below already supports independent lecture + lab section assignment; the
gap is in the LTI roster-sync glue and the absence of a mapping UI / governance layer.

| Capability                            | Status | Evidence                                                                                                                                                                                            |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lecture sections with SIS CRN         | ✅     | `class_sections(name, sis_crn, ...)` — `20250820185937_admin_portal_system.sql:660`                                                                                                                 |
| Lab sections with SIS CRN             | ✅     | `lab_sections(name, sis_crn, day_of_week, ...)` — `20250712142950_lab-sections.sql:24`, CRN added `20250820185937:691`                                                                              |
| Student → both sections               | ✅     | `user_roles.class_section_id` + `lab_section_id` — `20250712142950_lab-sections.sql:68`                                                                                                             |
| RPC sets both sections per-member     | ✅     | `sis_sync_enrollment(p_class_id, p_roster_data, p_sync_options)` accepts `class_section_crn` + `lab_section_crn` — `20251219183000_sis_sync_atomic.sql:45`                                          |
| Section-scoped drop (`drop_missing`)  | ✅     | drop limited to sync-enabled sections — see §6                                                                                                                                                      |
| Many contexts → one class (schema)    | ✅     | `lti_context_links` unique on `(platform_id, deployment_id, context_id)`, **no** unique on `class_id` — `20260528120000_lti_1_3_integration.sql:93`                                                 |
| Line items per context                | ✅     | `lti_line_items` unique on `(context_link_id, assignment_id)` and `(context_link_id, gradebook_column_id)` — `20260528120000:149` — same assignment can have a distinct line item per Canvas course |
| Roster sync runs per-context          | ✅     | `syncContextRoster(link)` / `syncAllRosters()` loops each link — `lib/lti/roster.ts:51,104`                                                                                                         |
| GitHub org bound to class             | ✅     | `classes.github_org` (text) — `20250330003141_remote_schema.sql:1021`; edited admin-only via `app/admin/classes/EditClassModal.tsx`                                                                 |
| **LTI roster sync sets sections**     | ❌     | `class_section_crn`/`lab_section_crn` hardcoded `null` — `lib/lti/util.ts:75`, passed in `lib/lti/roster.ts`                                                                                        |
| **Context section designation**       | ❌     | no column on `lti_context_links` marking lecture vs lab or attaching a section                                                                                                                      |
| **Grade push is multi-context-aware** | ❌     | `getGradeContext()` does `.limit(1)` — pushes to one arbitrary context, never routes per student — `lib/lti/grades.ts:38`                                                                           |
| **Per-student context membership**    | ❌     | `lti_users` is `(platform_id, sub)` global, **no** `context_link_id` — `20260528120000:184`; can't tell which Canvas course a student belongs to                                                    |
| **Mapping / governance UI**           | ❌     | `app/course/[course_id]/manage/course/lti/page.tsx` only toggles sync on/off; class link is set by hand in DB                                                                                       |

### The unlock: per-member sections from Canvas NRPS

By default Canvas NRPS returns no section info. Canvas exposes the custom variable
`$com.instructure.User.sectionNames`, which — when added as a **custom field** on the LTI
tool config — is substituted **per member** inside each NRPS membership record (in the
member's `message` array). This makes topology (B) achievable with pure LTI, no Canvas
REST API token required.

> Caveat: the claim returns section **names** (e.g. `["L05 Mon 9:15"]`), an array of
> strings — not CRNs. Matching is therefore by an explicit name→section map, not by the
> `sis_crn` the RPC keys on. We resolve names → Pawtograder section → its `sis_crn`
> before calling the RPC.

Reference: [Canvas community — section membership via NRPS](https://community.canvaslms.com/t5/Canvas-Developers-Group/Can-section-membership-be-retrieved-via-the-LTI-1-3-NRPS-API/m-p/586352),
[LTI variable substitutions](https://canvas.instructure.com/doc/api/file.tools_variable_substitutions.html).

## 3. Data model changes

### 3.1 `lti_context_links` — section role

Add a `section_role` to declare what a linked Canvas context represents:

```sql
ALTER TABLE public.lti_context_links
  ADD COLUMN section_role text NOT NULL DEFAULT 'course_wide'
    CHECK (section_role IN ('lecture', 'lab', 'course_wide')),
  -- topology (A): the whole context maps to exactly one section
  ADD COLUMN class_section_id bigint REFERENCES public.class_sections(id),
  ADD COLUMN lab_section_id  bigint REFERENCES public.lab_sections(id),
  -- topology (B): members are split by Canvas section name (see 3.2)
  ADD COLUMN split_by_member_section boolean NOT NULL DEFAULT false;
```

- `section_role='lecture'` + `class_section_id` set → topology (A) lecture course.
- `section_role='lab'` + `lab_section_id` set → topology (A) lab course (one section).
- `section_role='lab'` + `split_by_member_section=true` → topology (B); per-member split
  via the map below.
- `section_role='course_wide'` → current behavior (no section), preserved for
  back-compat.

### 3.2 `lti_context_section_map` — name→section (topology B)

```sql
CREATE TABLE public.lti_context_section_map (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context_link_id bigint NOT NULL REFERENCES public.lti_context_links(id) ON DELETE CASCADE,
  canvas_section_name text NOT NULL,            -- value seen in $com.instructure.User.sectionNames
  class_section_id bigint REFERENCES public.class_sections(id),
  lab_section_id  bigint REFERENCES public.lab_sections(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_link_id, canvas_section_name),
  CHECK (num_nonnulls(class_section_id, lab_section_id) = 1)
);
```

### 3.3 Course-code rules (governance, Phase 2)

```sql
CREATE TABLE public.lti_course_code_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id bigint NOT NULL REFERENCES public.lti_platforms(id),
  course_code text NOT NULL,                    -- matched against context_label / a custom claim
  class_template_id bigint REFERENCES public.classes(id),  -- optional: bind/clone target
  github_org text,                              -- admin-set; instructors cannot override
  default_section_role text CHECK (default_section_role IN ('lecture','lab','course_wide')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_id, course_code)
);
```

On launch, if a context is unlinked and its course code matches a rule, auto-create the
`lti_context_links` row pre-bound per the rule (class + section_role + github_org), so the
instructor's self-serve view starts from a sane default.

### 3.4 RLS

- `lti_platforms`, `lti_course_code_rules`, and `classes.github_org` edits: **site admin only** (existing admin pattern).
- `lti_context_links` and `lti_context_section_map`: **service role + instructor** of the
  bound `class_id` may read and edit _section mapping / sync toggles only_ — never
  `class_id` rebinding or `github_org`. Enforce the class-rebinding restriction with a
  column-level policy or a `BEFORE UPDATE` trigger that rejects `class_id` changes from
  non-admins.

## 4. Roster sync changes

In `lib/lti/util.ts` / `lib/lti/roster.ts`:

1. **Read the section claim.** When mapping NRPS members, pull
   `member.message[].["https://.../custom"].section_names` (the substituted
   `$com.instructure.User.sectionNames`). Today `membersToRoster()` hardcodes both CRNs
   to `null` (`util.ts:75`).
2. **Resolve section by context config:**
   - `section_role='lecture'`, context-level → set every member's `class_section_crn` to
     the mapped `class_section.sis_crn`.
   - `section_role='lab'`, context-level → set `lab_section_crn` to the mapped
     `lab_section.sis_crn`.
   - `split_by_member_section=true` → for each member, look up each `section_names` entry
     in `lti_context_section_map`, resolve to a `class_section`/`lab_section`, and emit its
     `sis_crn`. Members whose Canvas section has no map entry are reported as **unmapped**
     (surfaced in the sync result, not silently dropped).
3. **Pass real CRNs** into `sis_sync_enrollment` instead of `null`.

## 5. UI

### 5.1 Instructor (`app/course/[course_id]/manage/course/lti/`)

Extend the existing context-link card (today only sync toggles) with:

- **Section role** selector: Lecture / Lab / Course-wide.
- For context-level mapping: a dropdown to pick the target Pawtograder section.
- For `split_by_member_section`: a table of Canvas section names (discovered from the
  last NRPS fetch) each with a dropdown to the matching Pawtograder section; show
  **unmapped** sections prominently.
- Read-only: bound class, GitHub org (instructors cannot change these).

Gated so instructors only see contexts whose `class_id` is a class they instruct, and
only when that class was pre-configured by an admin.

### 5.2 Site admin (`app/admin/`)

- Platform/deployment registry (exists in part).
- Context → class binding (today done by hand in DB).
- Course-code rules editor (Phase 2), including the **GitHub org** field — admin only.

## 6. Why lab sync won't clobber lecture enrollments

`sis_sync_enrollment`'s drop/disable logic is **section-scoped** to sync-enabled sections.
`sis_sync_status` (`20250820193612_sis_sync_cron_job.sql:5`) carries `sync_enabled`
per section (a row references exactly one of `course_section_id` / `lab_section_id`). The
RPC builds `tmp_enabled_class_sections` / `tmp_enabled_lab_sections` excluding any section
with `sync_enabled=false` (`20251219183000_sis_sync_atomic.sql:128–152`), then guards the
drop:

```sql
-- enrollment disable (20251219183000:494–517)
AND (ur.class_section_id IS NULL OR ur.class_section_id IN (SELECT id FROM tmp_enabled_class_sections))
AND (ur.lab_section_id  IS NULL OR ur.lab_section_id  IN (SELECT id FROM tmp_enabled_lab_sections))
```

So if the lab context's sync enables **only** lab sections, a lecture-only student
(`class_section_id` = a lecture section, not in the enabled set) fails the predicate and
is **not** disabled. The mechanism we rely on: **each context's sync must enable only the
sections it owns.**

> **Open risk (see §9):** the predicate is an AND across both section types. A student
> enrolled in _both_ lecture and lab, who is removed from the lab Canvas roster, will
> **not** be dropped from the lab — because their lecture `class_section_id` is not in the
> enabled set, failing the AND. This is conservative (never over-drops) but means lab
> de-enrollment of dual-enrolled students won't propagate. Decide whether that's
> acceptable or whether the RPC's drop predicate needs an OR/role-aware variant.

## 7. Multiple Canvas courses → one Pawtograder class

Lecture+lab is one instance of a broader admin-configured pattern: N Canvas contexts
binding to one Pawtograder class (e.g. each lecture section as its own Canvas course, or
cross-listed sections). The schema already permits it (no unique constraint on
`lti_context_links.class_id`; line items are per-context, §2). Three things must work.

### 7.1 Admin binds the set of contexts (governance)

Binding a context to a `class_id` is an **admin** action (instructors only self-serve
section mapping within a pre-bound class — §1.5). The admin UI (§5.2) lists contexts for a
platform and binds each to a class; multiple contexts may target the same class. A
course-code rule (§3.3) can pre-bind contexts on first launch so a new lecture-section
Canvas course auto-joins the right class.

### 7.2 Roster union without cross-dropping

`syncContextRoster` already runs **per context-link** (`roster.ts:51`), each calling
`sis_sync_enrollment(class_id, …, drop_missing=true)`. The danger: syncing context B with
`drop_missing` would disable a student present only in context A (both bound to the same
class), because `lti_users` has no per-context membership (§2). The protection is the
**section scoping** of §6: each context must enable **only the sections it owns**, so a
student in context A's section is excluded from context B's drop set. This makes
mandatory section designation (§3.1) a correctness requirement for multi-context, not just
a feature — a `course_wide` context in a multi-context class is unsafe with `drop_missing`
and must be rejected or forced to `drop_missing=false`.

### 7.3 Grade push must route per student (the real gap)

`getGradeContext()` does `.limit(1)` (`grades.ts:38`) — it pushes every student's score to
a single arbitrary context's line item. With N contexts this is wrong: a student's score
must go to the line item in the Canvas course they're actually enrolled in.

`lti_users` can't answer "which context?" (no `context_link_id`). Rather than add context
tracking, **route by the section mapping we're already building:**

1. Enumerate the class's contexts that have `grade_sync_enabled` and an AGS endpoint.
2. For each context, resolve the set of Pawtograder sections it owns (from
   `class_section_id` / `lab_section_id` / `lti_context_section_map`).
3. For each released grade, look up the student's `class_section_id` / `lab_section_id`
   (`user_roles`) and push the score **only** to the line item of the context that owns
   that section. Ensure the line item exists per-context (the table already keys on
   `context_link_id`).

This reuses the section→context mapping, needs no `lti_users` schema change, and naturally
handles "each lecture section is its own Canvas course." Implementation: replace
`getGradeContext()`'s single-context fetch with a context-set resolver and a
section→context index; iterate students through it.

> Fallback for `course_wide` single-context classes (today's behavior): if a class has
> exactly one grade-sync context and no section designation, keep the current
> push-to-one-context path. Per-student routing only engages when >1 grade-sync context
> exists. Optionally add a `lti_user_contexts(context_link_id, user_id)` join table
> (populated from each NRPS sync, which _does_ know per-context membership) as a fully
> general fallback when section routing is ambiguous.

## 8. Canvas configuration (Developer Key)

Required before the real-Canvas test:

- Redirect URI → `/api/lti/launch`; OIDC init → `/api/lti/login`; JWKS → `/api/lti/jwks`.
- **Custom field:** `section_names=$com.instructure.User.sectionNames`.
- **Enable email release** — `lib/lti/session.ts:26` hard-fails the launch without it.
- **Grant scopes:** AGS `lineitem` + `score`, and NRPS `contextmembership.readonly`.
- Confirm `lti_platforms.issuer` matches Canvas's issuer.

## 9. Open questions / risks

1. **Dual-enrolled drop semantics** (§6) — propagate lab de-enrollment for students who
   remain in lecture, or keep the conservative AND?
2. **Section name stability** — topology (B) maps by Canvas section _name_; renames in
   Canvas break the map until re-mapped. Acceptable with the "unmapped" surfacing, or do
   we need a more stable key (Canvas section id, if obtainable per-member)?
3. **Course-code matching source** — match on `context_label`, or request a dedicated
   custom claim (e.g. `$Canvas.course.sisSourceId`) for a reliable code?
4. **Class auto-creation vs bind-only** — do course-code rules bind to an existing class,
   or clone a template class per term? (Affects GitHub-org provisioning timing.)
5. **Grade-push routing fallback** (§7.3) — is section-based routing always sufficient, or
   do we need the `lti_user_contexts` join table for classes that legitimately mix a
   `course_wide` context with sectioned ones?
6. **`course_wide` in a multi-context class** (§7.2) — reject it outright, or auto-force
   `drop_missing=false` for it? Either prevents cross-dropping; pick one.

## 10. Phasing

**Phase 1 — required for the real-Canvas test (sections working):**

- §3.1 + §3.2 schema; §4 roster-sync changes; minimal §5.1 instructor mapping UI; §8
  Canvas config. Admin may seed the class link by hand initially.
- **Deterministic grade-push context selection** (§7.3): even with a single lecture+lab
  pair, the current `.limit(1)` may pick the lab context. At minimum, select the
  grade-sync context whose section owns the student before the full multi-context router
  lands — otherwise grades can post to the wrong Canvas course.

**Phase 2 — multi-context + governance (after the protocol is proven on real Canvas):**

- §7.3 per-student grade-push router; §3.3 course-code rules + launch auto-apply; §5.2
  admin UI (incl. binding multiple contexts to one class); instructor self-serve gating;
  admin/course-code GitHub-org control. Deep Linking remains optional (see
  `lti-1.3-integration.md`).

## 11. Test plan

- **Topology A:** two Canvas courses (lecture + one lab) → both linked to one class →
  roster sync lands students in the correct lecture / lab section; lab sync does not drop
  lecture-only students.
- **Topology B:** one Canvas lab course with ≥2 sections → `split_by_member_section` →
  members split correctly; an unmapped Canvas section is reported, not silently enrolled.
- **Multi-context (§7):** ≥2 lecture-section Canvas courses → one class → union roster, no
  cross-drop; a released grade posts only to the line item of the student's own Canvas
  course (verify the _other_ context's gradebook does not receive it).
- **Governance:** instructor cannot change `class_id` or `github_org`; admin can; a
  course-code rule auto-pre-binds a fresh context on first launch.
- Extend `tests/e2e/lti/lti.canvas.spec.ts` (currently launch + roster + AGS) with a
  section-assignment assertion and a multi-context grade-routing assertion.
