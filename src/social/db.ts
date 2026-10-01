import type { KeyBox } from "./auth";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { Pool, type PoolClient, types } from "pg";
import { CHAT_PAGE, MAX_CHAT_KEEP, MAX_COMMENTS, SocialError, postWait } from "./limits";
import type { AudioKind } from "./audio";
import {
  removeChatPhotos,
  removePostAudio,
  removePostPhotos,
  writeChatPhotos,
  writePostAudio,
  writePostPhotos,
} from "./store";

// int8 comes back as a string. Post times fit in a JS number.
types.setTypeParser(20, (value) => Number(value));

/**
 * Postgres, through SQL. SCHEMA below is the only description of the tables.
 * DATABASE_URL is the connection, read from .env when the process was not
 * given it.
 */
export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const file = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const line = file.split("\n").find((row) => row.startsWith("DATABASE_URL="));
    if (line) {
      const value = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
      if (value) {
        process.env.DATABASE_URL = value;
        return value;
      }
    }
  } catch {
    // No .env. The message below is the one that matters.
  }
  throw new Error("DATABASE_URL is not set. Social data lives in Postgres.");
}

let pool: Pool | null = null;

function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: databaseUrl() });
  return pool;
}

/** Tests and shutdown. The next query opens a new pool. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  name text PRIMARY KEY,
  uid text NOT NULL UNIQUE,
  pass_salt text NOT NULL,
  pass_hash text NOT NULL,
  phrase_salt text NOT NULL,
  phrase_iv text NOT NULL,
  phrase_tag text NOT NULL,
  phrase_ct text NOT NULL,
  address text NOT NULL,
  bio text NOT NULL DEFAULT '',
  loc text NOT NULL DEFAULT '',
  avatar_rev integer NOT NULL DEFAULT 0,
  last_post bigint NOT NULL DEFAULT 0,
  created bigint NOT NULL,
  passkey_id text,
  passkey_cose text,
  passkey_alg integer,
  passkey_count integer
);
CREATE TABLE IF NOT EXISTS friends (
  owner text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  friend text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  PRIMARY KEY (owner, friend)
);
CREATE TABLE IF NOT EXISTS posts (
  id text PRIMARY KEY,
  by_name text NOT NULL REFERENCES users(name),
  text text NOT NULL,
  at bigint NOT NULL,
  views integer NOT NULL DEFAULT 0,
  photos integer NOT NULL DEFAULT 0,
  audio integer NOT NULL DEFAULT 0,
  wave text NOT NULL DEFAULT '',
  repost text REFERENCES posts(id)
);
DROP INDEX IF EXISTS posts_at;
DROP INDEX IF EXISTS posts_by;
DROP INDEX IF EXISTS posts_by_at;
CREATE INDEX IF NOT EXISTS posts_at_id ON posts (at DESC, id DESC);
-- A profile, and each author's page of the Friends timeline.
CREATE INDEX IF NOT EXISTS posts_by_at_id ON posts (by_name, at DESC, id DESC);
-- One re-post per person per post, which also answers "did I re-post this".
CREATE UNIQUE INDEX IF NOT EXISTS posts_repost ON posts (repost, by_name) WHERE repost IS NOT NULL;
CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY,
  post text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  by_name text NOT NULL REFERENCES users(name),
  text text NOT NULL,
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments (post);
CREATE TABLE IF NOT EXISTS notes (
  id text PRIMARY KEY,
  to_name text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  from_name text NOT NULL REFERENCES users(name),
  post text NOT NULL,
  at bigint NOT NULL,
  seen boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'comment'
);
CREATE INDEX IF NOT EXISTS notes_to ON notes (to_name, seen);
CREATE INDEX IF NOT EXISTS notes_to_at ON notes (to_name, at DESC);
CREATE TABLE IF NOT EXISTS saves (
  post text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  by_name text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  at bigint NOT NULL,
  post_at bigint NOT NULL,
  PRIMARY KEY (post, by_name)
);
-- Saved was once its own page, in the order things were saved; the timeline's
-- filter reads saves_by_post instead.
DROP INDEX IF EXISTS saves_by_at;
-- Tables from before these columns existed keep their rows and gain them.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS photos integer NOT NULL DEFAULT 0;
-- A voice memo's length in milliseconds (0 when there is none), and its shape.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS audio integer NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS wave text NOT NULL DEFAULT '';
-- A re-post carries its original's photo count and memo length, so a
-- timeline filter reads one row. Re-posts from before that are given theirs.
UPDATE posts r SET photos = o.photos, audio = o.audio FROM posts o
  WHERE r.repost = o.id AND (r.photos <> o.photos OR r.audio <> o.audio);
-- The timeline with images or audio left out, or both.
CREATE INDEX IF NOT EXISTS posts_at_id_no_photos ON posts (at DESC, id DESC) WHERE photos = 0;
CREATE INDEX IF NOT EXISTS posts_at_id_no_audio ON posts (at DESC, id DESC) WHERE audio = 0;
CREATE INDEX IF NOT EXISTS posts_at_id_plain ON posts (at DESC, id DESC) WHERE photos = 0 AND audio = 0;
-- The saved post's own time, so Saved pages through saves in the timeline's order.
ALTER TABLE saves ADD COLUMN IF NOT EXISTS post_at bigint;
UPDATE saves s SET post_at = p.at FROM posts p WHERE p.id = s.post AND s.post_at IS NULL;
ALTER TABLE saves ALTER COLUMN post_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS saves_by_post ON saves (by_name, post_at DESC, post DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
-- The phrase sealed a second time, under WALLET_KEY from the environment, so the server can sign.
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_iv text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_tag text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_ct text;
-- Proof of acceptance: which Terms of Service the account agreed to at sign-up, and when.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_at bigint;
ALTER TABLE users DROP COLUMN IF EXISTS prf_salt;
ALTER TABLE users DROP COLUMN IF EXISTS prf_iv;
ALTER TABLE users DROP COLUMN IF EXISTS prf_tag;
ALTER TABLE users DROP COLUMN IF EXISTS prf_ct;
-- /pay and recovery find an account by address, passkey login by credential.
CREATE UNIQUE INDEX IF NOT EXISTS users_address ON users (address);
CREATE UNIQUE INDEX IF NOT EXISTS users_passkey ON users (passkey_id);
-- Messenger. Every column the server holds is public key, ciphertext, or who and when.
-- A key's private half is sealed under the passkey (PRF) that cred names.
CREATE TABLE IF NOT EXISTS chat_keys (
  name text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  v integer NOT NULL,
  pub text NOT NULL,
  cred text NOT NULL,
  iv text NOT NULL,
  ct text NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (name, v)
);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  pair text NOT NULL,
  from_name text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  to_name text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  at bigint NOT NULL,
  kf integer NOT NULL,
  kt integer NOT NULL,
  iv text NOT NULL,
  ct text NOT NULL,
  photos integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (pair, at DESC, id DESC);
-- One row per person per conversation: the sidebar, newest first.
CREATE TABLE IF NOT EXISTS chats (
  owner text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  peer text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  at bigint NOT NULL,
  last text NOT NULL,
  unread integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, peer)
);
CREATE INDEX IF NOT EXISTS chats_owner_at ON chats (owner, at DESC, peer DESC);
`;

let ready: Promise<void> | null = null;

/**
 * Tables exist before the first social query.
 *
 * Search does not wait on this, so a database that is down costs social and
 * nothing else. A failure is forgotten, so the next request tries again.
 */
