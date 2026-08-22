# Discord REST mock

A standalone HTTP server that answers Discord's REST routes, so a local deployment can run the whole
Discord integration without touching discord.com. It exists to make the production error paths run:
the bodies it returns are Discord-shaped, `DiscordErrorClassification.ts` classifies them the way it
classifies real traffic, and permissions and role hierarchy are enforced from state rather than
scripted per test.

Node standard library only, no dependencies, no build step.

## Running it

```bash
export PATH="$HOME/.local/node22/bin:$PATH"   # system node is 18
npx tsx tests/mocks/discord/server.ts
```

It binds `127.0.0.1:8788`. Set `DISCORD_MOCK_PORT` for a different port. Readiness:

```bash
curl -s http://127.0.0.1:8788/__mock/health
# {"ok":true,"scenario":"healthy","uptime_ms":1575,"calls":0,"guilds":1}
```

## Pointing a deployment at it

`supabase/functions/_shared/DiscordApiBase.ts` reads `DISCORD_API_BASE_URL` on every call, so the
only wiring needed is the variable:

```
DISCORD_API_BASE_URL=http://127.0.0.1:8788/api/v10
```

Three things worth knowing when wiring it up. The variable has to reach the Deno runtime that serves
the edge functions, not only Next.js, because every Discord call originates in an edge function.
`DISCORD_BOT_TOKEN` still has to be set to something non-empty, since `DiscordWrapper.getBotToken()`
throws before any request when it is missing; the mock ignores the value unless `require_auth` is on.
Slash-command registration reads `DISCORD_APPLICATION_ID`, and the mock accepts any application id.

The mock also serves the same routes without the `/api/v10` prefix, so `DISCORD_API_BASE_URL` may
point at the bare origin if that is ever more convenient.

## Routes

| Method           | Path                                          | Notes                                                              |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| GET              | `/guilds/{guild}`                             | 404 / 10004 when absent or when the bot is not a member            |
| GET              | `/guilds/{guild}/members/@me`                 | The bot's own member object, with its role ids                     |
| GET              | `/guilds/{guild}/roles`                       | `permissions` is a decimal string, `position` a number             |
| GET              | `/guilds/{guild}/members`                     | Full member list                                                   |
| GET              | `/guilds/{guild}/members/{user}`              | 404 / 10007 when the user has not joined                           |
| PUT              | `/guilds/{guild}/members/{user}`              | Add Guild Member. 204 empty when already a member, 201 when added  |
| PUT / DELETE     | `/guilds/{guild}/members/{user}/roles/{role}` | Manage Roles plus the hierarchy rule, both 403 / 50013             |
| POST             | `/guilds/{guild}/roles`                       | Created at position 1, as Discord does                             |
| DELETE           | `/guilds/{guild}/roles/{role}`                | Hierarchy applies; the role is pulled from every member            |
| GET              | `/guilds/{guild}/channels`                    | Needs View Channel, else 403 / 50001                               |
| POST             | `/guilds/{guild}/channels`                    | Needs Manage Channels; 400 / 50035 without a name                  |
| GET / DELETE     | `/channels/{channel}`                         | DELETE returns the deleted channel                                 |
| POST             | `/channels/{channel}/messages`                | 400 / 50006 with neither content nor embeds                        |
| GET / PATCH      | `/channels/{channel}/messages/{message}`      | 404 / 10008 when unknown, 403 / 50005 for another author's message |
| POST             | `/channels/{channel}/invites`                 | Needs Create Invite; codes are deterministic (`mock0001`, ...)     |
| GET / DELETE     | `/invites/{code}`                             | 404 / 10006 when already gone                                      |
| GET              | `/users/@me`                                  | The bot user                                                       |
| GET              | `/users/@me/guilds`                           | Cursor-paginated on `limit` and `after`, `bot_in_guild` only       |
| GET / POST / PUT | `/applications/{application}/commands`        | POST creates or updates one, PUT overwrites the whole set          |

Anything else answers `404 {"message":"404: Not Found","code":0}`, and a known path with the wrong
method answers 405, both the way Discord does. Every request, including those two, lands in the call
log, so a typo in a route shows up as a logged 404 rather than as silence.

