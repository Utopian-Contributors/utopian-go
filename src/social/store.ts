import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

/**
 * Pictures stay files. The rows — users, posts, saves — are in Postgres.
 *
 * A profile photo and a post photo are JPEGs the browser already compressed.
 * Putting those bytes in a row would make every timeline query drag them
 * along. The directory also holds the cookie-signing secret, which is not a
 * row either.
 */

export function socialDir(): string {
  return process.env.SOCIAL_DIR ?? path.join(process.cwd(), "data", "social");
}

function avatarDir(): string {
  return path.join(socialDir(), "avatars");
}

function avatarPath(name: string, tiny: boolean): string {
  const file = path.join(avatarDir(), tiny ? `${name}.t.jpg` : `${name}.jpg`);
  const root = avatarDir() + path.sep;
  if (!file.startsWith(root)) throw new Error("avatar path");
  return file;
}

export function avatarFile(name: string, tiny = false): string | null {
  const file = avatarPath(name, tiny);
  return existsSync(file) ? file : null;
}

/**
 * `tiny` is the timeline copy. A full photo with no tiny replaces the old
 * small file too, so the feed cannot keep showing the previous face.
 */
export function writeAvatar(name: string, full: Buffer, tiny?: Buffer): void {
  mkdirSync(avatarDir(), { recursive: true });
  writeFileSync(avatarPath(name, false), full, { mode: 0o600 });
  const small = avatarPath(name, true);
  if (tiny) writeFileSync(small, tiny, { mode: 0o600 });
  else if (existsSync(small)) unlinkSync(small);
}

function postDir(): string {
  return path.join(socialDir(), "posts");
}

function postPhotoPath(id: string, n: number, mobile = false): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !Number.isInteger(n) || n < 0 || n > 3) {
    throw new Error("post photo path");
  }
  const file = path.join(postDir(), mobile ? `${id}-${n}.m.jpg` : `${id}-${n}.jpg`);
  const root = postDir() + path.sep;
  if (!file.startsWith(root)) throw new Error("post photo path");
  return file;
}

/**
 * The nth picture on a post.
 *
 * `mobile` is the smaller file. A post from before that file existed falls
 * back to the desktop one, so the phone still has something to show.
 */
export function postPhotoFile(id: string, n: number, mobile = false): string | null {
  let file: string;
  let full: string;
  try {
    file = postPhotoPath(id, n, mobile);
    full = postPhotoPath(id, n, false);
  } catch {
    return null;
  }
  if (existsSync(file)) return file;
  if (mobile && existsSync(full)) return full;
  return null;
}

/** Writes the desktop JPEG and the phone JPEG for each picture. */
export function writePostPhotos(id: string, photos: { full: Buffer; small: Buffer }[]): void {
  if (!photos.length) return;
  mkdirSync(postDir(), { recursive: true });
  const written: string[] = [];
  try {
    photos.forEach((photo, n) => {
      const full = postPhotoPath(id, n, false);
      const small = postPhotoPath(id, n, true);
      writeFileSync(full, photo.full, { mode: 0o600 });
      written.push(full);
      writeFileSync(small, photo.small, { mode: 0o600 });
      written.push(small);
    });
  } catch (err) {
    for (const file of written) {
      if (existsSync(file)) unlinkSync(file);
    }
    throw err;
  }
}

/** Undo `writePostPhotos` for a post that was not created. */
export function removePostPhotos(id: string, count: number): void {
  for (let n = 0; n < count; n++) {
    for (const mobile of [false, true]) {
      const file = postPhotoPath(id, n, mobile);
      if (existsSync(file)) unlinkSync(file);
    }
  }
}