export function ensureSchema(): Promise<void> {
  ready ??= db()
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

/** Tests start from an empty social database. Avatars on disk are separate. */
export async function resetSocial(): Promise<void> {
  await db().query("TRUNCATE users CASCADE");
}

type UserRow = {
  name: string;
  uid: string;
  pass_salt: string;
  pass_hash: string;
  phrase_salt: string;
  phrase_iv: string;
  phrase_tag: string;
  phrase_ct: string;
  address: string;
  bio: string;
  loc: string;
  avatar_rev: number;
  last_post: number;
  created: number;
  passkey_id: string | null;
  passkey_cose: string | null;
  passkey_alg: number | null;
  passkey_count: number | null;
  epoch: number;
  key_iv: string | null;
  key_tag: string | null;
  key_ct: string | null;
  terms_version: string | null;
  terms_at: number | null;
};

export interface Passkey {
  id: string;
  cose: string;
  alg: number;
  count: number;
}

export interface User {
  name: string;
  uid: string;
  passSalt: string;
  passHash: string;
  phraseSalt: string;
  phraseIv: string;
  phraseTag: string;
  phraseCt: string;
  address: string;
  bio: string;
  loc: string;
  avatarRev: number;
  lastPost: number;
  passkey: Passkey | null;
  created: number;
  /** Session counter. A cookie signed under another value is refused. */
  epoch: number;
  /** The phrase sealed under WALLET_KEY. Absent on accounts made before it, until the next password. */
  keyBox: KeyBox | null;
  /** The Terms of Service version accepted at sign-up, and when. Null only on accounts from before the checkbox. */
  terms: { version: string; at: number } | null;
}

export interface Card {
  id: string;
  by: string;
  text: string;
  at: number;
  views: number;
  comments: number;
  saved: boolean;
  reposted: boolean;
  repost: string | null;
  /** Author of the original post, when this card is a re-post. */
  repostBy: string | null;
  originalRev: number;
  avatarRev: number;
  /** Pictures on this post, or on the original when this card is a re-post. */
  photos: number;
  /** Milliseconds of voice memo, or 0. Like photos, a re-post carries the original's. */
  audio: number;
  /** The memo's shape, one base64url character per bar; empty without a memo. */
  wave: string;
}

export interface CommentRow {
  id: string;
  by: string;
  text: string;
  at: number;
  avatarRev: number;
}

export interface NoteRow {
  id: string;
  from: string;
  post: string;
  at: number;
  kind: string;
}

const USER_COLS = `name, uid, pass_salt, pass_hash, phrase_salt, phrase_iv, phrase_tag, phrase_ct,
  address, bio, loc, avatar_rev, last_post, created, passkey_id, passkey_cose, passkey_alg, passkey_count, epoch,
  key_iv, key_tag, key_ct, terms_version, terms_at`;

function userFrom(row: UserRow): User {
  return {
    name: row.name,
    uid: row.uid,
    passSalt: row.pass_salt,
    passHash: row.pass_hash,
    phraseSalt: row.phrase_salt,
    phraseIv: row.phrase_iv,
    phraseTag: row.phrase_tag,
    phraseCt: row.phrase_ct,
    address: row.address,
    bio: row.bio,
    loc: row.loc,
    avatarRev: row.avatar_rev,
    lastPost: Number(row.last_post),
    created: Number(row.created),
    epoch: row.epoch,
    keyBox:
      row.key_iv && row.key_tag && row.key_ct ? { iv: row.key_iv, tag: row.key_tag, ct: row.key_ct } : null,
    terms: row.terms_version && row.terms_at != null ? { version: row.terms_version, at: Number(row.terms_at) } : null,
    passkey:
      row.passkey_id && row.passkey_cose && row.passkey_alg != null && row.passkey_count != null
        ? { id: row.passkey_id, cose: row.passkey_cose, alg: row.passkey_alg, count: row.passkey_count }
        : null,
  };
}

async function one<T>(text: string, params: unknown[] = [], client?: PoolClient): Promise<T | null> {
  const res = await (client ?? db()).query(text, params);
  return (res.rows[0] as T) ?? null;
}

async function many<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query(text, params);
  return res.rows as T[];
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUser(name: string): Promise<User | null> {
  const row = await one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE name = $1`, [name]);
  return row ? userFrom(row) : null;
}

export async function userByAddress(address: string): Promise<User | null> {
  const row = await one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE address = $1`, [address]);
  return row ? userFrom(row) : null;
}

