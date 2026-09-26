import express, { NextFunction, Request, Response, Router } from "express";
import { createPublicKey, randomBytes } from "crypto";
import { SITE_URL } from "../config";
import {
  checkPassword,
  clearSession,
  newPassword,
  openForServer,
  openPhrase,
  sealForServer,
  sealPhrase,
  setSession,
  stale,
} from "./auth";
import { jpegSize } from "./jpeg";
import { generateMnemonic, normalizeMnemonic, solanaAddress } from "./keys";
import {
  CHAT_CT_BYTES,
  CHAT_PHOTO_BYTES,
  MAX_BIO,
  MAX_LOC,
  MAX_PHOTOS,
  MAX_TEXT,
  PHOTO_BYTES,
  PHOTO_EDGE,
  PHOTO_SMALL_BYTES,
  PHOTO_SMALL_EDGE,
  SOCIAL_BYTES,
  TINY_BYTES,
  TINY_W,
  SocialError,
  postText,
  postWait,
  shortText,
  username,
  waitText,
} from "./limits";
import { rateLimit } from "../lib/rateLimit";
import { lookupMints } from "../lib/tokens/store";
import {
  type Card,
  type CommentRow,
  type User,
  addComment,
  addFriend,
  bumpAvatar,
  addChatKey,
  bumpPasskeyCount,
  chatKey,
  chatKeys,
  chatList,
  chatPhotoCount,
  countUnseen,
  endSessions,
  createPost,
  ensureSchema,
  findPeople,
  friendList,
  getUser,
  searchUsers,
  insertUser,
  markSeen,
  openPost,
  postsBy,
  recoverAccount,
  removeFriend,
  repost,
  reseal,
  savedPosts,
  sendMessage,
  setKeyBox,
  setPasskey,
  thread,
  timeline,
  toggleSave,
  unseenNotes,
  updateProfile,
  userByAddress,
  userByPasskey,
} from "./db";
import { parseSol, prepareTransfer, solanaPubkey } from "./pay";
import { sendFor } from "./send";
import { MAX_SLIPPAGE_BPS, swapFor } from "./swap";
import { currentUser, guardJson, loadAccount, requireAuth, requireUser } from "./guard";
import { avatarFile, chatPhotoFile, postPhotoFile, writeAvatar } from "./store";
import { verifyAssertion, verifyRegistration } from "./webauthn";

/**
 * Username and password, or a passkey on its own, or the recovery phrase.
 *
 * A passkey added from the profile is a discoverable credential. Login can
 * start from it, with no password. Password login still asks for that
 * passkey afterwards when one is enrolled, so the second factor stays.
 * The recovery phrase is never in a response except the one call that
 * re-checks the password for that purpose. The phrase alone recovers the
 * account: it is the wallet, so whoever holds it already owns what matters.
 */

interface Challenge {
  kind: "login" | "add" | "phrase" | "chat" | "send";
  name: string;
  exp: number;
}

const challenges = new Map<string, Challenge>();
const CHALLENGE_MAX = 10_000;
let swept = 0;

/**
 * Anonymous callers can ask for a login challenge, so the map is swept of
 * expired entries once a minute and refuses new ones past a ceiling rather
 * than growing with request rate.
 */
function issue(kind: Challenge["kind"], name: string): Buffer {
  const now = Date.now();
  if (now - swept > 60_000) {
    swept = now;
    for (const [key, value] of challenges) {
      if (value.exp < now) challenges.delete(key);
    }
  }
  if (challenges.size >= CHALLENGE_MAX) throw new SocialError(503, "Try again in a minute.");
  const raw = randomBytes(32);
  challenges.set(raw.toString("base64url"), { kind, name, exp: now + 5 * 60 * 1000 });
  return raw;
}

function take(raw: Buffer, kind: Challenge["kind"], name: string): boolean {
  const key = raw.toString("base64url");
  const found = challenges.get(key);
  challenges.delete(key);
  return !!found && found.kind === kind && found.name === name && found.exp >= Date.now();
}

/**
 * In production the site's own origin, not the request's Host header: a
 * passkey is bound to one rpId, and the deployment answering under a second
 * hostname must not accept assertions made for it. Dev has no fixed host.
 */
const PINNED = process.env.NODE_ENV === "production" ? SITE_URL : null;

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function originOf(req: Request): string {
  return PINNED ?? requestOrigin(req);
}

function rpIdOf(req: Request): string {
  return new URL(originOf(req)).hostname;
}

function assertSameOrigin(req: Request): void {
  const origin = req.get("origin");
  if (!origin || origin !== requestOrigin(req)) {
    throw new SocialError(403, "Cross-origin request refused.");
  }
}

