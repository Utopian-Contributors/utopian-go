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

export async function newPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = freshSalt();
  return { salt, hash: (await derive(password, salt)).toString("base64url") };
}

export async function checkPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const got = await derive(password, salt);
  const expect = Buffer.from(hash, "base64url");
  return got.length === expect.length && timingSafeEqual(got, expect);
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
    ct: ct.toString("base64url"),
  };
}

/** Throws on a wrong password: the GCM tag is the check. */
export async function openPhrase(box: PhraseBox, password: string): Promise<string> {
  const key = await derive(password, box.salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export interface KeyBox {
  iv: string;
  tag: string;
  ct: string;
}

let walletKeyCache: Buffer | null = null;

/**
 * The key that seals each account's server copy of its phrase. It lives in the
 * environment, never in Postgres, so a copy of the database opens nothing.
 */
function walletKey(): Buffer {
  if (walletKeyCache) return walletKeyCache;
  const raw = process.env.WALLET_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64url");
    if (key.length !== 32) throw new Error("WALLET_KEY must be 32 bytes, base64url");
    walletKeyCache = key;
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("WALLET_KEY is not set");
  const file = path.join(socialDir(), "wallet-key");
  if (existsSync(file)) walletKeyCache = readFileSync(file);
  else {
    walletKeyCache = randomBytes(32);
    mkdirSync(socialDir(), { recursive: true });
    writeFileSync(file, walletKeyCache, { mode: 0o600 });
  }
  return walletKeyCache;
}

export function sealForServer(phrase: string): KeyBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", walletKey(), iv);
  const ct = Buffer.concat([cipher.update(phrase, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

export function openForServer(box: KeyBox): string {
  const decipher = createDecipheriv("aes-256-gcm", walletKey(), Buffer.from(box.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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

function cookie(value: string, maxAge: number, secure: boolean): string {
  return (
    `soc=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` +
    (secure ? "; Secure" : "")
  );
}

/**
 * `epoch` is the account's session counter. Recovery bumps it, and every
 * cookie signed under the old value stops working, because a cookie is the
 * one thing a stateless session cannot otherwise take back.
 */
export function setSession(res: Response, name: string, epoch: number, secure: boolean): void {
  const payload = Buffer.from(
    JSON.stringify({ u: name, s: epoch, e: Date.now() + SESSION_MS }),
  ).toString("base64url");
  res.setHeader("Set-Cookie", cookie(sign(payload), SESSION_S, secure));
}

export function clearSession(res: Response, secure: boolean): void {
  res.setHeader("Set-Cookie", cookie("", 0, secure));
}

function readCookie(header: string, name: string): string | null {
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

export function readSession(req: Request): { name: string; epoch: number } | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const raw = readCookie(header, "soc");
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
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: unknown;
      s?: unknown;
      e?: unknown;
    };
    if (typeof obj.u !== "string" || typeof obj.e !== "number") return null;
    if (obj.e < Date.now()) return null;
    if (!NAME.test(obj.u)) return null;
    return { name: obj.u, epoch: typeof obj.s === "number" ? obj.s : 0 };
  } catch {
    return null;
  }
}
