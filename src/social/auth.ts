import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Request, Response } from "express";
import { NAME } from "./limits";
import { socialDir } from "./store";

/**
 * Password check and phrase encryption use two scrypt derivations.
 *
 * One salt verifies the password. The other wraps the recovery phrase. They
 * are not the same key: a copy of the database then holds a verifier and a
 * ciphertext, and neither one opens the other without the password.
 *
 * Derivations run on the libuv pool, not the event loop, so a burst of logins
 * queues behind four threads instead of stalling every search request. That
 * pool is also what bounds memory: at most four 32MB derivations at once.
 *
 * A salt that starts with "2." was stretched at COST[2]; a bare salt is from
 * before that and used COST[1]. `stale` tells the caller to re-seal while it
 * still holds the password.
 */

const COST: Record<number, { N: number; r: number; p: number; maxmem: number }> = {
  1: { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  2: { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
};
const CURRENT = 2;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_S = SESSION_MS / 1000;

export interface PhraseBox {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function derive(password: string, salt: string): Promise<Buffer> {
  const dot = salt.indexOf(".");
  const version = dot === -1 ? 1 : Number(salt.slice(0, dot));
  const cost = COST[version];
  if (!cost) return Promise.reject(new Error("unknown scrypt version"));
  const raw = Buffer.from(salt.slice(dot + 1), "base64url");
  return new Promise((resolve, reject) =>
    scrypt(password, raw, 32, cost, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function freshSalt(): string {
  return `${CURRENT}.${randomBytes(16).toString("base64url")}`;
}

/** True when this salt predates the current cost. */
export function stale(salt: string): boolean {
  return !salt.startsWith(`${CURRENT}.`);
}

/**
 * The password hash as stored is sealed under the pepper, PASSWORD_PEPPER.
 *
 * A salted scrypt hash on its own is something to guess passwords against
 * offline, given a copy of the database: a weak password falls to a list.
 * Sealed, the hash says nothing about a guess without a key that never enters
 * Postgres. `peppered.` marks it; a hash without it is from before, still
 * checks, and is sealed at the next boot (sealAtRest in db.ts).
 */
const PEPPERED = "peppered.";

export function pepperHash(hash: string): string {
  return sealedAs(PEPPERED, pepperKey, hash);
}

export async function newPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = freshSalt();
  return { salt, hash: pepperHash((await derive(password, salt)).toString("base64url")) };
}

/** Throws, rather than answering no, when the pepper does not open the hash: that is a key gone wrong, not a wrong password. */
export async function checkPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const got = await derive(password, salt);
  const expect = Buffer.from(openedAs(PEPPERED, pepperKey, hash), "base64url");
  return got.length === expect.length && timingSafeEqual(got, expect);
}

/**
 * The password box's ciphertext is sealed again under WALLET_KEY.
 *
 * Under the password alone, a copy of the database is something to guess
 * passwords against offline: the GCM tag says when a guess is right, and the
 * phrase it opens is the wallet. Sealed again, a guess has nothing to be
 * checked against without the key that never enters Postgres. `wrapped.`
 * marks the outer box; a ciphertext without it is from before, and still opens.
 */
const WRAPPED = "wrapped.";

export function wrapPhraseCt(ct: string): string {
  return sealedAs(WRAPPED, walletKey, ct);
}

function unwrapPhraseCt(ct: string): string {
  return openedAs(WRAPPED, walletKey, ct);
}

/** `text` sealed under `key`, as one string marked `prefix`. Already marked, it is left as it is. */
function sealedAs(prefix: string, key: () => Buffer, text: string): string {
  if (text.startsWith(prefix)) return text;
  const box = sealWith(key(), text);
  return `${prefix}${box.iv}.${box.tag}.${box.ct}`;
}

/** The inverse of sealedAs. Unmarked text is from before sealing, and is handed back as it is. */
function openedAs(prefix: string, key: () => Buffer, text: string): string {
  if (!text.startsWith(prefix)) return text;
  const [iv, tag, ct] = text.slice(prefix.length).split(".");
  return openWith(key(), { iv, tag, ct });
}

export async function sealPhrase(phrase: string, password: string): Promise<PhraseBox> {
  const salt = freshSalt();
  const key = await derive(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(phrase, "utf8"), cipher.final()]);
  return {
    salt,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ct: wrapPhraseCt(ct.toString("base64url")),
  };
}

/** Throws on a wrong password: the GCM tag is the check. */
export async function openPhrase(box: PhraseBox, password: string): Promise<string> {
  const key = await derive(password, box.salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(unwrapPhraseCt(box.ct), "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export interface KeyBox {
  iv: string;
  tag: string;
  ct: string;
}

const keyCache = new Map<string, Buffer>();

/**
 * A 32-byte key, base64url, from the environment and never from Postgres, so
 * a copy of the database opens nothing sealed under it. Production refuses to
 * go on without it. Elsewhere one is made once and kept in the social data dir.
 */
function envKey(name: "WALLET_KEY" | "PASSWORD_PEPPER", file: string): Buffer {
  const held = keyCache.get(name);
  if (held) return held;
  const raw = process.env[name];
  let key: Buffer;
  if (raw) {
    key = Buffer.from(raw, "base64url");
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64url`);
  } else {
    if (process.env.NODE_ENV === "production") throw new Error(`${name} is not set`);
    const at = path.join(socialDir(), file);
    if (existsSync(at)) key = readFileSync(at);
    else {
      key = randomBytes(32);
      mkdirSync(socialDir(), { recursive: true });
      writeFileSync(at, key, { mode: 0o600 });
    }
  }
  keyCache.set(name, key);
  return key;
}

/** The key that seals each account's server copy of its phrase, and the password box around the other. */
function walletKey(): Buffer {
  return envKey("WALLET_KEY", "wallet-key");
}

/**
 * The pepper every password hash is sealed under. A key of its own rather
 * than one derived from WALLET_KEY, so that each can be kept, and lost,
 * without the other.
 */
function pepperKey(): Buffer {
  return envKey("PASSWORD_PEPPER", "password-pepper");
}

function sealWith(key: Buffer, text: string): KeyBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

function openWith(key: Buffer, box: KeyBox): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sealForServer(phrase: string): KeyBox {
  return sealWith(walletKey(), phrase);
}

export function openForServer(box: KeyBox): string {
  return openWith(walletKey(), box);
}

/**
 * HMAC cookie, not a server-side session row.
 *
 * The social pages are a static file precisely so the document stays inside
 * one window. Who is asking lives in this cookie; the file never varies.
 *
 * SOCIAL_SECRET sets the signing key. Without it the key is derived from
 * WALLET_KEY, so it is the same on every boot and on every disk without being
 * a constant in the source: a key anyone could read would let anyone mint a
 * cookie for any account, and every account here holds a wallet.
 */
let cached: Buffer | null = null;

function secret(): Buffer {
  if (cached) return cached;
  cached = process.env.SOCIAL_SECRET
    ? createHmac("sha256", "social").update(process.env.SOCIAL_SECRET).digest()
    : createHmac("sha256", walletKey()).update("social session cookie").digest();
  return cached;
}

function sign(payload: string): string {
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** The payload of a value `sign` wrote, or null if the signature is not ours. */
function verified(raw: string | null): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = createHmac("sha256", secret()).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    return Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function cookie(key: string, value: string, maxAge: number, secure: boolean): string {
  return (
    `${key}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` +
    (secure ? "; Secure" : "")
  );
}

/** One signed-in account: its name, the epoch it was signed under, and when it lapses. */
export interface Held {
  name: string;
  epoch: number;
  exp: number;
}

/** A session's fields, checked. Null for anything malformed or lapsed. */
function held(obj: unknown): Held | null {
  if (!obj || typeof obj !== "object") return null;
  const { u, s, e } = obj as { u?: unknown; s?: unknown; e?: unknown };
  if (typeof u !== "string" || typeof e !== "number") return null;
  if (e < Date.now()) return null;
  if (!NAME.test(u)) return null;
  return { name: u, epoch: typeof s === "number" ? s : 0, exp: e };
}

/**
 * The other accounts this browser is signed in to, besides the one it is
 * using. iOS apps let you hold several accounts and switch with a tap; this is
 * that, without a server-side session table.
 *
 * `soa` holds them as one signed list, each entry the same three fields a
 * session cookie carries, under the same key. Being signed, it cannot name an
 * account nobody here signed in to; carrying each one's epoch, a logout or a
 * recovery elsewhere still ends it, because a switch checks the epoch against
 * the account exactly as every request checks the active session
 * (guard.ts sessionAccount). Holding an account here is the same as being
 * signed in to it: anything that signs or reveals a key still asks for its
 * passkey, whichever account is active.
 */
const HELD = "soa";

/** At most this many besides the active one: a cookie has a size, and a picker a length. */
export const HELD_MAX = 5;

export function readHeld(req: Request): Held[] {
  const header = req.headers.cookie;
  if (!header) return [];
  const text = verified(readCookie(header, HELD));
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    const out: Held[] = [];
    for (const item of list) {
      const one = held(item);
      if (one && !out.some((o) => o.name === one.name)) out.push(one);
    }
    return out.slice(0, HELD_MAX);
  } catch {
    return [];
  }
}

function heldCookie(list: Held[], secure: boolean): string {
  if (!list.length) return cookie(HELD, "", 0, secure);
  const payload = Buffer.from(
    JSON.stringify(list.slice(0, HELD_MAX).map((h) => ({ u: h.name, s: h.epoch, e: h.exp }))),
  ).toString("base64url");
  // Lives as long as the longest-lived account in it; each entry lapses on its own.
  const age = Math.max(1, Math.ceil((Math.max(...list.map((h) => h.exp)) - Date.now()) / 1000));
  return cookie(HELD, sign(payload), age, secure);
}

function sessionCookie(one: Held, secure: boolean): string {
  const payload = Buffer.from(JSON.stringify({ u: one.name, s: one.epoch, e: one.exp })).toString("base64url");
  return cookie("soc", sign(payload), Math.max(1, Math.ceil((one.exp - Date.now()) / 1000)), secure);
}

/**
 * Make `active` the session and `others` the accounts held beside it, in one
 * response. Never lists the active account among the others.
 */
function writeAccounts(req: Request, res: Response, active: Held | null, others: Held[]): void {
  const secure = req.secure;
  const rest = others.filter((h, i) => h.name !== active?.name && others.findIndex((o) => o.name === h.name) === i);
  // A browser that holds nothing, and is to hold nothing, is not sent a held
  // list to delete: most never sign in to a second account.
  const hadHeld = !!req.headers.cookie && readCookie(req.headers.cookie, HELD) != null;
  const session = active ? sessionCookie(active, secure) : cookie("soc", "", 0, secure);
  res.setHeader("Set-Cookie", rest.length || hadHeld ? [heldCookie(rest, secure), session] : session);
}

/**
 * Sign `name` in, for 30 days. The account signed in before it, if another,
 * is not signed out: it moves to the front of the held list, so the account
 * picker can switch back to it. `epoch` is the account's session counter.
 * Recovery bumps it, and every cookie signed under the old value stops
 * working, because a cookie is the one thing a stateless session cannot
 * otherwise take back.
 */
export function setSession(req: Request, res: Response, name: string, epoch: number): void {
  const before = readSession(req);
  const others = readHeld(req).filter((h) => h.name !== name);
  if (before && before.name !== name) others.unshift(before);
  writeAccounts(req, res, { name, epoch, exp: Date.now() + SESSION_MS }, others);
}

/**
 * Make a held account the active one, keeping its own expiry. The account it
 * replaces is held in its place, first in the list.
 */
export function switchSession(req: Request, res: Response, to: Held): void {
  const before = readSession(req);
  const others = readHeld(req).filter((h) => h.name !== to.name);
  if (before && before.name !== to.name) others.unshift(before);
  writeAccounts(req, res, to, others);
}

/**
 * End the active session in this browser. `next`, a held account already
 * checked against its epoch, takes its place; without one, the browser is
 * signed out. `drop` names held accounts found to be stale on the way.
 */
export function clearSession(req: Request, res: Response, next: Held | null = null, drop: string[] = []): void {
  const others = readHeld(req).filter((h) => h.name !== next?.name && !drop.includes(h.name));
  writeAccounts(req, res, next, others);
}

/** Stop holding `names` in this browser. Their sessions elsewhere are untouched. */
export function forgetHeld(req: Request, res: Response, names: string[]): void {
  const others = readHeld(req).filter((h) => !names.includes(h.name));
  res.setHeader("Set-Cookie", heldCookie(others, req.secure));
}

export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readSession(req: Request): Held | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const text = verified(readCookie(header, "soc"));
  if (!text) return null;
  try {
    return held(JSON.parse(text));
  } catch {
    return null;
  }
}