function b64(input: unknown): Buffer | null {
  if (typeof input !== "string" || input.length < 1 || input.length > 16_000) return null;
  try {
    const buf = Buffer.from(input, "base64url");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

export interface PublicMe {
  name: string;
  address: string;
  bio: string;
  loc: string;
  avatarRev: number;
  passkey: boolean;
  wait: number;
  unseen: number;
  unread: number;
}

async function publicMe(user: User | null): Promise<PublicMe | null> {
  if (!user) return null;
  return {
    name: user.name,
    address: user.address,
    bio: user.bio,
    loc: user.loc,
    avatarRev: user.avatarRev,
    passkey: !!user.passkey,
    wait: postWait(user.lastPost, Date.now()),
    ...(await countUnseen(user.name)),
  };
}

function passwordOk(input: unknown): string | null {
  if (typeof input !== "string" || input.length < 8 || input.length > 128) return null;
  return input;
}

/**
 * Wrong passwords per account, from every address together.
 *
 * The per-IP limiter stops one client; this stops many clients sharing one
 * target: three wrong guesses a minute, and ten in any fifteen. It can hold
 * the owner up for a while too, which is why recovery and passkeys do not go
 * through it: the phrase always works.
 */
const MISS_PER_MINUTE = 3;
const MISS_PER_WINDOW = 10;
const MISS_WINDOW_MS = 15 * 60 * 1000;
const misses = new Map<string, number[]>();

function refuseGuessing(name: string): void {
  const now = Date.now();
  const list = (misses.get(name) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
  const minute = list.filter((t) => now - t < 60_000);
  let until = 0;
  if (minute.length >= MISS_PER_MINUTE) until = minute[minute.length - MISS_PER_MINUTE] + 60_000;
  if (list.length >= MISS_PER_WINDOW) until = Math.max(until, list[list.length - MISS_PER_WINDOW] + MISS_WINDOW_MS);
  if (until > now) {
    throw new SocialError(429, "Too many wrong passwords. Try again later.", { wait: until - now });
  }
}

function noteMiss(name: string): void {
  const now = Date.now();
  const list = (misses.get(name) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
  list.push(now);
  misses.set(name, list.slice(-MISS_PER_WINDOW));
  if (misses.size > CHALLENGE_MAX) {
    for (const [key, value] of misses) {
      if (!value.some((t) => now - t < MISS_WINDOW_MS)) misses.delete(key);
    }
  }
}

/**
 * The password against this account, throttled per account.
 *
 * A right password on an account sealed at an older cost is re-sealed at the
 * current one, since this is the only moment the server holds the password.
 * Login does not hide whether a name exists: profiles are public at /u/:name.
 */
async function passwordMatches(user: User, password: string): Promise<boolean> {
  refuseGuessing(user.name);
  if (!(await checkPassword(password, user.passSalt, user.passHash))) {
    noteMiss(user.name);
    return false;
  }
  misses.delete(user.name);
  const restale = stale(user.passSalt) || stale(user.phraseSalt);
  if (restale || !user.keyBox) {
    const phrase = await openPhrase(
      { salt: user.phraseSalt, iv: user.phraseIv, tag: user.phraseTag, ct: user.phraseCt },
      password,
    );
    if (restale) await reseal(user.name, await newPassword(password), await sealPhrase(phrase, password));
    if (!user.keyBox) await setKeyBox(user.name, sealForServer(phrase));
  }
  return true;
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => {
      if (err instanceof SocialError) {
        if (err.status === 429 && typeof err.extra.wait === "number") {
          res.setHeader("Retry-After", String(Math.ceil(err.extra.wait / 1000)));
        }
        res.status(err.status).json({ error: err.message, ...err.extra });
        return;
      }
      next(err);
    });
  };
}

const jsonBody = express.json({ limit: "32kb" });

function readJson(req: Request, res: Response, next: NextFunction) {
  jsonBody(req, res, (err?: unknown) => {
    if (err) {
      res.status(400).json({ error: "Malformed request." });
      return;
    }
    next();
  });
}

/**
 * One bucket per kind of request, so paying someone cannot spend the
 * allowance that logging in needs, and neither can reach the phrase's.
 */
/**
 * Anything that checks a password, per address: three guesses a minute,
 * shared across login, the phrase, adding a passkey and confirming a send.
 */
const passwordLimit = rateLimit({ perMinute: 3, burst: 3 });
/** Two scrypt derivations and a new wallet each. */
const registerLimit = rateLimit({ perMinute: 3, burst: 3 });
/** Passkey ceremonies: a challenge, then an assertion. */
const loginLimit = rateLimit({ perMinute: 30, burst: 20 });
const recoverLimit = rateLimit({ perMinute: 3, burst: 3 });
const secretLimit = rateLimit({ perMinute: 10, burst: 5 });
const payLimit = rateLimit({ perMinute: 30, burst: 10 });
const writeLimit = rateLimit({ perMinute: 60, burst: 20 });
/** Page loads: every social page asks for itself and for who is signed in. */
const readLimit = rateLimit({ perMinute: 240, burst: 60 });
const searchLimit = rateLimit({ perMinute: 180, burst: 40 });

export const socialRouter = Router();

socialRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
socialRouter.use(guardJson);
socialRouter.use((_req, res, next) => {
  ensureSchema().then(
    () => next(),
    (err: unknown) => {
      console.error("[social] database:", err);
      res.status(503).json({ error: "Social is unavailable right now." });
    },
  );
});
socialRouter.use(loadAccount);

socialRouter.post(
  "/register",
  registerLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const name = username(req.body?.username);
    if (!name) throw new SocialError(400, "Usernames are 3–16 letters, numbers, or _.");
    const password = passwordOk(req.body?.password);
    if (!password) throw new SocialError(400, "Use at least 8 characters.");
    const phrase = generateMnemonic();
    const address = solanaAddress(phrase);
    const pass = await newPassword(password);
    const box = await sealPhrase(phrase, password);
    const user: User = {
      name,
      uid: randomBytes(16).toString("base64url"),
      passSalt: pass.salt,
      passHash: pass.hash,
      phraseSalt: box.salt,
      phraseIv: box.iv,
      phraseTag: box.tag,
      phraseCt: box.ct,
      address,
      bio: "",
      loc: "",
      avatarRev: 0,
      lastPost: 0,
      passkey: null,
      created: Date.now(),
      epoch: 0,
      keyBox: sealForServer(phrase),
    };
    const inserted = await insertUser(user);
    if (!inserted) throw new SocialError(409, "That username is taken.");
    setSession(res, name, 0, req.secure);
    // The phrase stays out of this response. Profile shows it, behind the password.
    res.json({ name, address });
  }),
);

socialRouter.post(
  "/login",
  passwordLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const name = username(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = name ? await getUser(name) : null;
    if (!user || !(await passwordMatches(user, password))) {
      throw new SocialError(401, "Wrong username or password.");
    }
    if (user.passkey) {
      const challenge = issue("login", user.name);
      res.json({ passkey: { challenge: challenge.toString("base64url"), id: user.passkey.id } });
      return;
    }
    setSession(res, user.name, user.epoch, req.secure);
    res.json({ name: user.name });
  }),
);