Four of these are not in the brief but are called by the code, so they are implemented: `GET
/guilds/{guild}/channels` and `POST /channels/{channel}/invites` are both halves of
`createGuildInvite`, `PUT /guilds/{guild}/members/{user}` is `addGuildMember`, and the worker's
`registerSlashCommands` uses **POST** `/applications/{id}/commands` rather than the bulk PUT.

`GET /users/@me/guilds` is paginated for the same reason. `discord-list-guilds` pages until it gets a
page shorter than 200, so a mock that returned the whole list on every request would hand that loop
the same page 25 times and answer with 25 copies of every guild.

## Errors

Failures carry `{"message": "...", "code": <number>}` with the matching HTTP status, which is what
`parseDiscordApiError` reads out of `DiscordWrapper`'s error text. The codes reachable from the mock:

`10003` unknown channel, `10004` unknown guild, `10006` unknown invite, `10007` unknown member,
`10008` unknown message, `10011` unknown role, `50001` missing access, `50005` cannot edit another
author's message, `50006` cannot send an empty message, `50013` missing permissions, `50035` invalid
form body, `50109` invalid JSON, and `0` for the generic 404, 401 and 405.

Rate limits answer 429 with `{"message":"You are being rate limited.","retry_after":1.5,"global":false}`
and both headers the callers read, `Retry-After` and `X-RateLimit-Reset-After`. `DiscordWrapper`
computes its backoff from the second, the worker's raw membership fetch from the first.

Two things the classifier's shape imposed on the mock, worth knowing before writing assertions
against it:

- `isResourceGone()` treats a 404 as "already deleted" only for codes 10003, 10008 and 10011, or for
  a 404 with no parsable code. Deleting an invite that is already gone returns Discord's real
  `10006`, which that function reads as false. A compensating `deleteInvite` therefore reports a
  failure for work that is already done. The mock keeps 10006 because Discord does.
- `isMemberNotFound()` is true for any 404, including Unknown Guild and Unknown Channel. Callers that
  need to tell "this student has not joined" from "this server is wrong" have to read the code, which
  is what `checkGuildMembership` does. Both scenarios below produce the code that distinguishes them.

## Scenarios

`POST /__mock/scenario/{name}` applies one and clears the call log. `GET /__mock/scenarios` lists
them with these descriptions.

| Name                   | World                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `healthy`              | Bot in the guild, every required permission, bot role at position 10 above every class role |
| `bot-not-in-guild`     | The guild exists in the mock, the bot is not in it. Guild routes answer 404 / 10004         |
| `guild-gone`           | No guild at all, the wrong `discord_server_id` case. Also 404 / 10004                       |
| `missing-manage-roles` | Every permission except Manage Roles. Role writes answer 403 / 50013, channels still work   |
| `missing-view-channel` | No View Channel, so listing channels answers 403 / 50001 and no invite can be created       |
| `bot-role-too-low`     | Manage Roles held, bot role at position 5, tying the instructor role                        |
| `no-text-channel`      | Only a category channel, so `createGuildInvite` throws before any invite request            |
| `member-not-joined`    | Healthy guild with no members. Member lookups answer 404 / 10007                            |
| `rate-limited`         | Every route answers 429 with a `Retry-After` of 1.5 seconds                                 |

`bot-role-too-low` is the sharp one. The bot's role ties the instructor role at position 5 and sits
above the student and grader roles at 3 and 4, so assigning the student role succeeds while assigning
the instructor role returns 403 / 50013. Discord's rule is strict inequality and a tie fails, which
is the case a `>` instead of a `>=` in a preflight would get wrong in the passing direction.

The default guild id, `1142900000000000000`, contains "429" on purpose. It is the id from the comment
in `DiscordErrorClassification.ts` describing a misclassification caused by a bare substring search
for "429" in an error message, so every test that touches the mock keeps that regression covered.

## Control plane

Namespaced under `/__mock/` so it cannot collide with a Discord route, and excluded from the call log
so polling it does not disturb what the log measures.

