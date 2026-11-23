import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import { FAVICON_DIR, FAVICON_EDGE, FAVICON_PAGE_BYTES, TOKEN_ICON_RETRY_MS, TOKEN_ICON_TTL_MS } from "../../config";
import { download, downloadFrom, raster, readTint, shrink, vector } from "./icons";

/**
 * The icons of the sites a token links to, drawn behind the wallet panel's
 * link tiles. Read from the site itself: the icons its page's head names,
 * then the two places a site keeps one by convention. Kept by host name, so
 * every token that links into t.me shares Telegram's.
 *
 * The links come from Jupiter's token metadata, which anyone can set, so the
 * fetching is download's (src/lib/tokens/icons.ts): public https hosts only,
 * redirects followed, size and time bounded. What is served back is always a
 * WebP this module drew, never the site's own bytes.
 */

/** A host name as URL gives it: lower case, punycode. Also safe as a file name. */
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const have = new Set<string>();
const failed = new Map<string, number>();
const pending = new Map<string, Promise<boolean>>();
const tints = new Map<string, string>();

try {
  for (const name of readdirSync(FAVICON_DIR)) if (name.endsWith(".webp")) have.add(name.slice(0, -5));
} catch {
  // No directory yet.
}

function fileOf(host: string): string {
  return path.join(FAVICON_DIR, `${host}.webp`);
}