/**
 * The phrase and a new password. The phrase names the account by its
 * address, so no username is needed and none is checked.
 */
socialRouter.post(
  "/recover",
  recoverLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const phrase = normalizeMnemonic(req.body?.phrase);
    if (!phrase) throw new SocialError(400, "That isn't a valid 12-word recovery phrase.");
    const password = passwordOk(req.body?.password);
    if (!password) throw new SocialError(400, "Use at least 8 characters.");
    const [pass, box] = await Promise.all([newPassword(password), sealPhrase(phrase, password)]);
    const user = await recoverAccount(solanaAddress(phrase), pass, box, sealForServer(phrase));
    if (!user) throw new SocialError(401, "No account uses that phrase.");
    misses.delete(user.name);
    setSession(res, user.name, user.epoch, req.secure);
    res.json({ name: user.name });
  }),
);

/** The account whose passkey id is this credential, if one was enrolled. */
function findPasskey(id: string): Promise<User | null> {
  if (!id) return Promise.resolve(null);
  return userByPasskey(id);
}

socialRouter.post(
  "/passkey/login",
  loginLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    // Empty name: this challenge is not tied to a typed username. The
    // assertion's credential id picks the account.
    const challenge = issue("login", "");
    res.json({ challenge: challenge.toString("base64url") });
  }),
);

socialRouter.post(
  "/login/passkey",
  loginLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const name = username(req.body?.username);
    const submittedId = typeof req.body?.id === "string" ? req.body.id : "";
    const named = name ? await getUser(name) : null;
    // A username means the password step already ran. No username means the
    // passkey itself is the login, and the credential id is the account.
    const user = named?.passkey ? named : await findPasskey(submittedId);
    if (!user?.passkey) throw new SocialError(401, "Passkey was not accepted.");
    if (submittedId && user.passkey.id !== submittedId) {
      throw new SocialError(401, "Passkey was not accepted.");
    }
    const clientData = b64(req.body?.clientData);
    const authData = b64(req.body?.authenticatorData);
    const signature = b64(req.body?.signature);
    const challenge = b64(req.body?.challenge);
    if (!clientData || !authData || !signature || !challenge) {
      throw new SocialError(400, "Passkey was not completed.");
    }
    if (!take(challenge, "login", named?.passkey ? user.name : "")) {
      throw new SocialError(401, "Passkey challenge expired. Try again.");
    }
    let count: number;
    try {
      count = verifyAssertion({
        clientData,
        authData,
        signature,
        cose: Buffer.from(user.passkey.cose, "base64url"),
        challenge,
        origin: originOf(req),
        rpId: rpIdOf(req),
        prevCount: user.passkey.count,
      });
    } catch {
      throw new SocialError(401, "Passkey was not accepted.");
    }
    await bumpPasskeyCount(user.name, count);
    setSession(res, user.name, user.epoch, req.secure);
    res.json({ name: user.name });
  }),
);

/** Who is signed in, for pages outside Social. */
socialRouter.get(
  "/me",
  readLimit,
  wrap(async (_req, res) => {
    res.json({ me: await publicMe(currentUser(res)) });
  }),
);

socialRouter.post(
  "/logout",
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    // The cookie is signed, not stored, so clearing it here only forgets it in
    // this browser. Moving the epoch is what makes a copied one stop working,
    // on every device this account is signed in on.
    const me = currentUser(res);
    if (me) await endSessions(me.name);
    clearSession(res, req.secure);
    res.json({ ok: true });
  }),
);

const PAGE_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Keyset cursor. Absent on the first page. Half a cursor is a bad request. */
function timelineCursor(req: Request): { at: number; id: string } | null {
  const before = req.query.before;
  const id = req.query.id;
  if ((before == null || before === "") && (id == null || id === "")) return null;
  const at = typeof before === "string" ? Number(before) : NaN;
  if (!Number.isSafeInteger(at) || at < 0 || typeof id !== "string" || !PAGE_ID.test(id)) {
    throw new SocialError(400, "Bad page.");
  }
  return { at, id };
}

socialRouter.get(
  "/timeline",
  readLimit,
  wrap(async (req, res) => {
    const me = currentUser(res);
    const cursor = timelineCursor(req);
    const { posts, next } = await timeline(me?.name ?? null, cursor);
    const notes = cursor || !me ? [] : await unseenNotes(me.name);
    res.json({ me: await publicMe(me), posts, notes, next });
  }),
);

socialRouter.get(
  "/saved",
  requireAuth,
  readLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const posts = await savedPosts(me.name);
    res.json({ me: await publicMe(me), posts, notes: [] });
  }),
);

const postRaw = express.raw({
  type: "application/octet-stream",
  limit: MAX_PHOTOS * (PHOTO_BYTES + PHOTO_SMALL_BYTES) + 2048,
});

/**
 * Text, then pictures.
 *
 * Two bytes of text length, the UTF-8, one byte of count, then each picture
 * as the phone JPEG and the desktop JPEG. Each of those is a four-byte length
 * and its bytes, phone first, the same order a profile photo uses. A post
 * with no pictures stays JSON.
 */
