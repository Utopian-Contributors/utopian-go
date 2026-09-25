/**
 * The bounds the product actually states, in one place so a route and a check
 * cannot drift apart.
 *
 * Posts are one line on purpose. A comment and a bio share the same ceiling
 * because nothing in the UI is a composition surface — a longer field would
 * only be room the page does not have.
 */

export const SOCIAL_BYTES = 14 * 1024;

/** Timeline copy: wide enough to read a face at 40px, on a 2× screen. */
export const TINY_W = 80;
export const TINY_BYTES = 2 * 1024;

export const POST_EVERY_MS = 10 * 60 * 1000;

export const MAX_TEXT = 160;
/** A post takes this many comments, and the post page shows all of them. */
export const MAX_COMMENTS = 100;
export const MAX_BIO = 160;
export const MAX_LOC = 40;

/**
 * A post carries at most four pictures. Each one is two JPEGs, the same way a
 * profile photo is: a desktop file, and a smaller one for a phone.
 */
export const MAX_PHOTOS = 4;
export const PHOTO_BYTES = 48 * 1024;
export const PHOTO_EDGE = 1600;
/** Phone copy. Same byte ceiling as a profile photo, at about half the edge. */
export const PHOTO_SMALL_BYTES = SOCIAL_BYTES;
export const PHOTO_SMALL_EDGE = 640;

/** Usernames are permanent, so the alphabet is closed at creation. */
export const NAME = /^[a-z0-9_]{3,16}$/;

export class SocialError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function username(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim().toLowerCase();
  return NAME.test(name) ? name : null;
}

/**
 * One short line.
 *
 * Newlines and other controls become spaces and then collapse, so a pasted
 * paragraph is judged as the sentence it will actually be. Over the ceiling
 * is a different failure from empty: the field should say which one it is.
 */
export function shortText(
  input: unknown,
  max: number,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Write something." };
  const text = input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { ok: false, error: "Write something." };
  if (text.length > max) return { ok: false, error: `Keep it to ${max} characters.` };
  return { ok: true, text };
}

/**
 * The words on a post. Empty is allowed: a picture can be the whole post.
 * Over the ceiling is still refused.
 */
export function postText(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Write something." };
  const text = input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep it to ${MAX_TEXT} characters.` };
  return { ok: true, text };
}

/** Milliseconds until this account may post again. Zero means now. */
export function postWait(lastPost: number, now: number): number {
  if (!lastPost) return 0;
  return Math.max(0, lastPost + POST_EVERY_MS - now);
}

export function waitText(wait: number): string {
  const min = Math.max(1, Math.ceil(wait / 60_000));
  return `You can post again in ${min} min.`;
}
