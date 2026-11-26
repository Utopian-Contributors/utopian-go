import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import {
  NEWS_API_BASE,
  NEWS_API_KEY,
  NEWS_CARDS,
  NEWS_FILE,
  NEWS_IMG_DIR,
  NEWS_IMG_WIDTH,
  NEWS_PER_TOPIC,
  NEWS_PICK_DAILY,
  NEWS_REFRESH_MS,
  NEWS_SHOWN,
  NEWS_TOPICS,
} from "../config";
import { download, raster } from "./tokens/icons";
import { change } from "./tokens/ticker";

/**
 * The home page's news cards, rendered server-side into index.html as the
 * watchlist is (src/lib/tokens/ticker.ts), so they paint with the page and
 * cost it no request.
 *
 * Four cards: the topics the "nw" cookie names first, as the home news menu
 * (client/watch/news.js) writes it, then the busiest topics on 40 Newsroom
 * for the places left. Without the cookie that is the four busiest: Auto.
 *
 * Every card is a topic's, kept in one pool by topic, whoever's page shows
 * it. Topics are free and articles are quota, so a card is asked for
 * articles only when its topic's newest story is newer than the card's, and
 * then only for what came out since (`since`): a quiet topic costs nothing, a
 * busy one at most NEWS_PER_TOPIC. The busiest are brought up to date every
 * NEWS_REFRESH_MS; a watched one when a page shows it and it is that old,
 * from a daily allowance (NEWS_PICK_DAILY), past which it shows as it stood.
 * Only the topics the menu lists (the NEWS_TOPICS busiest), or ones already
 * in the pool, can be watched, so a cookie cannot spend articles on anything.
 *
 * Headlines link to /news/go/<id>, which redirects to the story: a publisher's
 * URL is mostly incompressible, and eight of them would not fit the page's
 * first flight. The card's photo, the freshest story's that has one, is
 * fetched once, shrunk and served from here (/news/<id>.webp): a fraction of
 * the publisher's bytes, and a visitor's address never reaches a news CDN off
 * the home page.
 *
 * The key goes in the Authorization header and nowhere else: never a URL, a
 * log line or the cache file.
 */

/** The cookie the menu keeps the watched topics in: their slugs, joined by dots. None, or empty, is Auto. */
export const NEWS_COOKIE = "nw";

