import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { AUDIO_TYPES, type AudioKind } from "./audio";

/**
 * Pictures stay files. The rows — users, posts, saves — are in Postgres.
 *
 * A profile photo and a post photo are JPEGs the browser already compressed,
 * and a voice memo is the browser's own recording. Putting those bytes in a
 * row would make every timeline query drag them along. The keys that seal wallets and sign cookies come from the
 * environment; only a dev box without WALLET_KEY keeps one here.
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

function postAudioPath(id: string, kind: AudioKind): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !(kind in AUDIO_TYPES)) throw new Error("post audio path");
  const file = path.join(postDir(), `${id}.${kind}`);
  if (!file.startsWith(postDir() + path.sep)) throw new Error("post audio path");
  return file;
}

/** A post's voice memo, and the type it is served as. The extension says which container it is. */
export function postAudioFile(id: string): { file: string; type: string } | null {
  for (const kind of Object.keys(AUDIO_TYPES) as AudioKind[]) {
    let file: string;
    try {
      file = postAudioPath(id, kind);
    } catch {
      return null;
    }
    if (existsSync(file)) return { file, type: AUDIO_TYPES[kind] };
  }
  return null;
}

export function writePostAudio(id: string, audio: { bytes: Buffer; kind: AudioKind }): void {
  mkdirSync(postDir(), { recursive: true });
  writeFileSync(postAudioPath(id, audio.kind), audio.bytes, { mode: 0o600 });
}

/** Undo `writePostAudio` for a post that was not created. */
export function removePostAudio(id: string): void {
  const found = postAudioFile(id);
  if (found) unlinkSync(found.file);
}

function chatDir(): string {
  return path.join(socialDir(), "chat");
}

function chatPhotoPath(id: string, n: number): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !Number.isInteger(n) || n < 0 || n > 3) {
    throw new Error("chat photo path");
  }
  const file = path.join(chatDir(), `${id}-${n}.bin`);
  if (!file.startsWith(chatDir() + path.sep)) throw new Error("chat photo path");
  return file;
}

/** Sealed on the sender's device. The server never holds the key to these bytes. */
export function chatPhotoFile(id: string, n: number): string | null {
  try {
    const file = chatPhotoPath(id, n);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

export function writeChatPhotos(id: string, photos: Buffer[]): void {
  if (!photos.length) return;
  mkdirSync(chatDir(), { recursive: true });
  try {
    photos.forEach((bytes, n) => writeFileSync(chatPhotoPath(id, n), bytes, { mode: 0o600 }));
  } catch (err) {
    removeChatPhotos(id, photos.length);
    throw err;
  }
}

export function removeChatPhotos(id: string, count: number): void {
  for (let n = 0; n < count; n++) {
    const file = chatPhotoPath(id, n);
    if (existsSync(file)) unlinkSync(file);
  }
}

function adDir(): string {
  return path.join(socialDir(), "ads");
}

function bannerPath(id: string, mobile: boolean): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("banner path");
  const file = path.join(adDir(), mobile ? `${id}.m.jpg` : `${id}.jpg`);
  if (!file.startsWith(adDir() + path.sep)) throw new Error("banner path");
  return file;
}

/** An ad's banner; `mobile` is the phone copy. */
export function bannerFile(id: string, mobile: boolean): string | null {
  try {
    const file = bannerPath(id, mobile);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

export function writeBanner(id: string, banner: { full: Buffer; small: Buffer }): void {
  mkdirSync(adDir(), { recursive: true });
  writeFileSync(bannerPath(id, false), banner.full, { mode: 0o600 });
  writeFileSync(bannerPath(id, true), banner.small, { mode: 0o600 });
}

export function removeBanner(id: string): void {
  for (const mobile of [false, true]) {
    const file = bannerPath(id, mobile);
    if (existsSync(file)) unlinkSync(file);
  }
}