export async function userByPasskey(id: string): Promise<User | null> {
  const row = await one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE passkey_id = $1`, [id]);
  return row ? userFrom(row) : null;
}

export async function insertUser(user: User): Promise<boolean> {
  const res = await db().query(
    `INSERT INTO users (
       name, uid, pass_salt, pass_hash, phrase_salt, phrase_iv, phrase_tag, phrase_ct,
       address, bio, loc, avatar_rev, last_post, created, key_iv, key_tag, key_ct,
       terms_version, terms_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT DO NOTHING`,
    [
      user.name, user.uid, user.passSalt, user.passHash, user.phraseSalt, user.phraseIv,
      user.phraseTag, user.phraseCt, user.address, user.bio, user.loc, user.avatarRev,
      user.lastPost, user.created, user.keyBox?.iv ?? null, user.keyBox?.tag ?? null,
      user.keyBox?.ct ?? null, user.terms?.version ?? null, user.terms?.at ?? null,
    ],
  );
  return res.rowCount === 1;
}

/** Unseen notes, and messages not yet opened. One round trip for both badges. */
export async function countUnseen(name: string): Promise<{ unseen: number; unread: number }> {
  const row = await one<{ unseen: number; unread: number }>(
    `SELECT (SELECT count(*) FROM notes WHERE to_name = $1 AND seen = false)::int AS unseen,
            (SELECT COALESCE(sum(unread), 0) FROM chats WHERE owner = $1)::int AS unread`,
    [name],
  );
  return { unseen: row?.unseen ?? 0, unread: row?.unread ?? 0 };
}

type CardRow = {
  id: string;
  by_name: string;
  text: string;
  at: number;
  views: number;
  repost: string | null;
  original_by: string | null;
  original_rev: number | null;
  avatar_rev: number;
  comments: number;
  saved: boolean;
  reposted: boolean;
  photos: number;
  audio: number;
  wave: string;
};

function cardFrom(row: CardRow): Card {
  return {
    id: row.id,
    by: row.by_name,
    text: row.text,
    at: Number(row.at),
    views: row.views,
    comments: row.comments,
    saved: row.saved,
    reposted: row.reposted,
    repost: row.repost,
    repostBy: row.original_by,
    originalRev: row.original_rev ?? 0,
    avatarRev: row.avatar_rev,
    photos: row.photos,
    audio: row.audio,
    wave: row.wave,
  };
}

/** `$1` is the viewer, or null when nobody is logged in. `from` names the posts `p`. */
function card(from: string): string {
  return `
  SELECT p.id, p.by_name, p.text, p.at, p.views, p.repost,
         CASE WHEN p.repost IS NULL THEN p.photos ELSE COALESCE(op.photos, 0) END AS photos,
         CASE WHEN p.repost IS NULL THEN p.audio ELSE COALESCE(op.audio, 0) END AS audio,
         CASE WHEN p.repost IS NULL THEN p.wave ELSE COALESCE(op.wave, '') END AS wave,
         u.avatar_rev,
         op.by_name AS original_by,
         ou.avatar_rev AS original_rev,
         (SELECT count(*)::int FROM comments c WHERE c.post = p.id) AS comments,
         EXISTS (SELECT 1 FROM saves s WHERE s.post = p.id AND s.by_name = $1) AS saved,
         EXISTS (SELECT 1 FROM posts r WHERE r.repost = p.id AND r.by_name = $1) AS reposted
  FROM ${from}
  JOIN users u ON u.name = p.by_name
  LEFT JOIN posts op ON op.id = p.repost
  LEFT JOIN users ou ON ou.name = op.by_name
`;
}

const CARD = card("posts p");

/** One screenful. The next page starts strictly before the last row of this one. */
export const TIMELINE_PAGE = 20;

/**
 * What the timeline shows. Friends narrows it to the people the viewer added,
 * and the viewer; saved, to the viewer's own saves. Images or audio off
 * leaves out every post that carries them.
 */
export interface FeedFilter {
  friends: boolean;
  saved: boolean;
  images: boolean;
  audio: boolean;
}

export const WHOLE_FEED: FeedFilter = { friends: false, saved: false, images: true, audio: true };

/**
 * One page of the timeline, filtered in the query.
 *
 * The page's ids are picked first, each way of filtering walking an index in
 * the timeline's own order, and only those rows are made into cards. So a
 * page costs about a page of index entries however far down it is and
 * however rare what is asked for:
 *   - everyone: posts_at_id, or posts_at_id_no_photos / _no_audio / _plain
 *     when images or audio are off (literal zeros below, so they match);
 *   - friends: each author's newest page on posts_by_at_id, and the newest of
 *     those. At most a page per author, and a friend list holds 200;
 *   - saved: saves_by_post, the viewer's saves in the order of the posts.
 *     Friends, images and audio are checked on the way; a person's saves are
 *     a short list.
 * Signed out, friends and saved mean nobody's, so they are ignored.
 */
export async function timeline(
  who: string | null,
  before?: { at: number; id: string } | null,
  filter: FeedFilter = WHOLE_FEED,
): Promise<{ posts: Card[]; next: { at: number; id: string } | null }> {
  const params: unknown[] = [who];
  if (before) params.push(before.at, before.id);
  params.push(TIMELINE_PAGE + 1);
  const limit = `$${params.length}`;
  const after = (at: string, id: string) => (before ? [`(${at}, ${id}) < ($2::bigint, $3::text)`] : []);
  // A re-post carries its original's counts (see repost), so a row is judged by itself.
  const media = [...(filter.images ? [] : ["q.photos = 0"]), ...(filter.audio ? [] : ["q.audio = 0"])];
  const where = (conds: string[]) => (conds.length ? `WHERE ${conds.join(" AND ")}` : "");
  let pick: string;
  if (filter.saved && who) {
    const friendsOnly = filter.friends
      ? ["(q.by_name = $1 OR EXISTS (SELECT 1 FROM friends f WHERE f.owner = $1 AND f.friend = q.by_name))"]
      : [];
    pick = `SELECT q.id FROM saves s JOIN posts q ON q.id = s.post
      ${where(["s.by_name = $1", ...after("s.post_at", "s.post"), ...media, ...friendsOnly])}
      ORDER BY s.post_at DESC, s.post DESC LIMIT ${limit}`;
  } else if (filter.friends && who) {
    pick = `SELECT n.id FROM (SELECT $1::text AS name UNION SELECT friend FROM friends WHERE owner = $1) a
      CROSS JOIN LATERAL (
        SELECT q.id, q.at FROM posts q
        ${where(["q.by_name = a.name", ...after("q.at", "q.id"), ...media])}
        ORDER BY q.at DESC, q.id DESC LIMIT ${limit}
      ) n
      ORDER BY n.at DESC, n.id DESC LIMIT ${limit}`;
  } else {
    pick = `SELECT q.id FROM posts q
      ${where([...after("q.at", "q.id"), ...media])}
      ORDER BY q.at DESC, q.id DESC LIMIT ${limit}`;
  }
  const rows = await many<CardRow>(
    `${card(`(${pick}) pick JOIN posts p ON p.id = pick.id`)} ORDER BY p.at DESC, p.id DESC`,
    params,
  );
  const more = rows.length > TIMELINE_PAGE;
  const page = more ? rows.slice(0, TIMELINE_PAGE) : rows;
  const last = page[page.length - 1];
  return {
    posts: page.map(cardFrom),
    next: more && last ? { at: Number(last.at), id: last.id } : null,
  };
}

export async function postsBy(name: string, who: string | null): Promise<Card[]> {
  const rows = await many<CardRow>(`${CARD} WHERE p.by_name = $2 ORDER BY p.at DESC LIMIT 40`, [who, name]);
  return rows.map(cardFrom);
}

export async function unseenNotes(name: string): Promise<NoteRow[]> {
  const rows = await many<{ id: string; from_name: string; post: string; at: number; kind: string }>(
    `SELECT id, from_name, post, at, kind FROM notes
     WHERE to_name = $1 AND seen = false
     ORDER BY at DESC LIMIT 30`,
    [name],
  );
  return rows.map((row) => ({
    id: row.id,
    from: row.from_name,
    post: row.post,
    at: Number(row.at),
    kind: row.kind,
  }));
}

async function note(client: PoolClient, to: string, from: string, post: string, at: number, kind: string) {
  if (to === from) return;
  await client.query(
    `INSERT INTO notes (id, to_name, from_name, post, at, seen, kind) VALUES ($1,$2,$3,$4,$5,false,$6)`,
    [newId(), to, from, post, at, kind],
  );
  // Keep the newest hundred. The cut-off is one index probe, not a scan.
  await client.query(
    `DELETE FROM notes WHERE to_name = $1 AND at < (
       SELECT at FROM notes WHERE to_name = $1 ORDER BY at DESC OFFSET 99 LIMIT 1
     )`,
    [to],
  );
}

export function newId(): string {
  return randomBytes(6).toString("base64url");
}

/** A voice memo, checked by the route: its bytes, container, length, and shape. */
export type Memo = { bytes: Buffer; kind: AudioKind; ms: number; wave: string };

export async function createPost(
  by: string,
  text: string,
  at: number,
  photos: { full: Buffer; small: Buffer }[],
  memo: Memo | null = null,
): Promise<{ wait: number } | Card> {
  // Files first, row second: a row never points at pictures or a memo that
  // are not on disk, and the row lock is not held across disk writes. A post
  // that does not happen takes its files with it.
  const id = newId();
  const unwrite = () => {
    removePostPhotos(id, photos.length);
    if (memo) removePostAudio(id);
  };
  writePostPhotos(id, photos);
  let created: { wait: number } | Card;
  try {
    if (memo) writePostAudio(id, memo);
    created = await insertPost(id, by, text, at, photos.length, memo);
  } catch (err) {
    unwrite();
    throw err;
  }
  if ("wait" in created) unwrite();
  return created;
}

function insertPost(
  id: string,
  by: string,
  text: string,
  at: number,
  photos: number,
  memo: Memo | null,
): Promise<{ wait: number } | Card> {
  return tx(async (client) => {
    const row = await one<{ last_post: number; avatar_rev: number }>(
      "SELECT last_post, avatar_rev FROM users WHERE name = $1 FOR UPDATE",
      [by],
      client,
    );
    if (!row) throw new SocialError(401, "Log in first.");
    const wait = postWait(Number(row.last_post), at);
    if (wait > 0) return { wait };
    await client.query(
      "INSERT INTO posts (id, by_name, text, at, views, photos, audio, wave) VALUES ($1,$2,$3,$4,0,$5,$6,$7)",
      [id, by, text, at, photos, memo?.ms ?? 0, memo?.wave ?? ""],
    );
    await client.query("UPDATE users SET last_post = $2 WHERE name = $1", [by, at]);
    return {
      id, by, text, at, views: 0, comments: 0, saved: false, reposted: false,
      repost: null, repostBy: null, originalRev: 0, avatarRev: row.avatar_rev,
      photos, audio: memo?.ms ?? 0, wave: memo?.wave ?? "",
    };
  });
}

/** `avatarRev` is the author's, which the caller already has. */
export async function addComment(
  by: string,
  avatarRev: number,
  postId: string,
  text: string,
  at: number,
): Promise<CommentRow> {
  return tx(async (client) => {
    const post = await one<{ by_name: string }>("SELECT by_name FROM posts WHERE id = $1 FOR UPDATE", [postId], client);
    if (!post) throw new SocialError(404, "That post is gone.");
    const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM comments WHERE post = $1", [postId], client);
    if ((count?.n ?? 0) >= MAX_COMMENTS) throw new SocialError(400, "This post has enough comments.");
    const id = newId();
    await client.query(
      "INSERT INTO comments (id, post, by_name, text, at) VALUES ($1,$2,$3,$4,$5)",
      [id, postId, by, text, at],
    );
    await note(client, post.by_name, by, postId, at, "comment");
    return { id, by, text, at, avatarRev };
  });
}

/** Save or unsave. Returns whether the post is saved afterwards. No notification. */
export async function toggleSave(by: string, postId: string, at: number): Promise<boolean> {
  return tx(async (client) => {
    const post = await one<{ at: number }>("SELECT at FROM posts WHERE id = $1", [postId], client);
    if (!post) throw new SocialError(404, "That post is gone.");
    const removed = await client.query("DELETE FROM saves WHERE post = $1 AND by_name = $2", [postId, by]);
    if (removed.rowCount) return false;
    // A second toggle racing this one lands here too; either way it is saved.
    await client.query(
      "INSERT INTO saves (post, by_name, at, post_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [postId, by, at, post.at],
    );
    return true;
  });
}

export async function repost(by: string, postId: string, at: number): Promise<void> {
  await tx(async (client) => {
    const post = await one<{ by_name: string; text: string; repost: string | null; photos: number; audio: number }>(
      "SELECT by_name, text, repost, photos, audio FROM posts WHERE id = $1",
      [postId],
      client,
    );
    if (!post) throw new SocialError(404, "That post is gone.");
    if (post.repost) throw new SocialError(400, "This is already a re-post.");
    // The unique index is the check, so two clicks cannot both get through.
    // The counts are copied so the timeline's filters, and their indexes, read
    // one row. The files stay the original's, under its id.
    const added = await client.query(
      `INSERT INTO posts (id, by_name, text, at, views, repost, photos, audio) VALUES ($1,$2,$3,$4,0,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [newId(), by, post.text, at, postId, post.photos, post.audio],
    );
    if (!added.rowCount) throw new SocialError(400, "You already re-posted this.");
    await note(client, post.by_name, by, postId, at, "repost");
  });
}

