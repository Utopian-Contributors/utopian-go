import { createHmac, randomBytes } from "crypto";
import type { Request } from "express";
import { readSession } from "./auth";
import { type Ad, addImpressions, liveAds } from "./db";
import { words } from "./limits";

/**
 * The ads the server serves, held in memory so a page never waits on
 * Postgres for one. Search picks from the query; a timeline picks from the
 * latest post of the person reading it that an ad matched (ad_topics). Of
 * the keywords the text contains, the ad bidding most with the budget for an
 * impression wins, and equal bids take turns. An ad's first showing to a
 * viewer in half an hour is an impression (firstLook), charged there and
 * written to Postgres in batches; showing it again to them is free, and so is
 * every showing on its owner's own pages.
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

/**
 * One impression per viewer per ad per SEEN_MS, however often the page loads.
 *
 * Without this every render was a charge, so anyone could burn a rival's
 * budget with a loop of requests, or with an <img> pointed at a results URL on
 * a busy page. A viewer is their account when signed in, else a fingerprint:
 * the network they come from, with the browser headers that tell people on one
 * network apart. Those headers are the caller's to vary, so one network is
 * charged at most PER_NETWORK distinct viewers per ad in the same span:
 * a household or an office, not a script cycling user agents.
 *
 * Nothing here is written down or sent anywhere. The fingerprint is an HMAC
 * under a salt that lives in this process and is replaced every SALT_MS, and
 * entries go once SEEN_MS has passed, so no viewer can be followed across
 * days, and a restart forgets everyone.
 */
const SEEN_MS = 30 * 60_000;
const PER_NETWORK = 5;
const SALT_MS = 24 * 3600_000;
/** Remembered viewers, at most. Past this nobody new is charged until entries expire: an advertiser is never billed for a flood. */
const MAX_SEEN = 100_000;

let salt = randomBytes(32);
let saltAt = Date.now();
/** `viewer\nad` → when that look stops counting as the same impression. */
const seen = new Map<string, number>();
/** `network\nad` → how many viewers were charged from it, and until when that count holds. */
const networks = new Map<string, { count: number; until: number }>();
let sweptAt = 0;

/** The network part of an address: all of an IPv4 one, the first 48 bits of an IPv6 one, where one site's addresses all start alike. */
function network(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  return ip.toLowerCase().split(":").slice(0, 3).join(":");
}

function viewerKey(req: Request, viewer: string, net: string): string {
  if (viewer) return `u:${viewer}`;
  const now = Date.now();
  if (now - saltAt > SALT_MS) {
    salt = randomBytes(32);
    saltAt = now;
  }
  const parts = [net, req.get("user-agent"), req.get("accept-language"), req.get("sec-ch-ua"), req.get("sec-ch-ua-platform")];
  return createHmac("sha256", salt).update(parts.map((p) => p ?? "").join("\n")).digest("base64url");
}

function sweep(now: number): void {
  if (now - sweptAt < 60_000 && seen.size < MAX_SEEN) return;
  sweptAt = now;
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
  for (const [k, held] of networks) if (held.until <= now) networks.delete(k);
}

/** Whether this look at `ad` is a new impression, and if so, remembered as one. */
function firstLook(req: Request, ad: string, viewer: string): boolean {
  const now = Date.now();
  sweep(now);
  const net = network(req.ip || req.socket?.remoteAddress || "");
  const look = `${viewerKey(req, viewer, net)}\n${ad}`;
  if ((seen.get(look) ?? 0) > now) return false;
  const from = `${net}\n${ad}`;
  const held = networks.get(from);
  const count = held && held.until > now ? held.count : 0;
  if (count >= PER_NETWORK || seen.size >= MAX_SEEN) return false;
  seen.set(look, now + SEEN_MS);
  networks.set(from, { count: count + 1, until: count ? held!.until : now + SEEN_MS });
  return true;
}

/**
 * A page someone is looking at: a document, not an image, a frame or a
 * prefetch. Sec-Fetch-Dest says which; a browser too old to send it is taken
 * at its word, as it was before.
 */
function looking(req: Request): boolean {
  const dest = req.get("sec-fetch-dest");
  if (dest && dest !== "document") return false;
  return !/prefetch|prerender/i.test(req.get("sec-purpose") || req.get("purpose") || "");
}

/**
 * Put on `viewer`'s page: one impression, at the ad's bid, if it is this
 * viewer's first look in SEEN_MS. Its owner looking costs nothing and counts
 * for nothing.
 */
function charge(req: Request, entry: Entry, social: boolean, viewer: string): void {
  if (viewer && viewer === entry.ad.owner) return;
  if (!firstLook(req, entry.ad.id, viewer)) return;
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
  if (looking(req)) charge(req, entry, false, viewerOf(req));
  return adMarkup(entry.ad);
}

/** The ad a timeline carries for someone whose posts are about `topic`, charged, or null. */
export function socialAdFor(req: Request, topic: string, viewer: string): SocialAd | null {
  if (!topic || isBot(req)) return null;
  const entry = pickAd(topic, isMobile(req));
  if (!entry) return null;
  charge(req, entry, true, viewer);
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
