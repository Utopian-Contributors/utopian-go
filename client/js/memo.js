/**
 * How a voice memo is spelled and timed, for every bundle that writes or
 * reads one: social.js draws a post's, chat.js a message's, and both hand
 * these to the recorder (client/rec), so a memo is spelled the way it will
 * be read.
 */

/** A memo's shape is spelled in base64url, one character (0–63) per bar. */
export const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** m:ss */
export function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
