/**
 * The error for a write that RLS refused without a PostgREST error.
 *
 * RLS doesn't fail an UPDATE or DELETE it refuses: the statement matches 0 rows and PostgREST
 * answers `200 []`. Both write paths in the app check for that and throw this error:
 * - the refine data provider (`lib/refineDataProvider.ts`), for `update` and `deleteOne`
 * - `TableController` (`lib/TableController.ts`), for `update`, `delete` and `hardDelete`
 *
 * It is shaped like a refine HttpError (`statusCode: 403`), so mutation `onError` handlers see a
 * status, and it carries `refusedWrite: true` so the shared error mapper can tell it apart from
 * other failures.
 *
 * The message is shown to the user as is, so it names no table or id. An update that matched
 * nothing may also mean the row was deleted. Both delete paths throw only after a follow-up select
 * found the row, so the delete message doesn't offer that possibility.
 */
export function refusedWriteError(action: "update" | "delete") {
  const message =
    action === "update"
      ? "You don't have permission to change this, or it no longer exists. Nothing was changed."
      : "You don't have permission to delete this. Nothing was changed.";
  return Object.assign(new Error(message), { statusCode: 403, refusedWrite: true as const });
}

/**
 * True when `error` is a {@link refusedWriteError}: a refine `update`/`deleteOne` or a
 * `TableController` `update`/`delete`/`hardDelete` that RLS refused (0 rows changed, no PostgREST
 * error).
 *
 * Use it to tell a refusal apart from other failures, e.g. to show a permission message instead of
 * a generic one. A PostgREST error, such as an RLS violation on insert (42501), is not one of these
 * refusals and returns false.
 */
export function isRefusedWriteError(error: unknown): error is Error & { statusCode: 403; refusedWrite: true } {
  return error instanceof Error && (error as { refusedWrite?: unknown }).refusedWrite === true;
}
