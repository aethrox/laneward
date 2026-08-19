/**
 * A `lane_id` is not just a database key: `scripts/new-lane.ts` joins it into a
 * worktree path (`<root>/<lane_id>`) and a branch name (`lane/<lane_id>`), so a
 * separator or a `..` segment in it reaches whatever the caller names. The
 * leading character must be alphanumeric, which is also what rejects `.` and
 * `..` outright.
 *
 * Both entry points validate: the API because a lane can be registered without
 * the CLI, and the CLI because it creates the worktree before it ever posts.
 */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export const slugRule = "letters, digits, dot, underscore and dash only, starting with a letter or digit, at most 64 characters";