export async function openPost(id: string, who: string | null): Promise<{ post: Card; comments: CommentRow[] } | null> {
  const updated = await one<{ id: string }>("UPDATE posts SET views = views + 1 WHERE id = $1 RETURNING id", [id]);
  if (!updated) return null;
  const row = await one<CardRow>(`${CARD} WHERE p.id = $2`, [who, id]);
  if (!row) return null;
  const comments = await many<{ id: string; by_name: string; text: string; at: number; avatar_rev: number }>(
    `SELECT c.id, c.by_name, c.text, c.at, u.avatar_rev
     FROM comments c JOIN users u ON u.name = c.by_name
     WHERE c.post = $1 ORDER BY c.at ASC LIMIT $2`,
    [id, MAX_COMMENTS],
  );
  return {
    post: cardFrom(row),
    comments: comments.map((c) => ({
      id: c.id,
      by: c.by_name,
      text: c.text,
      at: Number(c.at),
      avatarRev: c.avatar_rev,
    })),
  };
}

export async function markSeen(name: string): Promise<void> {
  await db().query("UPDATE notes SET seen = true WHERE to_name = $1 AND seen = false", [name]);
}

export async function friendList(name: string): Promise<{ name: string; bio: string; loc: string; avatarRev: number }[]> {
  const rows = await many<{ name: string; bio: string; loc: string; avatar_rev: number }>(
    `SELECT u.name, u.bio, u.loc, u.avatar_rev
     FROM friends f JOIN users u ON u.name = f.friend
     WHERE f.owner = $1 ORDER BY u.name`,
    [name],
  );
  return rows.map((row) => ({ name: row.name, bio: row.bio, loc: row.loc, avatarRev: row.avatar_rev }));
}

