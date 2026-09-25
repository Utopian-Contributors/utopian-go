import { NextFunction, Request, Response } from "express";
import { readSession } from "./auth";
import { getUser, User } from "./db";
import { SocialError } from "./limits";

/**
 * Fields that must never ride out in a JSON body.
 *
 * A handler that accidentally sends the whole account row hits this on the
 * way out. `phrase` is the one exception, and only when that request has
 * already checked the password and opted in. A passkey login may return the
 * challenge and the credential id; the public key and the counter stay here.
 */
const SECRET = new Set([
  "passHash",
  "passSalt",
  "pass_hash",
  "pass_salt",
  "phrase",
  "phraseSalt",
  "phraseIv",
  "phraseTag",
  "phraseCt",
  "phrase_salt",
  "phrase_iv",
  "phrase_tag",
  "phrase_ct",
  "keyBox",
  "key_iv",
  "key_tag",
  "key_ct",
  "cose",
  "passkeyCose",
  "passkey_cose",
  "passkey_id",
  "passkeyId",
  "passkeyCount",
  "passkey_count",
  "password",
  "seed",
  "mnemonic",
]);

export function scrub(value: unknown, revealPhrase = false): unknown {
  return walk(value, revealPhrase, 0);
}

function walk(value: unknown, revealPhrase: boolean, depth: number): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, false, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "passkey") {
      if (typeof item === "boolean") out.passkey = item;
      else if (item && typeof item === "object") {
        const src = item as Record<string, unknown>;
        const safe: Record<string, unknown> = {};
        if (typeof src.challenge === "string") safe.challenge = src.challenge;
        if (typeof src.id === "string") safe.id = src.id;
        out.passkey = safe;
      }
      continue;
    }
    if (SECRET.has(key)) {
      if (key === "phrase" && revealPhrase && depth === 0 && typeof item === "string") out.phrase = item;
      continue;
    }
    out[key] = walk(item, false, depth + 1);
  }
  return out;
}

/** Runs first. Later handlers read the account; they do not trust the client. */
export async function loadAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = readSession(req);
    const user = session ? await getUser(session.name) : null;
    // A cookie from before the last recovery names a real account but no
    // longer speaks for it.
    res.locals.account = user && user.epoch === session?.epoch ? user : null;
    next();
  } catch (err) {
    next(err);
  }
}

/** Private routes. A missing session is 401 before the handler runs. */
export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.account) {
    res.status(401).json({ error: "Log in first." });
    return;
  }
  next();
}

/** Last step of every social response. Strips the fields in SECRET. */
export function guardJson(_req: Request, res: Response, next: NextFunction): void {
  const send = res.json.bind(res);
  res.json = ((body?: unknown) => send(scrub(body, res.locals.revealPhrase === true))) as Response["json"];
  next();
}

export function currentUser(res: Response): User | null {
  return (res.locals.account as User | null | undefined) ?? null;
}

export function requireUser(res: Response): User {
  const user = currentUser(res);
  if (!user) throw new SocialError(401, "Log in first.");
  return user;
}
