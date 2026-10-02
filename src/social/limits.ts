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

/** A comment. */
export const MAX_TEXT = 160;
/** The words on a post. */
export const MAX_POST = 256;
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

/**
 * A post carries at most one voice memo, recorded in the browser, of up to
 * three minutes. Opus at 24 kbps is about 3KB a second, so three minutes fit
 * with room for its variable rate; a browser that encodes heavier (an older
 * Safari's AAC) is stopped by the byte ceiling first. The recorder stops at
 * whichever limit it reaches.
 *
 * The wave is the recording's shape, one base64url character (0–63) per bar,
 * so a timeline draws it without fetching a byte of audio.
 */
export const MAX_AUDIO_MS = 3 * 60_000;
export const AUDIO_BYTES = 640 * 1024;
export const WAVE_BARS = 40;

/**
 * Messenger. The server sees ciphertext only, so these bound bytes, not
 * characters: a message is AES-GCM over at most MAX_CHAT UTF-8 characters,
 * and a photo is a 12-byte IV, the sealed JPEG, and a 16-byte tag.
 */
export const MAX_CHAT = 500;
export const CHAT_CT_BYTES = MAX_CHAT * 4 + 16;
export const CHAT_PHOTO_BYTES = PHOTO_BYTES + 28;
export const MAX_CHAT_KEEP = 1000;
export const CHAT_PAGE = 30;

/**
 * An ad on search. Money is whole cents. Each keyword is bought on its own,
 * in whole dollars from $1, and an impression costs the ad's bid, from 1¢.
 */
export const AD_CTA = 24;
export const AD_TITLE = 60;
export const AD_BODY = 140;
export const AD_URL = 200;
export const AD_KEYWORDS = 20;
export const AD_KEYWORD = 40;
export const AD_MIN_BUDGET = 100;
export const AD_MAX_BUDGET = 1_000_000;
export const AD_MIN_BID = 1;
export const AD_MAX_BID = 100;
export const AD_DEVICES = ["all", "mobile", "desktop"] as const;
export type AdDevices = (typeof AD_DEVICES)[number];

/** A banner is three times as wide as tall: a desktop copy, and a phone copy under a post photo's ceilings. */
export const BANNER_W = 1200;
export const BANNER_H = 400;
export const BANNER_SMALL_W = 640;

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
  if (text.length > MAX_POST) return { ok: false, error: `Keep it to ${MAX_POST} characters.` };
  return { ok: true, text };
}

/** One line of an ad. Everyone who searches sees it, so bidirectional overrides go too. */
export function adText(input: unknown, max: number): { ok: true; text: string } | { ok: false; error: string } {
  return shortText(typeof input === "string" ? input.replace(/[‪-‮⁦-⁩]/g, "") : input, max);
}

/** Lower case, letters and digits, one space between: a keyword as it is kept, and a query as it is matched. */
export function words(input: string): string[] {
  return input.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function adKeyword(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const keyword = words(input).join(" ");
  return keyword && keyword.length <= AD_KEYWORD ? keyword : null;
}

/** Where an ad goes: https, a named host, no credentials. It becomes an href, so nothing else gets through. */
export function adUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > AD_URL) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(url.hostname)) return null;
  return url.href.length <= AD_URL ? url.href : null;
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