interface Story {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface Card {
  topic: string;
  name: string;
  /** The topic's newest story when it was last asked, so an unchanged topic is not asked again. */
  topicAt: string;
  /** The topic's token or stock's 24h change, in percent. */
  change: number | null;
  /** Newest first, NEWS_SHOWN at most. */
  stories: Story[];
  /** The id of the story whose photo is the card's ground. */
  photo: string | null;
  /** When the card was last brought up to date, asked or found unchanged. */
  at: number;
  /** When a page last showed it as a watched topic: a card no one watches and not among the busiest is let go. */
  seen: number;
}

interface Saved {
  at: number;
  cards: Card[];
  /** The busiest topics' cards, by slug, busiest first: Auto. */
  auto?: string[];
  /** The topics the menu offers, as last listed. */
  topics?: Topic[];
  /** Articles spent on watched topics today (UTC). */
  spent?: { day: string; n: number };
  /** Where recent /news/go/ ids lead, so a page rendered before a refresh still links. */
  links: [string, string][];
}

interface Topic {
  slug: string;
  name: string;
  kind?: string;
  articles24h?: number;
  lastArticleAt: string | null;
  asset: { change24hPct: number | null } | null;
}

/** A topic as the menu lists it. */
export interface NewsTopic {
  slug: string;
  name: string;
  /** country, topic, stock, crypto… as 40 Newsroom files it. */
  kind: string;
  /** Stories in the last day. */
  n: number;
}

interface Article {
  id: string;
  title: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string;
  source: { name: string } | null;
}

const ID = /^[a-z0-9]{10,40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every card's bytes ride in the home page's first flight (NEWS_RESERVE in
 * build-client.mjs). Two lines of a half-width card show about 45
 * characters, so a headline is clipped well past that.
 */
const MAX_TITLE = 100;

/** Links kept for pages rendered before the cards moved on: a few refreshes' worth, and the watched cards'. */
const MAX_LINKS = 400;

/** A watched card no page has shown for this long is let go, its photo with it. */
const FORGET_MS = 14 * 24 * 60 * 60_000;

/** How long a page waits for a watched topic's first card before going without it. */
const FIRST_WAIT_MS = 1500;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1).replace(/\s+\S*$/, "")}…`;
}

/** Every card there is, by topic. */
let pool = new Map<string, Card>();
/** The busiest topics', busiest first. */
let auto: string[] = [];
/** The topics the menu offers, busiest first, and by slug. */
let topics: Topic[] = [];
let topicBy = new Map<string, Topic>();
let spent = { day: "", n: 0 };
let links = new Map<string, string>();
let fetchedAt = 0;
let running = false;
/** Set by a 401: a wrong key stays wrong until someone changes it. */
let refused = false;
/** Watched topics being brought up to date now, so two pages at once ask once. */
const asking = new Map<string, Promise<void>>();

class NewsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** The API's calls, one after another, as it asks, whoever makes them. */
let line: Promise<unknown> = Promise.resolve();

function api<T>(p: string): Promise<T> {
  const call = async (): Promise<T> => {
    if (refused) throw new NewsError(401, "refused");
    const res = await fetch(NEWS_API_BASE + p, {
      headers: { Authorization: `Bearer ${NEWS_API_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let code = "error";
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
      } catch {
        // Not JSON: the status says enough.
      }
      if (res.status === 401 && !refused) {
        refused = true;
        console.warn("[news] 40 Newsroom refused the key (401): check 40_NEWS_API_KEY. Not trying again until a restart.");
      }
      throw new NewsError(res.status, code);
    }
    return (await res.json()) as T;
  };
  const p2 = line.then(call, call);
  line = p2.catch(() => {});
  return p2;
}

function photoFile(id: string): string {
  return path.join(NEWS_IMG_DIR, `${id}.webp`);
}

/** The photo for a card, served by /news/:file. Null for an id no card shows. */
export function newsPhoto(file: string): string | null {
  const id = file.replace(/\.webp$/, "");
  if (!ID.test(id)) return null;
  for (const c of pool.values()) if (c.photo === id) return photoFile(id);
  return null;
}

/** Where a headline's /news/go/:id leads; null for an id never shown. */
export function newsLink(id: string): string | null {
  return ID.test(id) ? (links.get(id) ?? null) : null;
}