function readPackedPost(buf: Buffer): { text: string; photos: { full: Buffer; small: Buffer }[] } {
  if (buf.length < 3) throw new SocialError(400, "Malformed request.");
  const textLen = buf.readUInt16BE(0);
  if (textLen > 1024 || 2 + textLen >= buf.length) throw new SocialError(400, "Malformed request.");
  const text = buf.subarray(2, 2 + textLen).toString("utf8");
  let at = 2 + textLen;
  const count = buf[at++];
  if (count > MAX_PHOTOS) throw new SocialError(400, "Four photos at most.");
  const photos: { full: Buffer; small: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 8 > buf.length) throw new SocialError(400, "Malformed request.");
    const smallLen = buf.readUInt32BE(at);
    const fullLen = buf.readUInt32BE(at + 4);
    at += 8;
    if (smallLen < 1 || smallLen > PHOTO_SMALL_BYTES || fullLen < 1 || fullLen > PHOTO_BYTES) {
      throw new SocialError(400, "Each photo must be 48KB or smaller.");
    }
    if (at + smallLen + fullLen > buf.length) throw new SocialError(400, "Malformed request.");
    photos.push({
      small: buf.subarray(at, at + smallLen),
      full: buf.subarray(at + smallLen, at + smallLen + fullLen),
    });
    at += smallLen + fullLen;
  }
  if (at !== buf.length) throw new SocialError(400, "Malformed request.");
  return { text, photos };
}

function checkPostPhoto(bytes: Buffer, max: number, edge: number): void {
  const size = jpegSize(bytes);
  if (!size) throw new SocialError(400, "Photo must be a JPEG.");
  if (bytes.length > max || size.w > edge || size.h > edge) throw new SocialError(400, "Photo is too large.");
}

function readPost(req: Request, res: Response, next: NextFunction) {
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/octet-stream")) {
    postRaw(req, res, (err?: unknown) => {
      if (err) {
        res.status(413).json({ error: "Each photo must be 48KB or smaller." });
        return;
      }
      next();
    });
    return;
  }
  readJson(req, res, next);
}

socialRouter.post(
  "/post",
  requireAuth,
  writeLimit,
  readPost,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    let textIn: unknown = req.body?.text;
    let photos: { full: Buffer; small: Buffer }[] = [];
    if (Buffer.isBuffer(req.body)) {
      const packed = readPackedPost(req.body);
      textIn = packed.text;
      photos = packed.photos;
    }
    const text = postText(textIn);
    if (!text.ok) throw new SocialError(400, text.error);
    if (!text.text && photos.length === 0) throw new SocialError(400, "Write something.");
    for (const photo of photos) {
      checkPostPhoto(photo.small, PHOTO_SMALL_BYTES, PHOTO_SMALL_EDGE);
      checkPostPhoto(photo.full, PHOTO_BYTES, PHOTO_EDGE);
    }
    const created = await createPost(me.name, text.text, Date.now(), photos);
    if ("wait" in created) throw new SocialError(429, waitText(created.wait), { wait: created.wait });
    res.json({ post: created });
  }),
);

socialRouter.post(
  "/comment",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const postId = typeof req.body?.post === "string" ? req.body.post : "";
    const text = shortText(req.body?.text, MAX_TEXT);
    if (!text.ok) throw new SocialError(400, text.error);
    const comment = await addComment(me.name, me.avatarRev, postId, text.text, Date.now());
    res.json({ comment });
  }),
);

socialRouter.post(
  "/plus",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const postId = typeof req.body?.post === "string" ? req.body.post : "";
    const saved = await toggleSave(me.name, postId, Date.now());
    res.json({ saved });
  }),
);

socialRouter.post(
  "/repost",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const postId = typeof req.body?.post === "string" ? req.body.post : "";
    await repost(me.name, postId, Date.now());
    res.json({ ok: true });
  }),
);

socialRouter.post(
  "/pay",
  payLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const lamports = parseSol(req.body?.sol);
    if (lamports == null) throw new SocialError(400, "Enter an amount of SOL.");
    const toText = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const fromText = typeof req.body?.from === "string" ? req.body.from.trim() : "";
    const to = solanaPubkey(toText);
    const from = solanaPubkey(fromText);
    if (!to || !from) throw new SocialError(400, "That is not a Solana address.");
    if (fromText === toText) throw new SocialError(400, "You can't pay yourself.");
    const recipient = await userByAddress(toText);
    if (!recipient) throw new SocialError(404, "No such wallet.");
    const tx = await prepareTransfer(from, to, lamports);
    res.json({ transaction: tx.toString("base64") });
  }),
);

socialRouter.post(
  "/open",
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const postId = typeof req.body?.post === "string" ? req.body.post : "";
    const who = currentUser(res)?.name ?? null;
    const opened = await openPost(postId, who);
    if (!opened) throw new SocialError(404, "That post is gone.");
    res.json({ ...opened, me: await publicMe(currentUser(res)) });
  }),
);

socialRouter.post(
  "/notes/seen",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    await markSeen(me.name);
    res.json({ ok: true });
  }),
);

socialRouter.get(
  "/users",
  requireAuth,
  searchLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const raw = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const users = /^[a-z0-9_]{1,16}$/.test(raw) ? await searchUsers(me.name, raw) : [];
    res.json({ me: await publicMe(me), users });
  }),
);

socialRouter.get(
  "/people",
  searchLimit,
  wrap(async (req, res) => {
    const raw = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().replace(/^@/, "") : "";
    res.json({ people: /^[a-z0-9_]{3,16}$/.test(raw) ? await findPeople(raw) : [] });
  }),
);

socialRouter.get(
  "/friends",
  requireAuth,
  readLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const friends = await friendList(me.name);
    res.json({ me: await publicMe(me), friends });
  }),
);

socialRouter.post(
  "/friends",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const name = username(req.body?.username);
    if (!name) throw new SocialError(400, "Usernames are 3–16 letters, numbers, or _.");
    if (name === me.name) throw new SocialError(400, "You can't add yourself.");
    await addFriend(me.name, name);
    res.json({ friends: await friendList(me.name) });
  }),
);

socialRouter.delete(
  "/friends/:name",
  requireAuth,
  writeLimit,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const name = username(req.params.name);
    if (!name) throw new SocialError(400, "No such person.");
    await removeFriend(me.name, name);
    res.json({ friends: await friendList(me.name) });
  }),
);

