import type { KeyBox } from "./auth";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { Pool, type PoolClient, types } from "pg";
import { MAX_COMMENTS, SocialError, postWait } from "./limits";
import { removePostPhotos, writePostPhotos } from "./store";

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
  repost text REFERENCES posts(id)
);
DROP INDEX IF EXISTS posts_at;
DROP INDEX IF EXISTS posts_by;
CREATE INDEX IF NOT EXISTS posts_at_id ON posts (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS posts_by_at ON posts (by_name, at DESC);
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
  PRIMARY KEY (post, by_name)
);
CREATE INDEX IF NOT EXISTS saves_by_at ON saves (by_name, at DESC);
-- Tables from before these columns existed keep their rows and gain them.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS photos integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
-- The phrase sealed a second time, under WALLET_KEY from the environment, so the server can sign.
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_iv text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_tag text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS key_ct text;
ALTER TABLE users DROP COLUMN IF EXISTS prf_salt;
ALTER TABLE users DROP COLUMN IF EXISTS prf_iv;
ALTER TABLE users DROP COLUMN IF EXISTS prf_tag;
ALTER TABLE users DROP COLUMN IF EXISTS prf_ct;
-- /pay and recovery find an account by address, passkey login by credential.
CREATE UNIQUE INDEX IF NOT EXISTS users_address ON users (address);
CREATE UNIQUE INDEX IF NOT EXISTS users_passkey ON users (passkey_id);
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
  key_iv, key_tag, key_ct`;

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
       address, bio, loc, avatar_rev, last_post, created, key_iv, key_tag, key_ct
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING`,
    [
      user.name, user.uid, user.passSalt, user.passHash, user.phraseSalt, user.phraseIv,
      user.phraseTag, user.phraseCt, user.address, user.bio, user.loc, user.avatarRev,
      user.lastPost, user.created, user.keyBox?.iv ?? null, user.keyBox?.tag ?? null,
      user.keyBox?.ct ?? null,
    ],
  );
  return res.rowCount === 1;
}

export async function countUnseen(name: string): Promise<number> {
  const row = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM notes WHERE to_name = $1 AND seen = false",
    [name],
  );
  return row?.n ?? 0;
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
  };
}

/** `$1` is the viewer, or null when nobody is logged in. */
const CARD = `
  SELECT p.id, p.by_name, p.text, p.at, p.views, p.repost,
         CASE WHEN p.repost IS NULL THEN p.photos ELSE COALESCE(op.photos, 0) END AS photos,
         u.avatar_rev,
         op.by_name AS original_by,
         ou.avatar_rev AS original_rev,
         (SELECT count(*)::int FROM comments c WHERE c.post = p.id) AS comments,
         EXISTS (SELECT 1 FROM saves s WHERE s.post = p.id AND s.by_name = $1) AS saved,
         EXISTS (SELECT 1 FROM posts r WHERE r.repost = p.id AND r.by_name = $1) AS reposted
  FROM posts p
  JOIN users u ON u.name = p.by_name
  LEFT JOIN posts op ON op.id = p.repost
  LEFT JOIN users ou ON ou.name = op.by_name
`;

/** One screenful. The next page starts strictly before the last row of this one. */
export const TIMELINE_PAGE = 20;

export async function timeline(
  who: string | null,
  before?: { at: number; id: string } | null,
): Promise<{ posts: Card[]; next: { at: number; id: string } | null }> {
  const params: unknown[] = [who];
  let where = "";
  if (before) {
    params.push(before.at, before.id);
    where = "WHERE (p.at, p.id) < ($2::bigint, $3::text)";
  }
  params.push(TIMELINE_PAGE + 1);
  const rows = await many<CardRow>(
    `${CARD} ${where} ORDER BY p.at DESC, p.id DESC LIMIT $${params.length}`,
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

export async function savedPosts(who: string): Promise<Card[]> {
  const rows = await many<CardRow>(
    `${CARD} JOIN saves sv ON sv.post = p.id AND sv.by_name = $1 ORDER BY sv.at DESC LIMIT 40`,
    [who],
  );
  return rows.map(cardFrom);
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

export async function createPost(
  by: string,
  text: string,
  at: number,
  photos: { full: Buffer; small: Buffer }[],
): Promise<{ wait: number } | Card> {
  // Files first, row second: a row never points at pictures that are not on
  // disk, and the row lock is not held across disk writes. A post that does
  // not happen takes its files with it.
  const id = newId();
  writePostPhotos(id, photos);
  let created: { wait: number } | Card;
  try {
    created = await insertPost(id, by, text, at, photos.length);
  } catch (err) {
    removePostPhotos(id, photos.length);
    throw err;
  }
  if ("wait" in created) removePostPhotos(id, photos.length);
  return created;
}

function insertPost(id: string, by: string, text: string, at: number, photos: number): Promise<{ wait: number } | Card> {
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
      "INSERT INTO posts (id, by_name, text, at, views, photos) VALUES ($1,$2,$3,$4,0,$5)",
      [id, by, text, at, photos],
    );
    await client.query("UPDATE users SET last_post = $2 WHERE name = $1", [by, at]);
    return {
      id, by, text, at, views: 0, comments: 0, saved: false, reposted: false,
      repost: null, repostBy: null, originalRev: 0, avatarRev: row.avatar_rev,
      photos,
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
    const post = await one<{ id: string }>("SELECT id FROM posts WHERE id = $1", [postId], client);
    if (!post) throw new SocialError(404, "That post is gone.");
    const removed = await client.query("DELETE FROM saves WHERE post = $1 AND by_name = $2", [postId, by]);
    if (removed.rowCount) return false;
    // A second toggle racing this one lands here too; either way it is saved.
    await client.query(
      "INSERT INTO saves (post, by_name, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [postId, by, at],
    );
    return true;
  });
}

export async function repost(by: string, postId: string, at: number): Promise<void> {
  await tx(async (client) => {
    const post = await one<{ by_name: string; text: string; repost: string | null }>(
      "SELECT by_name, text, repost FROM posts WHERE id = $1",
      [postId],
      client,
    );
    if (!post) throw new SocialError(404, "That post is gone.");
    if (post.repost) throw new SocialError(400, "This is already a re-post.");
    // The unique index is the check, so two clicks cannot both get through.
    const added = await client.query(
      `INSERT INTO posts (id, by_name, text, at, views, repost) VALUES ($1,$2,$3,$4,0,$5)
       ON CONFLICT DO NOTHING`,
      [newId(), by, post.text, at, postId],
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

export async function bumpAvatar(name: string): Promise<number> {
  const row = await one<{ avatar_rev: number }>(
    "UPDATE users SET avatar_rev = avatar_rev + 1 WHERE name = $1 RETURNING avatar_rev",
    [name],
  );
  if (!row) throw new SocialError(401, "Log in first.");
  return row.avatar_rev;
}