/**
 * Usernames starting with `prefix`.
 *
 * The caller is left out. `friend` is whether they are already on that list.
 * The prefix is a name fragment, so `%` and `_` are matched literally.
 */
export async function searchUsers(
  owner: string,
  prefix: string,
): Promise<{ name: string; loc: string; avatarRev: number; friend: boolean }[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await many<{ name: string; loc: string; avatar_rev: number; friend: boolean }>(
    `SELECT u.name, u.loc, u.avatar_rev,
            EXISTS (SELECT 1 FROM friends f WHERE f.owner = $2 AND f.friend = u.name) AS friend
     FROM users u
     WHERE u.name LIKE $1 ESCAPE '\\' AND u.name <> $2
     ORDER BY u.name
     LIMIT 8`,
    [pattern, owner],
  );
  return rows.map((row) => ({
    name: row.name,
    loc: row.loc,
    avatarRev: row.avatar_rev,
    friend: row.friend,
  }));
}

export async function findPeople(
  prefix: string,
): Promise<{ name: string; bio: string; loc: string; avatarRev: number }[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await many<{ name: string; bio: string; loc: string; avatar_rev: number }>(
    `SELECT name, bio, loc, avatar_rev FROM users
     WHERE name LIKE $1 ESCAPE '\\'
     ORDER BY name = $2 DESC, name
     LIMIT 3`,
    [pattern, prefix],
  );
  return rows.map((row) => ({ name: row.name, bio: row.bio, loc: row.loc, avatarRev: row.avatar_rev }));
}