socialRouter.get(
  "/u/:name",
  readLimit,
  wrap(async (req, res) => {
    const me = currentUser(res);
    const name = username(req.params.name);
    const user = name ? await getUser(name) : null;
    if (!user) {
      res.status(404).json({ error: "No such person.", me: await publicMe(me) });
      return;
    }
    const posts = await postsBy(user.name, me?.name ?? null);
    res.json({
      me: await publicMe(me),
      user: {
        name: user.name,
        address: user.address,
        bio: user.bio,
        loc: user.loc,
        avatarRev: user.avatarRev,
        posts,
      },
    });
  }),
);

socialRouter.post(
  "/profile",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    // The field is not editable. Refusing it, rather than ignoring it, is what
    // makes a client that sends a new name find out instead of appearing to work.
    if ("username" in (req.body ?? {}) || "name" in (req.body ?? {})) {
      throw new SocialError(400, "Usernames can't be changed.");
    }
    const bio = shortText(req.body?.bio === "" ? " " : req.body?.bio, MAX_BIO);
    const loc = shortText(req.body?.loc === "" ? " " : req.body?.loc, MAX_LOC);
    // Empty is allowed and means clear. `shortText` treats a blank as a miss,
    // so a single space above stands in for "present but empty" and is dropped.
    const nextBio = req.body?.bio === "" ? "" : bio.ok ? bio.text : null;
    const nextLoc = req.body?.loc === "" ? "" : loc.ok ? loc.text : null;
    if (req.body?.bio !== undefined && nextBio === null) {
      throw new SocialError(400, bio.ok ? "Write something." : bio.error);
    }
    if (req.body?.loc !== undefined && nextLoc === null) {
      throw new SocialError(400, loc.ok ? "Write something." : loc.error);
    }
    await updateProfile(me.name, nextBio, nextLoc);
    res.json({ ok: true });
  }),
);

socialRouter.post(
  "/phrase",
  requireAuth,
  passwordLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    refuseGuessing(me.name);
    let phrase: string;
    try {
      // The GCM tag is the password check; a second scrypt would add nothing.
      phrase = await openPhrase(
        { salt: me.phraseSalt, iv: me.phraseIv, tag: me.phraseTag, ct: me.phraseCt },
        password,
      );
    } catch {
      noteMiss(me.name);
      throw new SocialError(403, "Wrong password.");
    }
    if (!me.keyBox) await setKeyBox(me.name, sealForServer(phrase));
    res.locals.revealPhrase = true;
    res.json({ phrase });
  }),
);

socialRouter.post(
  "/phrase/passkey/options",
  requireAuth,
  loginLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    if (!me.passkey) throw new SocialError(400, "Add a passkey first.");
    const challenge = issue("phrase", me.name);
    res.json({ challenge: challenge.toString("base64url"), id: me.passkey.id });
  }),
);

/** A passkey reveals the phrase from the server's copy; an account without one yet needs its password once. */
socialRouter.post(
  "/phrase/passkey",
  requireAuth,
  secretLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    if (!me.passkey) throw new SocialError(400, "Add a passkey first.");
    const clientData = b64(req.body?.clientData);
    const authData = b64(req.body?.authenticatorData);
    const signature = b64(req.body?.signature);
    const challenge = b64(req.body?.challenge);
    if (!clientData || !authData || !signature || !challenge) {
      throw new SocialError(400, "Passkey was not completed.");
    }
    if (!take(challenge, "phrase", me.name)) {
      throw new SocialError(403, "Passkey challenge expired. Try again.");
    }
    let count: number;
    try {
      count = verifyAssertion({
        clientData,
        authData,
        signature,
        cose: Buffer.from(me.passkey.cose, "base64url"),
        challenge,
        origin: originOf(req),
        rpId: rpIdOf(req),
        prevCount: me.passkey.count,
      });
      await bumpPasskeyCount(me.name, count);
    } catch {
      // 403, not 401: the session is fine, and the client reads 401 as logged out.
      throw new SocialError(403, "Passkey was not accepted.");
    }
    if (!me.keyBox) {
      throw new SocialError(409, "Enter your password once. After that, the passkey is enough.", { setup: true });
    }
    res.locals.revealPhrase = true;
    res.json({ phrase: openForServer(me.keyBox) });
  }),
);

/**
 * Swap from the account's own wallet. The server quotes, signs and sends; see
 * swap.ts for what a caller can and cannot choose.
 */
socialRouter.post(
  "/swap",
  requireAuth,
  payLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const input = typeof req.body?.inputMint === "string" ? req.body.inputMint : "";
    const output = typeof req.body?.outputMint === "string" ? req.body.outputMint : "";
    const amount = typeof req.body?.amount === "string" ? req.body.amount : "";
    const slippageBps = Number(req.body?.slippageBps ?? 100);
    // The output the person reviewed. The server re-quotes, and refuses to
    // trade below this less the slippage rather than at whatever it finds.
    const quotedOut = typeof req.body?.quotedOut === "string" ? req.body.quotedOut : "";
    if (!solanaPubkey(input) || !solanaPubkey(output) || input === output) {
      throw new SocialError(400, "Pick two different tokens.");
    }
    if (!/^\d{1,20}$/.test(amount) || BigInt(amount) <= 0n) throw new SocialError(400, "Enter an amount.");
    if (!/^\d{1,30}$/.test(quotedOut) || BigInt(quotedOut) <= 0n) throw new SocialError(400, "Review the trade first.");
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
      throw new SocialError(400, "Slippage is out of range.");
    }
    if (!me.keyBox) {
      throw new SocialError(409, "Log in with your password once to trade from this account.", { setup: true });
    }
    res.json(await swapFor(me.address, openForServer(me.keyBox), {
        input,
        output,
        amount,
        slippageBps,
        quotedOut: BigInt(quotedOut),
      }),);
  }),
);