| Endpoint                       | Does                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `GET /__mock/health`           | 200 with the current scenario and call count                   |
| `POST /__mock/reset`           | Back to `healthy`, call log cleared                            |
| `GET /__mock/state`            | The whole world                                                |
| `POST /__mock/state`           | Patch it. Objects merge key by key, arrays and scalars replace |
| `GET /__mock/calls`            | Ordered call log, oldest first                                 |
| `DELETE /__mock/calls`         | Clear it                                                       |
| `GET /__mock/scenarios`        | Names and descriptions                                         |
| `POST /__mock/scenario/{name}` | Apply one, clearing the log                                    |

A log entry is `{id, method, path, raw_path, query, body, status, code, timestamp}`. `path` has the
`/api/v10` prefix stripped and `raw_path` does not, `body` is the parsed JSON or null, and `code` is
present only when the response carried a Discord error code. The log keeps the most recent 2000
entries.

`POST /__mock/state` takes a patch by default and `{"replace": true, "state": {...}}` to start from an
empty world instead of the current one. Arrays replacing rather than concatenating means a `roles`
array in a patch is the complete set:

```bash
# Move the bot's role below the instructor role, without touching anything else.
curl -s -X POST http://127.0.0.1:8788/__mock/state -H 'Content-Type: application/json' -d '{
  "guilds": { "1142900000000000000": { "bot_roles": ["1200000000000000001"] } }
}'

# Require an Authorization: Bot header, to catch a call site that forgot one.
curl -s -X POST http://127.0.0.1:8788/__mock/state -d '{"require_auth": true}'
```

### Injected faults

`state.faults` is an ordered list of rules. The first match wins, `path` is a regular expression
matched against the prefix-stripped path, and `times` counts down and retires the rule at zero.

```bash
# 429 the next two role assignments, then behave.
curl -s -X POST http://127.0.0.1:8788/__mock/state -H 'Content-Type: application/json' -d '{
  "faults": [{ "method": "PUT", "path": "^/guilds/[^/]+/members/[^/]+/roles/", "status": 429,
               "retry_after": 0.5, "times": 2 }]
}'

# Stall past DiscordWrapper's 15s deadline, so the timeout path runs.
curl -s -X POST http://127.0.0.1:8788/__mock/state -H 'Content-Type: application/json' -d '{
  "faults": [{ "path": "^/guilds", "delay_ms": 16000, "status": 500 }]
}'
```

Fields: `method`, `path`, `status`, `code`, `message`, `retry_after` (seconds, for a 429), `delay_ms`,
`times`. Omitting `method` and `path` matches everything, and omitting `code` picks the conventional
one for the status.

## From a test

`client.ts` wraps the control plane and reads the mock's URL from `DISCORD_MOCK_URL`, defaulting to
`http://127.0.0.1:8788`.

```ts
import { getCalls, resetMock, setScenario, waitForCall, waitForMock } from "@/tests/mocks/discord/client";

await waitForMock(); // poll /__mock/health before a run
await resetMock();
await setScenario("bot-role-too-low");

// ... drive the app ...

const attempt = await waitForCall((c) => c.method === "PUT" && c.path.includes("/roles/"), 10_000);
expect(attempt.status).toBe(403);
expect(attempt.code).toBe(50013);

// Or assert that the preflight stopped the run before it reached Discord.
const writes = (await getCalls()).filter((c) => c.method !== "GET");
expect(writes).toHaveLength(0);
```

`waitForCall` prints the whole log when it times out, because "the request never happened" and "the
request happened and was refused" fail the same assertion and the log is what tells them apart.

`discordApiBaseUrl()` returns the value to put in `DISCORD_API_BASE_URL`, so a setup step can derive
it from the same env var the client uses.

## Not modelled

Channel-level permission overwrites, which can only subtract from the guild-level bitfield the mock
computes. The gateway, so nothing arrives over a websocket and interactions have to be posted to the
app directly. OAuth token exchange, which no call site in this repo performs. Pagination, audit-log
reasons, and real per-route rate-limit buckets: `X-RateLimit-*` headers are present on every response
but the numbers are fixed, and 429s come only from an injected fault or the `rate-limited` scenario.
