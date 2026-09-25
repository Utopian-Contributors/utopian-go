import express, { NextFunction, Request, Response, Router } from "express";
import { randomBytes } from "crypto";
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
import {
  type Card,
  type CommentRow,
  type User,
  addComment,
  addFriend,
  bumpAvatar,
  bumpPasskeyCount,
  countUnseen,
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
  setKeyBox,
  setPasskey,
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
import { avatarFile, postPhotoFile, writeAvatar } from "./store";
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
  kind: "login" | "add" | "phrase";
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
    unseen: await countUnseen(user.name),
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
 * target. It can lock the owner out for a while too, which is why recovery
 * does not go through it: the phrase always works.
 */
const FAIL_MAX = 10;
const FAIL_MS = 15 * 60 * 1000;
const fails = new Map<string, { n: number; until: number }>();

function refuseGuessing(name: string): void {
  const f = fails.get(name);
  if (f && f.n >= FAIL_MAX && f.until > Date.now()) {
    throw new SocialError(429, "Too many wrong passwords. Try again later.", { wait: f.until - Date.now() });
  }
}

function noteMiss(name: string): void {
  const now = Date.now();
  const f = fails.get(name);
  if (f && f.until > now) f.n++;
  else fails.set(name, { n: 1, until: now + FAIL_MS });
  if (fails.size > CHALLENGE_MAX) {
    for (const [key, value] of fails) if (value.until < now) fails.delete(key);
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
  fails.delete(user.name);
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
const loginLimit = rateLimit({ perMinute: 30, burst: 20 });
const recoverLimit = rateLimit({ perMinute: 10, burst: 5 });
const secretLimit = rateLimit({ perMinute: 10, burst: 5 });
const payLimit = rateLimit({ perMinute: 30, burst: 10 });
const writeLimit = rateLimit({ perMinute: 60, burst: 20 });
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
  loginLimit,
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
  loginLimit,
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
    fails.delete(user.name);
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
  wrap(async (_req, res) => {
    res.json({ me: await publicMe(currentUser(res)) });
  }),
);

socialRouter.post(
  "/logout",
  readJson,
  wrap(async (req, res) => {
    assertSameOrigin(req);
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
  secretLimit,
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
    if (!solanaPubkey(input) || !solanaPubkey(output) || input === output) {
      throw new SocialError(400, "Pick two different tokens.");
    }
    if (!/^\d{1,20}$/.test(amount) || BigInt(amount) <= 0n) throw new SocialError(400, "Enter an amount.");
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
      throw new SocialError(400, "Slippage is out of range.");
    }
    if (!me.keyBox) {
      throw new SocialError(409, "Log in with your password once to trade from this account.", { setup: true });
    }
    res.json(await swapFor(me.address, openForServer(me.keyBox), { input, output, amount, slippageBps }));
  }),
);

/** Send SOL or an SPL token from the account's own wallet. */
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
    res.json(await sendFor(me.address, openForServer(me.keyBox), { to, mint, amount: BigInt(amount) }));
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
  secretLimit,
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