/**
 * What a session alone may send in a day, in dollars.
 *
 * Past it, a send needs the password or the passkey again, the same proof the
 * phrase asks for: a cookie that leaks can move at most this much. Kept in
 * memory, per account, over a rolling 24 hours; a restart forgets it, which
 * costs at most one more allowance. A send the person confirmed does not
 * count against it.
 */
const SEND_FREE_USD = 25;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const sent = new Map<string, { at: number; usd: number }[]>();

function sentToday(name: string, now: number): number {
  const list = (sent.get(name) ?? []).filter((s) => now - s.at < SEND_WINDOW_MS);
  if (list.length) sent.set(name, list);
  else sent.delete(name);
  return list.reduce((sum, s) => sum + s.usd, 0);
}

/** Dollar value from the token index, or null when this mint has no price there. */
function sendValue(mint: string, amount: bigint): number | null {
  const rec = lookupMints([mint]).get(mint);
  if (!rec || !(rec.price > 0) || rec.decimals == null) return null;
  return (Number(amount) / 10 ** rec.decimals) * rec.price;
}

/** Runs an IP limiter inside a handler. True when it refused, and has answered. */
function limited(limiter: ReturnType<typeof rateLimit>, req: Request, res: Response): boolean {
  let passed = false;
  limiter(req, res, () => {
    passed = true;
  });
  return !passed;
}

socialRouter.post(
  "/send/passkey/options",
  requireAuth,
  loginLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    if (!me.passkey) throw new SocialError(400, "Add a passkey first.");
    const challenge = issue("send", me.name);
    res.json({ challenge: challenge.toString("base64url"), id: me.passkey.id });
  }),
);

/**
 * Send SOL or an SPL token from the account's own wallet.
 *
 * Within the day's allowance the session is enough. Past it the body must
 * carry `password`, or a passkey assertion against a /send/passkey/options
 * challenge; without one the answer is 403 with `stepUp`, and the client asks.
 */
socialRouter.post(
  "/send",
  requireAuth,
  payLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const to = solanaPubkey(typeof req.body?.to === "string" ? req.body.to : "");
    const mint = typeof req.body?.mint === "string" ? req.body.mint : "";
    const amount = typeof req.body?.amount === "string" ? req.body.amount : "";
    if (!to) throw new SocialError(400, "That isn't a Solana address.");
    if (to.equals(solanaPubkey(me.address)!)) throw new SocialError(400, "That is this wallet's own address.");
    if (!solanaPubkey(mint)) throw new SocialError(400, "Pick a token to send.");
    if (!/^\d{1,20}$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) >= 2n ** 64n) {
      throw new SocialError(400, "Enter an amount.");
    }
    if (!me.keyBox) {
      throw new SocialError(409, "Log in with your password once to send from this account.", { setup: true });
    }

    const now = Date.now();
    const usd = sendValue(mint, BigInt(amount));
    let confirmed = false;
    if (typeof req.body?.password === "string") {
      if (limited(passwordLimit, req, res)) return;
      if (!(await passwordMatches(me, req.body.password))) throw new SocialError(403, "Wrong password.");
      confirmed = true;
    } else if (req.body?.challenge != null) {
      await assertPasskey(req, me, "send");
      confirmed = true;
    }
    // An unpriced token is never inside the allowance: its worth is unknown.
    if (!confirmed && (usd == null || sentToday(me.name, now) + usd > SEND_FREE_USD)) {
      throw new SocialError(403, "Confirm this send with your password or passkey.", {
        stepUp: true,
        passkey: !!me.passkey,
      });
    }

    const result = await sendFor(me.address, openForServer(me.keyBox), { to, mint, amount: BigInt(amount) });
    if (!confirmed && usd != null) sent.set(me.name, [...(sent.get(me.name) ?? []), { at: now, usd }]);
    res.json(result);
  }),
);

/**
 * A wrong password while signed in is 403, not 401: the session is fine, and
 * the client reads 401 as "you are logged out".
 *
 * Adding a passkey asks for the password first. A passkey signs in without
 * one, so letting a session alone enroll it would turn a stolen cookie into
 * an account that stays stolen.
 */
socialRouter.post(
  "/passkey/options",
  requireAuth,
  passwordLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!(await passwordMatches(me, password))) throw new SocialError(403, "Wrong password.");
    const challenge = issue("add", me.name);
    res.json({ challenge: challenge.toString("base64url"), uid: me.uid });
  }),
);

socialRouter.post(
  "/passkey",
  requireAuth,
  writeLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const clientData = b64(req.body?.clientData);
    const attestation = b64(req.body?.attestation);
    const challenge = b64(req.body?.challenge);
    if (!id || !clientData || !attestation || !challenge) {
      throw new SocialError(400, "Passkey was not completed.");
    }
    if (!take(challenge, "add", me.name)) {
      throw new SocialError(401, "Passkey challenge expired. Try again.");
    }
    let registered;
    try {
      registered = verifyRegistration({
        clientData,
        attestation,
        id,
        challenge,
        origin: originOf(req),
        rpId: rpIdOf(req),
      });
    } catch {
      throw new SocialError(400, "Passkey was not accepted.");
    }
    await setPasskey(me.name, registered);
    res.json({ ok: true });
  }),
);

/**
 * A passkey assertion against a challenge this account was issued. 403, not
 * 401, on failure: the session is fine, and the client reads 401 as logged out.
 */
