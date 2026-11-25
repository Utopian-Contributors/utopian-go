/**
 * A Social username as a person types one into a field: "@Ada_99 " is
 * "ada_99". The rule is the server's (src/social/limits.ts NAME and
 * username()), so a form can say what is wrong before it asks, in the words
 * the server would answer with. The server still decides.
 */
const NAME = /^[a-z0-9_]{3,16}$/;

/** What the server says of a name that is not one. */
export const NAME_RULE = "Usernames are 3–16 letters, numbers, or _.";

/**
 * The name typed, or "" when it cannot be one.
 * @param {string} raw
 */
export function handleOf(raw) {
  const name = String(raw || "").trim().replace(/^@/, "").toLowerCase();
  return NAME.test(name) ? name : "";
}