/**
 * Who posted most since `since`, busiest first, then most recent. Re-posts
 * count: they are what a follower would see. A range on posts_at_id, so it
 * reads the window's posts and nothing older.
 */
export async function busiestPosters(
  since: number,
  limit: number,
): Promise<{ name: string; bio: string; avatarRev: number; posts: number }[]> {
  const rows = await many<{ name: string; bio: string; avatar_rev: number; posts: number }>(
    `SELECT u.name, u.bio, u.avatar_rev, n.posts FROM (
       SELECT by_name, count(*)::int AS posts, max(at) AS last FROM posts WHERE at > $1 GROUP BY by_name
     ) n JOIN users u ON u.name = n.by_name
     ORDER BY n.posts DESC, n.last DESC LIMIT $2`,
    [since, limit],
  );
  return rows.map((row) => ({ name: row.name, bio: row.bio, avatarRev: row.avatar_rev, posts: row.posts }));
}

/** The names someone has added. The friends key leads with the owner, so this is one index range. */
export async function friendNames(owner: string): Promise<string[]> {
  const rows = await many<{ friend: string }>("SELECT friend FROM friends WHERE owner = $1", [owner]);
  return rows.map((row) => row.friend);
}

export async function addFriend(owner: string, friend: string): Promise<void> {
  await tx(async (client) => {
    const exists = await one<{ name: string }>("SELECT name FROM users WHERE name = $1", [friend], client);
    if (!exists) throw new SocialError(404, "No such person.");
    const already = await one<{ owner: string }>(
      "SELECT owner FROM friends WHERE owner = $1 AND friend = $2",
      [owner, friend],
      client,
    );
    if (already) return;
    const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM friends WHERE owner = $1", [owner], client);
    if ((count?.n ?? 0) >= 200) throw new SocialError(400, "Friend list is full.");
    await client.query(
      "INSERT INTO friends (owner, friend) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [owner, friend],
    );
  });
}

export async function removeFriend(owner: string, friend: string): Promise<void> {
  await db().query("DELETE FROM friends WHERE owner = $1 AND friend = $2", [owner, friend]);
}

export async function updateProfile(name: string, bio: string | null, loc: string | null): Promise<void> {
  await db().query(
    `UPDATE users SET
       bio = COALESCE($2, bio),
       loc = COALESCE($3, loc)
     WHERE name = $1`,
    [name, bio, loc],
  );
}

export async function setPasskey(
  name: string,
  key: { id: string; cose: string; alg: number; count: number },
): Promise<void> {
  let res;
  try {
    res = await db().query(
      `UPDATE users SET passkey_id = $2, passkey_cose = $3, passkey_alg = $4, passkey_count = $5 WHERE name = $1`,
      [name, key.id, key.cose, key.alg, key.count],
    );
  } catch (err) {
    // users_passkey: that credential already belongs to someone.
    if ((err as { code?: string }).code === "23505") throw new SocialError(409, "That passkey is already in use.");
    throw err;
  }
  if (!res.rowCount) throw new SocialError(401, "Log in first.");
}

export async function setKeyBox(name: string, key: KeyBox): Promise<void> {
  await db().query(`UPDATE users SET key_iv = $2, key_tag = $3, key_ct = $4 WHERE name = $1`, [
    name,
    key.iv,
    key.tag,
    key.ct,
  ]);
}

/** Re-stretch a password and phrase that were sealed at an older cost. */
export async function reseal(
  name: string,
  pass: { salt: string; hash: string },
  box: { salt: string; iv: string; tag: string; ct: string },
): Promise<void> {
  await db().query(
    `UPDATE users SET pass_salt = $2, pass_hash = $3,
       phrase_salt = $4, phrase_iv = $5, phrase_tag = $6, phrase_ct = $7
     WHERE name = $1`,
    [name, pass.salt, pass.hash, box.salt, box.iv, box.tag, box.ct],
  );
}

/**
 * Take an account back with its phrase.
 *
 * New password, the phrase sealed under it, and the passkey removed: whoever
 * recovers may be locking out someone who had the old password and enrolled
 * their own key. Bumping the epoch ends every session signed before now.
 */