async function assertPasskey(req: Request, me: User, kind: Challenge["kind"]): Promise<void> {
  if (!me.passkey) throw new SocialError(400, "Add a passkey first.");
  const clientData = b64(req.body?.clientData);
  const authData = b64(req.body?.authenticatorData);
  const signature = b64(req.body?.signature);
  const challenge = b64(req.body?.challenge);
  if (!clientData || !authData || !signature || !challenge) {
    throw new SocialError(400, "Passkey was not completed.");
  }
  if (!take(challenge, kind, me.name)) throw new SocialError(403, "Passkey challenge expired. Try again.");
  try {
    const count = verifyAssertion({
      clientData,
      authData,
      signature,
      cose: Buffer.from(me.passkey.cose, "base64url"),
      challenge,
      origin: originOf(req),
      rpId: rpIdOf(req),
      prevCount: me.passkey.count,
    });
    await bumpPasskeyCount(me.name, count);
  } catch {
    throw new SocialError(403, "Passkey was not accepted.");
  }
}

/**
 * Messenger.
 *
 * End to end: each account has an ECDH P-256 key made in the browser. Its
 * private half is sealed there under a key the passkey derives (WebAuthn PRF)
 * and only that box reaches us. Two people's keys agree on a conversation key
 * that never leaves either device, so every message and photo here is
 * ciphertext. Publishing a key takes a passkey assertion, so a stolen session
 * cannot swap in a key of its own and read what is sent afterwards.
 */

function sealed(input: unknown, min: number, max: number): string | null {
  const raw = b64(input);
  return raw && raw.length >= min && raw.length <= max ? raw.toString("base64url") : null;
}

/** An uncompressed P-256 point that is actually on the curve. */
function chatPub(input: unknown): string | null {
  const raw = b64(input);
  if (!raw || raw.length !== 65 || raw[0] !== 4) return null;
  try {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return null;
  }
  return raw.toString("base64url");
}

function version(input: unknown): number | null {
  return Number.isSafeInteger(input) && (input as number) > 0 ? (input as number) : null;
}

/** The other person in a conversation: a real account that is not you. */
async function peerOf(me: User, raw: unknown): Promise<User> {
  const name = username(raw);
  if (name === me.name) throw new SocialError(400, "You can't message yourself.");
  const peer = name ? await getUser(name) : null;
  if (!peer) throw new SocialError(404, "No such person.");
  return peer;
}

/** `cred` is the passkey the box must be opened with; the key is null until Messenger is turned on. */
socialRouter.get(
  "/ck",
  requireAuth,
  readLimit,
  wrap(async (_req, res) => {
    const me = requireUser(res);
    res.json({ cred: me.passkey?.id ?? null, key: await chatKey(me.name) });
  }),
);

socialRouter.post(
  "/ck/options",
  requireAuth,
  loginLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    if (!me.passkey) throw new SocialError(400, "Add a passkey first.");
    const challenge = issue("chat", me.name);
    res.json({ challenge: challenge.toString("base64url"), id: me.passkey.id });
  }),
);

socialRouter.post(
  "/ck",
  requireAuth,
  secretLimit,
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const pub = chatPub(req.body?.pub);
    const iv = sealed(req.body?.iv, 12, 12);
    const ct = sealed(req.body?.ct, 32, 512);
    if (!pub || !iv || !ct) throw new SocialError(400, "Malformed key.");
    await assertPasskey(req, me, "chat");
    const v = await addChatKey(me.name, { pub, cred: me.passkey!.id, iv, ct }, Date.now());
    res.json({ v });
  }),
);

function chatCursor(req: Request, key: "before" | "after"): { at: number; id: string } | null {
  const at = req.query[key];
  const id = req.query.id;
  if (at == null || at === "") return null;
  const n = typeof at === "string" ? Number(at) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || typeof id !== "string" || !PAGE_ID.test(id)) {
    throw new SocialError(400, "Bad page.");
  }
  return { at: n, id };
}

socialRouter.get(
  "/c",
  requireAuth,
  readLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const after = typeof req.query.after === "string" ? Number(req.query.after) : null;
    let before: { at: number; peer: string } | null = null;
    if (typeof req.query.before === "string") {
      const at = Number(req.query.before);
      const peer = username(req.query.peer);
      if (!Number.isSafeInteger(at) || at < 0 || !peer) throw new SocialError(400, "Bad page.");
      before = { at, peer };
    }
    if (after != null && (!Number.isSafeInteger(after) || after < 0)) throw new SocialError(400, "Bad page.");
    const { chats, next } = await chatList(me.name, { before, after });
    res.json({ me: await publicMe(me), chats, next });
  }),
);

/** Newest page with no cursor, which also brings the other person's public keys. */
socialRouter.get(
  "/c/:name",
  requireAuth,
  readLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const peer = await peerOf(me, req.params.name);
    const before = chatCursor(req, "before");
    const after = chatCursor(req, "after");
    const { messages, next } = await thread(me.name, peer.name, { before, after });
    const first = !before && !after;
    res.json({
      me: await publicMe(me),
      peer: first ? { name: peer.name, avatarRev: peer.avatarRev, keys: await chatKeys(peer.name) } : undefined,
      messages,
      next,
    });
  }),
);

const chatRaw = express.raw({
  type: "application/octet-stream",
  limit: 4 * (CHAT_PHOTO_BYTES + 4) + 8 * 1024,
});

/**
 * Two bytes of header length, the header as JSON ({kf, kt, iv, ct}), one
 * byte of photo count, then each sealed photo as a four-byte length and its
 * bytes. The same shape as a post, with the text replaced by its ciphertext.
 */