function hostOf(site: string): string | null {
  try {
    const url = new URL(site);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

function fresh(host: string, now: number): boolean {
  if (!have.has(host)) return false;
  try {
    return now - statSync(fileOf(host)).mtimeMs < TOKEN_ICON_TTL_MS;
  } catch {
    return false;
  }
}

/** The stored icon of the site this link is on, if there is one yet. */
export function faviconFile(site: string): string | null {
  const host = hostOf(site);
  return host && have.has(host) ? fileOf(host) : null;
}

/**
 * The tile colours (`--hi`, `--lo`) for the site's icon, as the home page's
 * asset tiles take theirs from a logo: the icon fetched if it is not on disk,
 * then read. Null for a site with no icon to be had, or when `waitMs` runs
 * out first; the fetch and the read carry on, for whoever asks next (the
 * tile itself, once its icon has drawn: client/wallet/panel.js).
 */
export async function faviconTint(site: string, waitMs = Infinity): Promise<string | null> {
  const host = hostOf(site);
  if (!host) return null;
  const held = tints.get(host);
  if (held != null) return held || null;
  const work = (async () => {
    if (!have.has(host) && !(await ensureFavicon(site))) return null;
    return (await tintOfHost(host)) || null;
  })();
  if (waitMs === Infinity) return work;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One read per host at a time; a failed read is not kept, so the next ask tries again. */
const reading = new Map<string, Promise<string>>();

function tintOfHost(host: string): Promise<string> {
  const held = tints.get(host);
  if (held != null) return Promise.resolve(held);
  let task = reading.get(host);
  if (!task) {
    task = readTint(fileOf(host)).then(
      (t) => {
        tints.set(host, t);
        return t;
      },
      () => "",
    ).finally(() => reading.delete(host));
    reading.set(host, task);
  }
  return task;
}

/** Fetches the site's icon unless it is on disk and fresh. True once there is one to serve. */
export function ensureFavicon(site: string): Promise<boolean> {
  const host = hostOf(site);
  if (!host) return Promise.resolve(false);
  const now = Date.now();
  if (fresh(host, now)) return Promise.resolve(true);
  const miss = failed.get(host);
  if (miss && now - miss < TOKEN_ICON_RETRY_MS) return Promise.resolve(have.has(host));
  let task = pending.get(host);
  if (!task) {
    task = fetchIcon(site)
      .then((bytes) => {
        mkdirSync(FAVICON_DIR, { recursive: true });
        const file = fileOf(host);
        writeFileSync(`${file}.tmp`, bytes);
        renameSync(`${file}.tmp`, file);
        have.add(host);
        tints.delete(host);
        failed.delete(host);
        // Read now, so the colour is ready by the time anyone asks for it.
        void tintOfHost(host);
        return true;
      })
      .catch(() => {
        failed.set(host, Date.now());
        // An older copy still serves.
        return have.has(host);
      })
      .finally(() => pending.delete(host));
    pending.set(host, task);
  }
  return task;
}

/** The first candidate that draws, best first. */
async function fetchIcon(site: string): Promise<Buffer> {
  let page = new URL(site);
  let named: string[] = [];
  try {
    const got = await downloadFrom(page.href, { accept: "text/html", maxBytes: FAVICON_PAGE_BYTES, partial: true });
    // Where a redirect ended (discord.gg goes on to discord.com) is where
    // the page's own paths, and the conventional places, are.
    page = got.url;
    named = iconLinks(got.body.toString("utf8"), page);
  } catch {
    // No page to read: the conventional places may still answer.
  }
  const all = [...new Set([...named, `${page.origin}/apple-touch-icon.png`, `${page.origin}/favicon.ico`])];
  let last: unknown = new Error("no icon");
  for (const url of all.slice(0, 5)) {
    try {
      return await shrink(await decodable(await download(url)), FAVICON_EDGE);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * The icons a page's head names, largest first: an apple-touch-icon is drawn
 * for a home screen at 180px, an SVG at any size, and a plain icon is
 * usually 16 or 32. Safari's mask-icon is a one-colour outline, left out.
 */
function iconLinks(html: string, base: URL): string[] {
  const end = html.search(/<\/head>/i);
  const head = end > 0 ? html.slice(0, end) : html;
  const found: { url: string; size: number }[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href) continue;
    const touch = rel.some((r) => r.startsWith("apple-touch-icon"));
    if (!touch && !rel.includes("icon")) continue;
    const sizes = attr(tag, "sizes").toLowerCase();
    const svg = /svg/.test(attr(tag, "type")) || /\.svg(\?|$)/i.test(href);
    const listed = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
    const size = sizes === "any" || svg ? 512 : listed || (touch ? 180 : 32);
    try {
      const url = new URL(href, base);
      if (url.protocol === "https:") found.push({ url: url.href, size });
    } catch {
      // Not a URL.
    }
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.url);
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  return raw.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").trim();
}

/**
 * Bytes sharp can draw. An .ico is a directory of images; its largest is
 * taken, either a PNG as it stands or a 32-bit bitmap rebuilt as raw pixels.
 */
async function decodable(buf: Buffer): Promise<Buffer> {
  if (raster(buf) || vector(buf)) return buf;
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an image");
  const count = buf.readUInt16LE(4);
  let best: { edge: number; size: number; offset: number } | null = null;
  for (let i = 0; i < count && 6 + i * 16 + 16 <= buf.length; i++) {
    const at = 6 + i * 16;
    const edge = buf[at] || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + size > buf.length) continue;
    if (!best || edge > best.edge) best = { edge, size, offset };
  }
  if (!best) throw new Error("empty icon");
  const img = buf.subarray(best.offset, best.offset + best.size);
  if (raster(img)) return img;
  return bitmap(img);
}

/** A 32-bit BGRA DIB, stored bottom up at twice its height (the AND mask follows), as a PNG. */
async function bitmap(dib: Buffer): Promise<Buffer> {
  if (dib.length < 40) throw new Error("bad bitmap");
  const header = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  const height = Math.abs(dib.readInt32LE(8)) / 2;
  const bpp = dib.readUInt16LE(14);
  if (bpp !== 32 || width <= 0 || width > 256 || height <= 0 || height > 256) throw new Error("unsupported bitmap");
  const start = header;
  if (start + width * height * 4 > dib.length) throw new Error("short bitmap");
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = start + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const s = row + x * 4;
      const d = (y * width + x) * 4;
      rgba[d] = dib[s + 2];
      rgba[d + 1] = dib[s + 1];
      rgba[d + 2] = dib[s];
      rgba[d + 3] = dib[s + 3];
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