export async function recoverAccount(
  address: string,
  pass: { salt: string; hash: string },
  box: { salt: string; iv: string; tag: string; ct: string },
  key: KeyBox,
): Promise<User | null> {
  const row = await one<UserRow>(
    `UPDATE users SET pass_salt = $2, pass_hash = $3,
       phrase_salt = $4, phrase_iv = $5, phrase_tag = $6, phrase_ct = $7,
       passkey_id = NULL, passkey_cose = NULL, passkey_alg = NULL, passkey_count = NULL,
       key_iv = $8, key_tag = $9, key_ct = $10,
       epoch = epoch + 1
     WHERE address = $1
     RETURNING ${USER_COLS}`,
    [address, pass.salt, pass.hash, box.salt, box.iv, box.tag, box.ct, key.iv, key.tag, key.ct],
  );
  return row ? userFrom(row) : null;
}

/** Rejects a counter that did not move forward. A zero counter is stored as-is. */
export async function bumpPasskeyCount(name: string, count: number): Promise<void> {
  const res = await db().query(
    `UPDATE users SET passkey_count = CASE WHEN $2 = 0 THEN passkey_count ELSE $2 END
     WHERE name = $1 AND passkey_id IS NOT NULL
       AND ($2 = 0 OR $2 > COALESCE(passkey_count, 0))`,
    [name, count],
  );
  if (!res.rowCount) throw new SocialError(401, "Passkey was not accepted.");
}

/** Every cookie signed for this account so far stops working. */
export async function endSessions(name: string): Promise<void> {
  await db().query("UPDATE users SET epoch = epoch + 1 WHERE name = $1", [name]);
}

export async function bumpAvatar(name: string): Promise<number> {
  const row = await one<{ avatar_rev: number }>(
    "UPDATE users SET avatar_rev = avatar_rev + 1 WHERE name = $1 RETURNING avatar_rev",
    [name],
  );
  if (!row) throw new SocialError(401, "Log in first.");
  return row.avatar_rev;
}

export interface ChatKey {
  v: number;
  pub: string;
  cred: string;
  iv: string;
  ct: string;
}

export interface Message {
  id: string;
  from: string;
  at: number;
  /** Key versions of sender and recipient: which pair of keys this was sealed between. */
  kf: number;
  kt: number;
  iv: string;
  ct: string;
  photos: number;
}

export interface Chat {
  with: string;
  avatarRev: number;
  at: number;
  unread: number;
  pub: string | null;
  last: Message;
}

type MessageRow = {
  id: string;
  from_name: string;
  at: number;
  kf: number;
  kt: number;
  iv: string;
  ct: string;
  photos: number;
};

const MESSAGE_COLS = "m.id, m.from_name, m.at, m.kf, m.kt, m.iv, m.ct, m.photos";

function messageFrom(row: MessageRow): Message {
  return {
    id: row.id,
    from: row.from_name,
    at: Number(row.at),
    kf: row.kf,
    kt: row.kt,
    iv: row.iv,
    ct: row.ct,
    photos: row.photos,
  };
}

function pairOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The newest key, sealed box included. Only its owner is shown the box. */
export async function chatKey(name: string): Promise<ChatKey | null> {
  return one<ChatKey>(
    "SELECT v, pub, cred, iv, ct FROM chat_keys WHERE name = $1 ORDER BY v DESC LIMIT 1",
    [name],
  );
}

/** Every public key a person has had. Older messages were sealed to older ones. */
export async function chatKeys(name: string): Promise<{ v: number; pub: string }[]> {
  return many<{ v: number; pub: string }>("SELECT v, pub FROM chat_keys WHERE name = $1 ORDER BY v", [name]);
}

export async function addChatKey(
  name: string,
  key: { pub: string; cred: string; iv: string; ct: string },
  at: number,
): Promise<number> {
  return tx(async (client) => {
    // The user row is the lock, so two devices turning Messenger on get two versions, not one.
    const user = await one<{ name: string }>("SELECT name FROM users WHERE name = $1 FOR UPDATE", [name], client);
    if (!user) throw new SocialError(401, "Log in first.");
    const row = await one<{ v: number }>(
      "SELECT COALESCE(max(v), 0) + 1 AS v FROM chat_keys WHERE name = $1",
      [name],
      client,
    );
    const v = row?.v ?? 1;
    await client.query(
      "INSERT INTO chat_keys (name, v, pub, cred, iv, ct, at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [name, v, key.pub, key.cred, key.iv, key.ct, at],
    );
    return v;
  });
}

/**
 * One message, and both sidebars.
 *
 * The versions have to be the newest on both sides: a message sealed to a
 * key its recipient has since replaced could never be opened, so it is
 * refused and the sender fetches the new key. Past MAX_CHAT_KEEP in one
 * conversation the oldest go, with their photos.
 */