function readPackedMessage(buf: Buffer): { head: Record<string, unknown>; photos: Buffer[] } {
  if (buf.length < 3) throw new SocialError(400, "Malformed request.");
  const headLen = buf.readUInt16BE(0);
  if (headLen > 6 * 1024 || 2 + headLen >= buf.length) throw new SocialError(400, "Malformed request.");
  let head: unknown;
  try {
    head = JSON.parse(buf.subarray(2, 2 + headLen).toString("utf8"));
  } catch {
    throw new SocialError(400, "Malformed request.");
  }
  if (!head || typeof head !== "object") throw new SocialError(400, "Malformed request.");
  let at = 2 + headLen;
  const count = buf[at++];
  if (count > MAX_PHOTOS) throw new SocialError(400, "Four photos at most.");
  const photos: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 4 > buf.length) throw new SocialError(400, "Malformed request.");
    const len = buf.readUInt32BE(at);
    at += 4;
    if (len <= 28 || len > CHAT_PHOTO_BYTES) throw new SocialError(400, "Each photo must be 48KB or smaller.");
    if (at + len > buf.length) throw new SocialError(400, "Malformed request.");
    photos.push(buf.subarray(at, at + len));
    at += len;
  }
  if (at !== buf.length) throw new SocialError(400, "Malformed request.");
  return { head: head as Record<string, unknown>, photos };
}

socialRouter.post(
  "/c/:name",
  requireAuth,
  writeLimit,
  (req, res, next) => {
    chatRaw(req, res, (err?: unknown) => {
      if (err) {
        res.status(413).json({ error: "Each photo must be 48KB or smaller." });
        return;
      }
      next();
    });
  },
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    if (!Buffer.isBuffer(req.body)) throw new SocialError(400, "Malformed request.");
    const { head, photos } = readPackedMessage(req.body);
    const kf = version(head.kf);
    const kt = version(head.kt);
    const iv = sealed(head.iv, 12, 12);
    // A GCM tag alone is sixteen bytes: an empty text, allowed only under a photo.
    const ct = sealed(head.ct, 16, CHAT_CT_BYTES);
    if (!kf || !kt || !iv || !ct) throw new SocialError(400, "Malformed request.");
    if (Buffer.from(ct, "base64url").length === 16 && !photos.length) throw new SocialError(400, "Write something.");
    const peer = await peerOf(me, req.params.name);
    const sent = await sendMessage(me.name, peer.name, { kf, kt, iv, ct }, photos, Date.now());
    if ("stale" in sent) {
      throw new SocialError(409, "A key changed. Try again.", { stale: true });
    }
    res.json({ message: sent });
  }),
);

/** A sealed photo, for the two people in its conversation. It never changes, so it is cached. */
socialRouter.get(
  "/cp/:id/:n",
  requireAuth,
  readLimit,
  wrap(async (req, res) => {
    const me = requireUser(res);
    const n = /^[0-3]$/.test(req.params.n) ? Number(req.params.n) : -1;
    const id = PAGE_ID.test(req.params.id) ? req.params.id : "";
    const file = id && n >= 0 && n < (await chatPhotoCount(id, me.name)) ? chatPhotoFile(id, n) : null;
    if (!file) throw new SocialError(404, "Not found.");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.type("application/octet-stream").sendFile(file);
  }),
);

const avatarRaw = express.raw({
  type: ["image/jpeg", "application/octet-stream"],
  limit: SOCIAL_BYTES + TINY_BYTES + 8,
});

/**
 * Two JPEGs in one body: 4-byte lengths, then the timeline copy, then the
 * profile copy. A lone JPEG is still accepted so an older upload keeps working.
 */
function readAvatarBody(buf: Buffer): { full: Buffer; tiny: Buffer | null } {
  if (buf.length >= 8) {
    const tinyLen = buf.readUInt32BE(0);
    const fullLen = buf.readUInt32BE(4);
    if (tinyLen > 0 && fullLen > 0 && buf.length === 8 + tinyLen + fullLen) {
      return { tiny: buf.subarray(8, 8 + tinyLen), full: buf.subarray(8 + tinyLen) };
    }
  }
  return { full: buf, tiny: null };
}

function checkPhoto(bytes: Buffer, max: number, maxW: number | null, tooBig: string): void {
  if (bytes.length < 1) throw new SocialError(400, "Photo must be a JPEG.");
  if (bytes.length > max) throw new SocialError(413, tooBig);
  const size = jpegSize(bytes);
  if (!size) throw new SocialError(400, "Photo must be a JPEG.");
  // Width may equal height. Wider than tall is the case the rule excludes,
  // and we do not crop: cropping would be a different picture.
  if (size.w > size.h) throw new SocialError(400, "Use a square or portrait photo.");
  if (maxW !== null && size.w > maxW) throw new SocialError(400, "Timeline photo is too wide.");
}

socialRouter.post(
  "/avatar",
  requireAuth,
  writeLimit,
  (req, res, next) => {
    avatarRaw(req, res, (err?: unknown) => {
      if (err) {
        res.status(413).json({ error: "Photo must be 14KB or smaller." });
        return;
      }
      next();
    });
  },
  wrap(async (req, res) => {
    assertSameOrigin(req);
    const me = requireUser(res);
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
      throw new SocialError(400, "Photo must be a JPEG.");
    }
    const parts = readAvatarBody(bytes);
    checkPhoto(parts.full, SOCIAL_BYTES, null, "Photo must be 14KB or smaller.");
    if (parts.tiny) checkPhoto(parts.tiny, TINY_BYTES, TINY_W, "Timeline photo is too big.");
    const rev = await bumpAvatar(me.name);
    writeAvatar(me.name, parts.full, parts.tiny ?? undefined);
    res.json({ avatarRev: rev });
  }),
);

export function sendPostPhoto(req: Request, res: Response): void {
  const n = typeof req.params.n === "string" && /^[0-3]$/.test(req.params.n) ? Number(req.params.n) : -1;
  const file = n >= 0 ? postPhotoFile(req.params.id, n, req.query.m === "1") : null;
  if (!file) {
    res.status(404).type("text").send("Not found.");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("jpeg").sendFile(file);
}

export function sendAvatar(req: Request, res: Response): void {
  const name = username(req.params.name);
  const file = name ? avatarFile(name, req.path.startsWith("/social/t/")) : null;
  if (!file) {
    res.status(404).type("text").send("Not found.");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("jpeg").sendFile(file);
}
