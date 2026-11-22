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
  NEWS_REFRESH_MS,
  NEWS_SHOWN,
} from "../config";
import { download, raster } from "./tokens/icons";
import { change } from "./tokens/ticker";

/**
 * The home page's news cards: the four busiest topics on 40 Newsroom, each
 * with the stories that have freshly come up in it, rendered server-side into
 * index.html as the watchlist is (src/lib/tokens/ticker.ts), so they paint
 * with the page and cost it no request.
 *
 * Topics are free and articles are quota, so a refresh asks for the topics,
 * and asks a topic for articles only when its newest story is newer than the
 * card's, and then only for what came out since (`since`): a quiet topic
 * costs nothing, a busy one at most NEWS_PER_TOPIC.
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
}

interface Saved {
  at: number;
  cards: Card[];
  /** Where recent /news/go/ ids lead, so a page rendered before a refresh still links. */
  links: [string, string][];
}

interface Topic {
  slug: string;
  name: string;
  lastArticleAt: string | null;
  asset: { change24hPct: number | null } | null;
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

/**
 * Every card's bytes ride in the home page's first flight (NEWS_RESERVE in
 * build-client.mjs). Two lines of a half-width card show about 45
 * characters, so a headline is clipped well past that.
 */
const MAX_TITLE = 100;

/** Links kept for pages rendered before the cards moved on: a few refreshes' worth. */
const MAX_LINKS = 120;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1).replace(/\s+\S*$/, "")}…`;
}

let cards: Card[] = [];
let links = new Map<string, string>();
let fetchedAt = 0;
let running = false;
/** Set by a 401: a wrong key stays wrong until someone changes it. */
let refused = false;

class NewsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function api<T>(p: string): Promise<T> {
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
    throw new NewsError(res.status, code);
  }
  return (await res.json()) as T;
}

function photoFile(id: string): string {
  return path.join(NEWS_IMG_DIR, `${id}.webp`);
}

/** The photo for a card, served by /news/:file. Null for an id no card shows. */
export function newsPhoto(file: string): string | null {
  const id = file.replace(/\.webp$/, "");
  return ID.test(id) && cards.some((c) => c.photo === id) ? photoFile(id) : null;
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
 */
async function freshen(t: Topic, old: Card | undefined, taken: Set<string>): Promise<Card | null> {
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
  if (!stories.length) return null;

  let photo = old?.photo && stories.some((s) => s.id === old.photo) ? old.photo : null;
  for (const a of fresh) {
    if (!a.imageUrl || !stories.some((s) => s.id === a.id)) continue;
    if (await savePhoto(a.id, a.imageUrl)) {
      photo = a.id;
      break;
    }
  }
  return { topic: t.slug, name: t.name, topicAt: t.lastArticleAt ?? "", change: t.asset?.change24hPct ?? null, stories, photo };
}

async function refresh(): Promise<void> {
  if (running || refused || !NEWS_API_KEY) return;
  running = true;
  try {
    const { data: topics } = await api<{ data: Topic[] }>(`/v1/topics?limit=${NEWS_CARDS * 3}`);
    const held = new Map(cards.map((c) => [c.topic, c]));
    const next: Card[] = [];
    const taken = new Set<string>();
    // One after another, as the API asks; a topic that yields nothing gives its place to the next.
    for (const t of topics) {
      if (next.length >= NEWS_CARDS) break;
      const old = held.get(t.slug);
      let card: Card | null;
      if (old && old.topicAt === (t.lastArticleAt ?? "") && !old.stories.some((s) => taken.has(s.id))) {
        // Nothing newer: the same stories, the asset's move brought up to date, for free.
        card = { ...old, name: t.name, change: t.asset?.change24hPct ?? null };
      } else {
        card = await freshen(t, old, taken);
      }
      if (!card) continue;
      for (const s of card.stories) taken.add(s.id);
      next.push(card);
    }
    if (next.length) {
      cards = next;
      for (const c of cards) for (const s of c.stories) {
        links.delete(s.id);
        links.set(s.id, s.url);
      }
      links = new Map([...links].slice(-MAX_LINKS));
      fetchedAt = Date.now();
      save();
      prunePhotos();
    }
  } catch (err) {
    if (err instanceof NewsError && err.status === 401) {
      refused = true;
      console.warn("[news] 40 Newsroom refused the key (401): check 40_NEWS_API_KEY. Not trying again until a restart.");
    } else {
      console.warn(`[news] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    running = false;
  }
}

function save(): void {
  try {
    mkdirSync(path.dirname(NEWS_FILE), { recursive: true });
    const body: Saved = { at: fetchedAt, cards, links: [...links] };
    writeFileSync(`${NEWS_FILE}.tmp`, JSON.stringify(body));
    renameSync(`${NEWS_FILE}.tmp`, NEWS_FILE);
  } catch (err) {
    console.warn(`[news] could not save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function prunePhotos(): void {
  const keep = new Set(cards.flatMap((c) => (c.photo ? [`${c.photo}.webp`] : [])));
  try {
    for (const name of readdirSync(NEWS_IMG_DIR)) if (!keep.has(name)) unlinkSync(path.join(NEWS_IMG_DIR, name));
  } catch {
    // No directory yet.
  }
}

/** Restore the last cards, refresh now if they are due, and then every NEWS_REFRESH_MS. */
export function startNews(): void {
  mkdirSync(NEWS_IMG_DIR, { recursive: true });
  try {
    const saved = JSON.parse(readFileSync(NEWS_FILE, "utf8")) as Saved;
    // A file from before cards held stories reads as none, and is refreshed now.
    if (Array.isArray(saved.cards) && saved.cards.every((c) => Array.isArray(c.stories))) {
      cards = saved.cards;
      fetchedAt = saved.at || 0;
      links = new Map(Array.isArray(saved.links) ? saved.links : []);
    }
  } catch {
    // First run.
  }
  if (!NEWS_API_KEY) {
    console.log("Set 40_NEWS_API_KEY to show news on the home page.");
    return;
  }
  const due = Math.max(0, fetchedAt + NEWS_REFRESH_MS - Date.now());
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
 * The cards, for the #hm-nw slot: the topic and its asset's move at the top,
 * as the watchlist's tiles carry their symbol, and its freshest headlines
 * stacked at the foot, each a link out with its source and age, over the
 * freshest photo. Empty with no cards, which hides the section (app.css).
 * Headlines and names are the publishers' and escaped; an id is checked
 * against ID when fetched.
 */
export function renderHomeNews(now = Date.now()): string {
  return cards
    .map((c) => {
      const delta =
        c.change != null && Number.isFinite(c.change)
          ? `<i class="${c.change > 0 ? "up" : c.change < 0 ? "dn" : ""}">${change(c.change)}</i>`
          : "";
      const rows = c.stories
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