export async function sendMessage(
  from: string,
  to: string,
  sealed: { kf: number; kt: number; iv: string; ct: string },
  photos: Buffer[],
  at: number,
): Promise<Message | { stale: true }> {
  const id = newId();
  writeChatPhotos(id, photos);
  let result: { message: Message; dropped: { id: string; photos: number }[] } | { stale: true };
  try {
    result = await tx(async (client) => {
      const keys = await client.query<{ name: string; v: number }>(
        "SELECT name, max(v) AS v FROM chat_keys WHERE name = ANY($1) GROUP BY name",
        [[from, to]],
      );
      const current = new Map(keys.rows.map((row) => [row.name, row.v]));
      if (current.get(from) !== sealed.kf || current.get(to) !== sealed.kt) return { stale: true as const };
      const pair = pairOf(from, to);
      await client.query(
        `INSERT INTO messages (id, pair, from_name, to_name, at, kf, kt, iv, ct, photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, pair, from, to, at, sealed.kf, sealed.kt, sealed.iv, sealed.ct, photos.length],
      );
      await client.query(
        `INSERT INTO chats (owner, peer, at, last, unread) VALUES ($1,$2,$3,$4,0), ($2,$1,$3,$4,1)
         ON CONFLICT (owner, peer) DO UPDATE SET at = EXCLUDED.at, last = EXCLUDED.last,
           unread = chats.unread + EXCLUDED.unread`,
        [from, to, at, id],
      );
      const dropped = await client.query<{ id: string; photos: number }>(
        `DELETE FROM messages WHERE pair = $1 AND (at, id) < (
           SELECT at, id FROM messages WHERE pair = $1 ORDER BY at DESC, id DESC OFFSET $2 LIMIT 1
         ) RETURNING id, photos`,
        [pair, MAX_CHAT_KEEP - 1],
      );
      return {
        message: { id, from, at, kf: sealed.kf, kt: sealed.kt, iv: sealed.iv, ct: sealed.ct, photos: photos.length },
        dropped: dropped.rows,
      };
    });
  } catch (err) {
    removeChatPhotos(id, photos.length);
    throw err;
  }
  if ("stale" in result) {
    removeChatPhotos(id, photos.length);
    return result;
  }
  for (const gone of result.dropped) removeChatPhotos(gone.id, gone.photos);
  return result.message;
}

/**
 * `chats.at` is always its last message's time, so `m.at` stands for both.
 * `pub` is the other person's key that message was sealed with, which is
 * all the sidebar needs to show a preview.
 */
const CHAT_ROW = `
  SELECT c.peer, c.unread, u.avatar_rev, k.pub, ${MESSAGE_COLS}
  FROM chats c
  JOIN users u ON u.name = c.peer
  JOIN messages m ON m.id = c.last
  LEFT JOIN chat_keys k ON k.name = c.peer AND k.v = CASE WHEN m.from_name = c.peer THEN m.kf ELSE m.kt END
`;

type ChatRow = MessageRow & { peer: string; unread: number; avatar_rev: number; pub: string | null };

function chatFrom(row: ChatRow): Chat {
  return {
    with: row.peer,
    avatarRev: row.avatar_rev,
    at: Number(row.at),
    unread: row.unread,
    pub: row.pub,
    last: messageFrom(row),
  };
}

/**
 * The sidebar. `before` pages back through it. `after` is the poll: every
 * conversation that moved at or after that time, which the client merges.
 */
export async function chatList(
  owner: string,
  opts: { before?: { at: number; peer: string } | null; after?: number | null },
): Promise<{ chats: Chat[]; next: { at: number; peer: string } | null }> {
  if (opts.after != null) {
    const rows = await many<ChatRow>(
      `${CHAT_ROW} WHERE c.owner = $1 AND c.at >= $2 ORDER BY c.at DESC, c.peer DESC LIMIT 50`,
      [owner, opts.after],
    );
    return { chats: rows.map(chatFrom), next: null };
  }
  const params: unknown[] = [owner];
  let where = "WHERE c.owner = $1";
  if (opts.before) {
    params.push(opts.before.at, opts.before.peer);
    where += " AND (c.at, c.peer) < ($2::bigint, $3::text)";
  }
  params.push(CHAT_PAGE + 1);
  const rows = await many<ChatRow>(
    `${CHAT_ROW} ${where} ORDER BY c.at DESC, c.peer DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > CHAT_PAGE;
  const page = more ? rows.slice(0, CHAT_PAGE) : rows;
  const last = page[page.length - 1];
  return {
    chats: page.map(chatFrom),
    next: more && last ? { at: Number(last.at), peer: last.peer } : null,
  };
}

/**
 * One conversation, oldest first. With no cursor it is the newest page;
 * `before` is the page above it; `after` is the poll. Reading the newest
 * messages marks the conversation read.
 */
export async function thread(
  owner: string,
  peer: string,
  opts: { before?: { at: number; id: string } | null; after?: { at: number; id: string } | null },
): Promise<{ messages: Message[]; next: { at: number; id: string } | null }> {
  const pair = pairOf(owner, peer);
  let rows: MessageRow[];
  let more = false;
  if (opts.after) {
    rows = await many<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM messages m
       WHERE m.pair = $1 AND (m.at, m.id) > ($2::bigint, $3::text)
       ORDER BY m.at, m.id LIMIT 200`,
      [pair, opts.after.at, opts.after.id],
    );
  } else {
    const params: unknown[] = [pair];
    let where = "WHERE m.pair = $1";
    if (opts.before) {
      params.push(opts.before.at, opts.before.id);
      where += " AND (m.at, m.id) < ($2::bigint, $3::text)";
    }
    params.push(CHAT_PAGE + 1);
    rows = await many<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM messages m ${where}
       ORDER BY m.at DESC, m.id DESC LIMIT $${params.length}`,
      params,
    );
    more = rows.length > CHAT_PAGE;
    if (more) rows = rows.slice(0, CHAT_PAGE);
    rows.reverse();
  }
  if (!opts.before) {
    await db().query("UPDATE chats SET unread = 0 WHERE owner = $1 AND peer = $2 AND unread > 0", [owner, peer]);
  }
  const first = rows[0];
  return {
    messages: rows.map(messageFrom),
    next: more && first ? { at: Number(first.at), id: first.id } : null,
  };
}

/** How many photos a message has, when `viewer` is one of its two people. */
export async function chatPhotoCount(id: string, viewer: string): Promise<number> {
  const row = await one<{ photos: number }>(
    "SELECT photos FROM messages WHERE id = $1 AND (from_name = $2 OR to_name = $2)",
    [id, viewer],
  );
  return row?.photos ?? 0;
}