async function savePhoto(id: string, url: string): Promise<boolean> {
  try {
    const raw = await download(url);
    if (!raster(raw)) return false;
    const out = await sharp(raw, { limitInputPixels: 6144 * 6144, animated: false })
      .timeout({ seconds: 5 })
      .resize({ width: NEWS_IMG_WIDTH, height: Math.round(NEWS_IMG_WIDTH * 0.75), fit: "cover", withoutEnlargement: true })
      .webp({ quality: 62, effort: 5 })
      .toBuffer();
    const file = photoFile(id);
    writeFileSync(`${file}.tmp`, out);
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A topic's card brought up to date: what came out since its newest story,
 * on top of the stories it held, a story another card shows left out. The
 * photo moves to the freshest new story that has one; without one it stays.
 * Also what it cost, in articles.
 */
async function freshen(t: Topic, old: Card | undefined, taken: Set<string>): Promise<{ card: Card | null; cost: number }> {
  const held = (old?.stories ?? []).filter((s) => !taken.has(s.id));
  const since = held[0]?.publishedAt;
  const q =
    `/v1/articles?topic=${encodeURIComponent(t.slug)}&limit=${NEWS_PER_TOPIC}` +
    (since ? `&since=${encodeURIComponent(since)}` : "");
  const { data } = await api<{ data: Article[] }>(q);
  const have = new Set(held.map((s) => s.id));
  const fresh = data.filter((a) => ID.test(a.id) && !have.has(a.id) && !taken.has(a.id) && /^https?:\/\//.test(a.url) && a.title);
  const stories = [
    ...fresh.map((a) => ({ id: a.id, title: clip(a.title), url: a.url, source: a.source?.name ?? "", publishedAt: a.publishedAt })),
    ...held,
  ]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, NEWS_SHOWN);
  if (!stories.length) return { card: null, cost: data.length };

  let photo = old?.photo && stories.some((s) => s.id === old.photo) ? old.photo : null;
  for (const a of fresh) {
    if (!a.imageUrl || !stories.some((s) => s.id === a.id)) continue;
    if (await savePhoto(a.id, a.imageUrl)) {
      photo = a.id;
      break;
    }
  }
  const card: Card = {
    topic: t.slug,
    name: t.name,
    topicAt: t.lastArticleAt ?? old?.topicAt ?? "",
    change: t.asset ? (t.asset.change24hPct ?? null) : (old?.change ?? null),
    stories,
    photo,
    at: Date.now(),
    seen: old?.seen ?? 0,
  };
  return { card, cost: data.length };
}

/** A card's headlines made reachable by /news/go/, newest kept. */
function link(card: Card): void {
  for (const s of card.stories) {
    links.delete(s.id);
    links.set(s.id, s.url);
  }
  if (links.size > MAX_LINKS) links = new Map([...links].slice(-MAX_LINKS));
}

/** The topic list, the busiest topics' cards brought up to date, and the cards no one needs let go. */
async function refresh(): Promise<void> {
  if (running || refused || !NEWS_API_KEY) return;
  running = true;
  try {
    const { data } = await api<{ data: Topic[] }>(`/v1/topics?limit=${NEWS_TOPICS}`);
    const listed = data.filter((t) => SLUG.test(t.slug) && t.name);
    const next: string[] = [];
    const taken = new Set<string>();
    // One after another; a topic that yields nothing gives its place to the next.
    for (const t of listed) {
      if (next.length >= NEWS_CARDS) break;
      const old = pool.get(t.slug);
      let card: Card | null;
      if (old && old.topicAt === (t.lastArticleAt ?? "") && !old.stories.some((s) => taken.has(s.id))) {
        // Nothing newer: the same stories, the asset's move brought up to date, for free.
        card = { ...old, name: t.name, change: t.asset?.change24hPct ?? null, at: Date.now() };
      } else {
        card = (await freshen(t, old, taken)).card;
      }
      if (!card) continue;
      for (const s of card.stories) taken.add(s.id);
      pool.set(t.slug, card);
      link(card);
      next.push(t.slug);
    }
    topics = listed;
    topicBy = new Map(listed.map((t) => [t.slug, t]));
    // Every other card's name and asset's move, for free, from the same list.
    for (const c of pool.values()) {
      const t = topicBy.get(c.topic);
      if (t) {
        c.name = t.name;
        if (t.asset) c.change = t.asset.change24hPct ?? null;
      }
    }
    if (next.length) {
      auto = next;
      fetchedAt = Date.now();
    }
    forget();
    save();
  } catch (err) {
    if (!(err instanceof NewsError && err.status === 401)) {
      console.warn(`[news] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    running = false;
  }
}

/** Lets go of the cards neither among the busiest nor watched lately, and the photos no card shows. */
function forget(): void {
  const now = Date.now();
  for (const [slug, c] of pool) if (!auto.includes(slug) && now - c.seen > FORGET_MS) pool.delete(slug);
  const keep = new Set([...pool.values()].flatMap((c) => (c.photo ? [`${c.photo}.webp`] : [])));
  try {
    for (const name of readdirSync(NEWS_IMG_DIR)) if (!keep.has(name)) unlinkSync(path.join(NEWS_IMG_DIR, name));
  } catch {
    // No directory yet.
  }
}

function save(): void {
  try {
    mkdirSync(path.dirname(NEWS_FILE), { recursive: true });
    const body: Saved = { at: fetchedAt, cards: [...pool.values()], auto, topics, spent, links: [...links] };
    writeFileSync(`${NEWS_FILE}.tmp`, JSON.stringify(body));
    renameSync(`${NEWS_FILE}.tmp`, NEWS_FILE);
  } catch (err) {
    console.warn(`[news] could not save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Today, in UTC, for the watched topics' allowance. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A watched topic's card brought up to date, if the day's allowance has
 * room for what it could cost. A topic that has fallen off the list is asked
 * all the same, by what its card knows: since its newest story, so a quiet
 * one costs nothing.
 */
function ask(slug: string): Promise<void> {
  const held = asking.get(slug);
  if (held) return held;
  const t = topicBy.get(slug);
  const old = pool.get(slug);
  if (!NEWS_API_KEY || refused || (!t && !old)) return Promise.resolve();
  if (spent.day !== today()) spent = { day: today(), n: 0 };
  if (spent.n + NEWS_PER_TOPIC > NEWS_PICK_DAILY) return Promise.resolve();
  const topic: Topic = t ?? { slug, name: old?.name ?? slug, lastArticleAt: null, asset: null };
  const task = freshen(topic, old, new Set())
    .then(({ card, cost }) => {
      spent.n += cost;
      const now = Date.now();
      if (card) {
        card.seen = Math.max(card.seen, now);
        pool.set(slug, card);
        link(card);
      } else if (old) {
        // Nothing new and nothing held: asked, so not again for a while.
        old.at = now;
      }
      save();
    })
    .catch((err) => {
      if (!(err instanceof NewsError && err.status === 401)) {
        console.warn(`[news] ${slug} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
    .finally(() => asking.delete(slug));
  asking.set(slug, task);
  return task;
}

/**
 * The watched topics a cookie names: well-formed slugs, once each, at most
 * four, in its order, and only ones the menu offers or the pool holds.
 * Empty for Auto.
 */
export function newsPicks(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(".").filter((s) => SLUG.test(s) && (topicBy.has(s) || pool.has(s))))].slice(0, NEWS_CARDS);
}

/**
 * The watched topics' cards, as up to date as they should be. Any that is
 * NEWS_REFRESH_MS old and whose topic has news since is asked again, behind
 * the page; one there is no card for yet is waited for, briefly, so a topic
 * just chosen shows on the page that chose it.
 */
export async function newsReady(picks: string[]): Promise<void> {
  const now = Date.now();
  const first: Promise<void>[] = [];
  for (const slug of picks) {
    const c = pool.get(slug);
    if (c) {
      c.seen = now;
      const t = topicBy.get(slug);
      if (now - c.at < NEWS_REFRESH_MS || (t && c.topicAt === (t.lastArticleAt ?? ""))) continue;
      void ask(slug);
    } else {
      first.push(ask(slug));
    }
  }
  if (first.length) await Promise.race([Promise.all(first), new Promise((r) => setTimeout(r, FIRST_WAIT_MS).unref())]);
}

/**
 * The topics the menu offers, busiest first, after the watched ones that
 * have fallen off the list, so they can still be let go.
 */
export function newsTopics(picks: string[]): NewsTopic[] {
  const gone: Topic[] = picks
    .filter((s) => !topicBy.has(s) && pool.has(s))
    .map((s) => ({ slug: s, name: pool.get(s)?.name ?? s, lastArticleAt: null, asset: null }));
  return [...gone, ...topics].map((t) => ({ slug: t.slug, name: t.name, kind: t.kind || "topic", n: t.articles24h ?? 0 }));
}

/** Restore the last cards, refresh now if they are due, and then every NEWS_REFRESH_MS. */
export function startNews(): void {
  mkdirSync(NEWS_IMG_DIR, { recursive: true });
  try {
    const saved = JSON.parse(readFileSync(NEWS_FILE, "utf8")) as Saved;
    // A file from before cards held stories reads as none, and is refreshed now.
    if (Array.isArray(saved.cards) && saved.cards.every((c) => Array.isArray(c.stories))) {
      fetchedAt = saved.at || 0;
      // A file from before the pool held only the busiest, and no times.
      pool = new Map(saved.cards.map((c) => [c.topic, { ...c, at: c.at ?? fetchedAt, seen: c.seen ?? 0 }]));
      auto = Array.isArray(saved.auto) ? saved.auto.filter((s) => pool.has(s)) : saved.cards.map((c) => c.topic);
      topics = Array.isArray(saved.topics) ? saved.topics : [];
      topicBy = new Map(topics.map((t) => [t.slug, t]));
      if (saved.spent && typeof saved.spent.n === "number") spent = saved.spent;
      links = new Map(Array.isArray(saved.links) ? saved.links : []);
    }
  } catch {
    // First run.
  }
  if (!NEWS_API_KEY) {
    console.log("Set 40_NEWS_API_KEY to show news on the home page.");
    return;
  }
  // Due now too when the menu has never been listed, so it has topics to offer.
  const due = topics.length ? Math.max(0, fetchedAt + NEWS_REFRESH_MS - Date.now()) : 0;
  setTimeout(() => {
    void refresh();
    setInterval(() => void refresh(), NEWS_REFRESH_MS).unref();
  }, due).unref();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** How long ago, as iOS writes it on a card: 5m, 3h, 2d. Five-minute steps, so the page's ETag holds a while. */
function ago(iso: string, now: number): string {
  const min = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return "";
  if (min < 5) return "Now";
  if (min < 60) return `${Math.floor(min / 5) * 5}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

/** Five grounds for a card with no photo, one per topic, so the same topic keeps its colour. */
function artOf(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 5;
}

/**
 * The cards, for the #hm-nw slot: the watched topics', in their order, then
 * the busiest topics' for the places left. Each has the topic and its asset's
 * move at the top, as the watchlist's tiles carry their symbol, and its
 * freshest headlines stacked at the foot, each a link out with its source and
 * age, over the freshest photo. A story an earlier card shows is left out of
 * a later one, unless it is all that card has. Empty with no cards, which
 * hides the section (app.css). Headlines and names are the publishers' and
 * escaped; an id is checked against ID when fetched.
 */
export function renderHomeNews(picks: string[] = [], now = Date.now()): string {
  const shown: Card[] = [];
  for (const s of [...picks, ...auto.filter((a) => !picks.includes(a))]) {
    const c = pool.get(s);
    if (c && shown.length < NEWS_CARDS) shown.push(c);
  }
  const used = new Set<string>();
  return shown
    .map((c) => {
      let stories = c.stories.filter((s) => !used.has(s.id));
      if (!stories.length) stories = c.stories.slice(0, 1);
      for (const s of stories) used.add(s.id);
      const delta =
        c.change != null && Number.isFinite(c.change)
          ? `<i class="${c.change > 0 ? "up" : c.change < 0 ? "dn" : ""}">${change(c.change)}</i>`
          : "";
      const rows = stories
        .map((s) => {
          const when = ago(s.publishedAt, now);
          return (
            `<li><a href="/news/go/${s.id}" target="_blank" rel="noopener noreferrer">` +
            `<b>${esc(s.title)}</b><span>${esc(s.source)}${s.source && when ? " · " : ""}${when}</span></a></li>`
          );
        })
        .join("");
      return (
        `<div class="hm-n"${c.photo ? "" : ` data-art="${artOf(c.topic)}"`}>` +
        (c.photo ? `<img src="/news/${c.photo}.webp" alt="" loading="lazy" decoding="async">` : "") +
        `<h3>${esc(c.name)}${delta}</h3><ul>${rows}</ul></div>`
      );
    })
    .join("");
}
