import type { Request } from "express";
import { readSession } from "./auth";
import { type Ad, addImpressions, liveAds } from "./db";
import { words } from "./limits";

/**
 * The ads the server serves, held in memory so a page never waits on
 * Postgres for one. Search picks from the query; a timeline picks from the
 * latest post of the person reading it that an ad matched (ad_topics). Of
 * the keywords the text contains, the ad bidding most with the budget for an
 * impression wins, and equal bids take turns. Every ad the server puts on a
 * page is an impression, charged there and written to Postgres in batches,
 * except on its owner's own pages: they see it where it runs, for nothing.
 */

type Entry = { ad: Ad; keyword: string; words: string[]; left: number };

/** An ad as a timeline draws it: client/social/main.js, adPost. */
export type SocialAd = Pick<Ad, "id" | "owner" | "ownerRev" | "title" | "cta" | "url"> & {
  host: string;
  /** The banner, desktop and phone copy; empty without one. */
  img: string;
  imgM: string;
};

const RELOAD_MS = 60_000;
const FLUSH_MS = 5_000;

/** Entries by every word of their keyword. */
let index = new Map<string, Entry[]>();
/** Cents and impressions not yet written, by ad and keyword. */
let unwritten = new Map<string, { ad: string; keyword: string; cents: number; shown: number; social: number }>();
const lastShown = new Map<string, number>();
let chain: Promise<void> = Promise.resolve();

const key = (ad: string, keyword: string) => `${ad}\n${keyword}`;

function serial(job: () => Promise<void>): Promise<void> {
  chain = chain.then(job).catch((err: unknown) => console.error("[ads]", err));
  return chain;
}

/** Write what has been charged since the last time. A failed write is kept for the next. */
export function flushAds(): Promise<void> {
  return serial(async () => {
    const batch = unwritten;
    unwritten = new Map();
    try {
      await addImpressions([...batch.values()]);
    } catch (err) {
      for (const [k, row] of batch) {
        const now = unwritten.get(k);
        if (now) {
          now.cents += row.cents;
          now.shown += row.shown;
          now.social += row.social;
        } else unwritten.set(k, row);
      }
      throw err;
    }
  });
}

/** Read the live ads again, after whatever is unwritten has been written. A failure keeps the old index. */
export function reloadAds(): Promise<void> {
  return flushAds().then(() =>
    serial(async () => {
      const next = new Map<string, Entry[]>();
      for (const ad of await liveAds()) {
        for (const k of ad.keywords) {
          const entry = {
            ad,
            keyword: k.keyword,
            words: k.keyword.split(" "),
            left: k.budget - k.spent - (unwritten.get(key(ad.id, k.keyword))?.cents ?? 0),
          };
          for (const word of new Set(entry.words)) next.set(word, [...(next.get(word) ?? []), entry]);
        }
      }
      index = next;
    }),
  );
}

let started = false;

export function startAds(): void {
  if (started) return;
  started = true;
  reloadAds();
  setInterval(reloadAds, RELOAD_MS).unref();
  setInterval(flushAds, FLUSH_MS).unref();
}

/** The ad for this text on this kind of device. Reads memory only. */
export function pickAd(text: string, mobile: boolean): Entry | null {
  const asked = new Set(words(text));
  let best: Entry | null = null;
  for (const word of asked) {
    for (const entry of index.get(word) ?? []) {
      const { ad } = entry;
      if (entry.left < ad.bid) continue;
      if (ad.devices !== "all" && (ad.devices === "mobile") !== mobile) continue;
      if (!entry.words.every((w) => asked.has(w))) continue;
      if (!best || ahead(entry, best)) best = entry;
    }
  }
  return best;
}

function ahead(a: Entry, b: Entry): boolean {
  if (a.ad.bid !== b.ad.bid) return a.ad.bid > b.ad.bid;
  const at = lastShown.get(a.ad.id) ?? 0;
  const bt = lastShown.get(b.ad.id) ?? 0;
  if (at !== bt) return at < bt;
  return a.left > b.left;
}

/** Whether some ad, on some device, would run for this text. */
export function matchesAd(text: string): boolean {
  return !!(pickAd(text, false) || pickAd(text, true));
}

/** Put on `viewer`'s page: one impression, at the ad's bid. Its owner looking costs nothing and counts for nothing. */
function charge(entry: Entry, social: boolean, viewer: string): void {
  if (viewer && viewer === entry.ad.owner) return;
  lastShown.set(entry.ad.id, Date.now());
  entry.left -= entry.ad.bid;
  const k = key(entry.ad.id, entry.keyword);
  const row = unwritten.get(k) ?? { ad: entry.ad.id, keyword: entry.keyword, cents: 0, shown: 0, social: 0 };
  row.cents += entry.ad.bid;
  row.shown += 1;
  if (social) row.social += 1;
  unwritten.set(k, row);
}

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|curl|wget|python|httpclient|headless/i;

function isBot(req: Request): boolean {
  const agent = req.get("user-agent") || "";
  return !agent || BOT.test(agent);
}

/** Chromium says so in a client hint; everything else in its user agent. */
export function isMobile(req: Request): boolean {
  return req.get("sec-ch-ua-mobile") === "?1" || /Mobi|Android|iPhone|iPod/i.test(req.get("user-agent") || "");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\$/g, "&#36;");
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * The ad on search, as markup: words only, the banner is for timelines. Kept
 * in step with the search preview in client/ads/main.js; its rules are
 * client/ad.css. Every value is escaped; the URL passed adUrl.
 */
export function adMarkup(ad: Pick<Ad, "cta" | "title" | "body" | "url">): string {
  return (
    `<aside id="ad" aria-label="Sponsored"><a class="ad" href="${esc(ad.url)}" target="_blank" rel="noopener sponsored">` +
    `<span class="sp-by"><b>Sponsored</b> · ${esc(hostOf(ad.url))}</span>` +
    `<h3>${esc(ad.title)}</h3><span class="sp-tx">${esc(ad.body)}</span>` +
    `<span class="sp-go">${esc(ad.cta)}</span></a></aside>`
  );
}

/** Who is signed in, from the cookie alone: search asks nothing of Postgres, and fails on nothing here. */
function viewerOf(req: Request): string {
  try {
    return readSession(req)?.name ?? "";
  } catch {
    return "";
  }
}

/** The ad a results page for `query` carries, charged to its keyword, or "". Crawlers get none. */
export function adFor(req: Request, query: string): string {
  if (isBot(req)) return "";
  const entry = pickAd(query, isMobile(req));
  if (!entry) return "";
  charge(entry, false, viewerOf(req));
  return adMarkup(entry.ad);
}

/** The ad a timeline carries for someone whose posts are about `topic`, charged, or null. */
export function socialAdFor(req: Request, topic: string, viewer: string): SocialAd | null {
  if (!topic || isBot(req)) return null;
  const entry = pickAd(topic, isMobile(req));
  if (!entry) return null;
  charge(entry, true, viewer);
  const { ad } = entry;
  const img = ad.banner ? `/social/b/${ad.id}?v=${ad.banner}` : "";
  return {
    id: ad.id,
    owner: ad.owner,
    ownerRev: ad.ownerRev,
    title: ad.title,
    cta: ad.cta,
    url: ad.url,
    host: hostOf(ad.url),
    img,
    imgM: img && `${img}&m=1`,
  };
}
