import { execFile } from "child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { lookup, type LookupAddress } from "dns";
import { request } from "https";
import { isIP, type LookupFunction } from "net";
import path from "path";
import sharp from "sharp";
import {
  SITE_URL,
  TOKEN_ICON_BIG_EDGE,
  TOKEN_ICON_DIR,
  TOKEN_ICON_EDGE,
  TOKEN_ICON_MAX_BYTES,
  TOKEN_ICON_MAX_PIXELS,
  TOKEN_ICON_MAX_SVG_BYTES,
  TOKEN_ICON_RETRY_MS,
  TOKEN_ICON_TIMEOUT_MS,
  TOKEN_ICON_TTL_MS,
  TOKEN_OWN_ICONS,
} from "../../config";
import { TokenRecord } from "../../types";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WORKERS = 4;
/**
 * Tried before the logo's own URL: the content is the same on any gateway.
 * ipfs.io is left out, and with it dweb.link, w3s.link and nftstorage.link,
 * which share its rate limit and answer a sync's burst with nothing but 429s.
 */
const IPFS_GATEWAYS = ["https://4everland.io/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

/** Arweave and some CDNs answer 403 to a request that names no client. */
const USER_AGENT = `UtopianGo/1.0 (+${SITE_URL})`;

sharp.cache(false);

const have = new Set<string>();
/** Mints whose large copy is on disk too. */
const haveBig = new Set<string>();
const failed = new Map<string, number>();
let running = false;

const BIG = ".big.webp";

function fileOf(mint: string): string {
  return path.join(TOKEN_ICON_DIR, `${mint}.webp`);
}

function bigFileOf(mint: string): string {
  return path.join(TOKEN_ICON_DIR, `${mint}${BIG}`);
}

export function hasIcon(mint: string): boolean {
  return have.has(mint);
}

export function iconFile(mint: string): string | null {
  return MINT.test(mint) && have.has(mint) ? fileOf(mint) : null;
}

/** The large copy, or the small one for a mint synced before there were large ones. */
export function bigIconFile(mint: string): string | null {
  return MINT.test(mint) && haveBig.has(mint) ? bigFileOf(mint) : iconFile(mint);
}

export function restoreIcons(): void {
  try {
    for (const name of readdirSync(TOKEN_ICON_DIR)) {
      if (name.endsWith(BIG)) haveBig.add(name.slice(0, -BIG.length));
      else if (name.endsWith(".webp")) have.add(name.slice(0, -5));
    }
  } catch {
    // No directory yet.
  }
  // After a deploy this says whether the volume came along.
  console.log(`[icons] ${have.size} thumbnails on disk`);
}

function fresh(mint: string, now: number): boolean {
  const miss = failed.get(mint);
  if (miss && now - miss < TOKEN_ICON_RETRY_MS) return true;
  // One synced before the large copies were made is fetched again for it.
  if (!have.has(mint) || !haveBig.has(mint)) return false;
  try {
    return now - statSync(fileOf(mint)).mtimeMs < TOKEN_ICON_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Addresses a logo may not come from: loopback, private, link-local (cloud
 * metadata), CGNAT, multicast and reserved, in both families.
 */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]);
  return (
    v6 === "::" || v6 === "::1" ||
    /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) ||
    v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:")
  );
}

/**
 * The resolver the socket connects with. Checking the address here, rather
 * than resolving once to check and again to connect, is what keeps a name
 * that answers differently the second time (DNS rebinding) from getting in.
 */
const publicLookup: LookupFunction = (host, options, callback) => {
  lookup(host, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => privateAddress(a.address));
    if (bad || !list.length) return callback(new Error(`refused address for ${host}`), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/** The icon URL comes from Jupiter's token metadata, which anyone can set: public https hosts only. */
function allowed(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (host === "localhost" || /\.(localhost|local|internal|home|lan|corp|intranet)$/.test(host)) return false;
  if (url.port && url.port !== "443") return false;
  return !/^[\d.]+$/.test(host) && !host.startsWith("[");
}

type Fetched = { redirect: string } | { body: Buffer };

/**
 * What a download asks for and how much of it it takes. A page read for the
 * icons its head names (src/lib/tokens/favicons.ts) asks for HTML and keeps
 * its first bytes rather than failing on a long page.
 */
export type DownloadOptions = { accept?: string; maxBytes?: number; partial?: boolean };

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml";

function get(url: URL, opts: DownloadOptions = {}): Promise<Fetched> {
  const max = opts.maxBytes ?? TOKEN_ICON_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        lookup: publicLookup,
        headers: {
          Accept: opts.accept ?? IMAGE_ACCEPT,
          "User-Agent": USER_AGENT,
        },
        timeout: TOKEN_ICON_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.destroy();
          return resolve({ redirect: location });
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          return reject(new Error(`status ${status}`));
        }
        if (!opts.partial && Number(res.headers["content-length"]) > max) {
          res.destroy();
          return reject(new Error("too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            res.destroy();
            if (!opts.partial) return reject(new Error("too large"));
            chunks.push(chunk.subarray(0, chunk.length - (size - max)));
            return resolve({ body: Buffer.concat(chunks) });
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    // Covers the whole exchange, not only an idle socket.
    const timer = setTimeout(() => req.destroy(new Error("timeout")), TOKEN_ICON_TIMEOUT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** A public https URL's bytes: redirects followed, private hosts refused, size and time bounded. The home news photos (src/lib/news.ts) come the same way. */
export async function download(start: string, opts: DownloadOptions = {}): Promise<Buffer> {
  return (await downloadFrom(start, opts)).body;
}

/** The same, with the URL the bytes came from once redirects are followed, which a page's relative links resolve against. */
export async function downloadFrom(start: string, opts: DownloadOptions = {}): Promise<{ body: Buffer; url: URL }> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(url)) throw new Error("host refused");
    const got = await get(url, opts);
    if ("body" in got) return { body: got.body, url };
    url = new URL(got.redirect, url);
  }
  throw new Error("too many redirects");
}

/** Raster formats, by their first bytes. */
export function raster(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const gif = buf.toString("latin1", 0, 4) === "GIF8";
  const webp = buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
  const avif = buf.toString("latin1", 4, 8) === "ftyp" && /^(avif|avis|heic|mif1)$/.test(buf.toString("latin1", 8, 12));
  return png || jpeg || gif || webp || avif;
}

/** An SVG document, which may open with an XML declaration, a doctype or a comment. */
export function vector(buf: Buffer): boolean {
  const head = buf.toString("utf8", 0, 1024).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return /^(<\?xml|<svg[\s>]|<!--|<!doctype svg)/.test(head) && /<svg[\s>]/.test(head);
}

/**
 * Draws the SVG at the thumbnail's edge, in a child process.
 *
 * Not in this one: a small file can describe a drawing that takes minutes,
 * and librsvg would spend them on the threads file serving and DNS also use,
 * past sharp's timeout, which only looks in between tiles. The child is
 * killed when the time is up, and gets no environment, so none of the keys.
 */
const DRAW_SVG = `
const sharp = require(${JSON.stringify(require.resolve("sharp"))});
sharp.concurrency(1);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const svg = Buffer.concat(chunks);
  const { width, height } = await sharp(svg).metadata();
  const density = Math.min(2400, Math.max(1, (72 * Number(process.argv[1])) / Math.max(width, height)));
  process.stdout.end(await sharp(svg, { density, limitInputPixels: ${TOKEN_ICON_MAX_PIXELS} }).png().toBuffer());
});`;

function drawSvg(svg: Buffer, edge: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["-e", DRAW_SVG, String(edge)],
      { env: {}, encoding: "buffer", maxBuffer: TOKEN_ICON_MAX_BYTES, timeout: 5_000, killSignal: "SIGKILL" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(svg);
  });
}

/** The content path of an IPFS URL, in either the /ipfs/<cid> or the <cid>.ipfs.<host> form. */
function ipfsPath(url: URL): string | null {
  if (url.pathname.startsWith("/ipfs/")) return url.pathname.slice(6);
  const sub = /^([a-z0-9]{46,})\.ipfs\./.exec(url.hostname);
  return sub ? `${sub[1]}${url.pathname === "/" ? "" : url.pathname}` : null;
}

function sources(icon: string): string[] {
  const path = ipfsPath(new URL(icon));
  const all = path ? [...IPFS_GATEWAYS.map((g) => g + path), icon] : [icon];
  return [...new Set(all)];
}

/**
 * A mint's thumbnail, from the first source whose answer is an image: its
 * logo's URL on each gateway, then the copy the app ships (TOKEN_OWN_ICONS).
 * A gateway can answer 200 with an error page, so a source counts only once
 * its bytes have been drawn.
 */
async function iconOf(rec: TokenRecord): Promise<Thumbs> {
  let last: unknown = new Error("no logo");
  for (const url of rec.icon ? sources(rec.icon) : []) {
    try {
      return await thumbs(await download(url));
    } catch (err) {
      last = err;
    }
  }
  const own = TOKEN_OWN_ICONS.get(rec.mint);
  if (own) return thumbs(readFileSync(own));
  throw last;
}

type Thumbs = { small: Buffer; big: Buffer };

/** Both sizes from the one download, each straight from the original. */
async function thumbs(input: Buffer): Promise<Thumbs> {
  const small = await shrink(input, TOKEN_ICON_EDGE);
  return { small, big: await shrink(input, TOKEN_ICON_BIG_EDGE, 82) };
}

/** Any raster or SVG drawn into a transparent square `edge` pixels on a side, as WebP. */
export async function shrink(input: Buffer, edge: number, quality = 70): Promise<Buffer> {
  if (!raster(input)) {
    if (!vector(input)) throw new Error("not an image");
    if (input.length > TOKEN_ICON_MAX_SVG_BYTES) throw new Error("svg too large");
    input = await drawSvg(input, edge);
  }
  return sharp(input, { limitInputPixels: TOKEN_ICON_MAX_PIXELS, animated: false })
    .timeout({ seconds: 5 })
    .resize(edge, edge, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality, alphaQuality: Math.max(80, quality), effort: 6 })
    .toBuffer();
}

function save(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

function write(mint: string, { small, big }: Thumbs): void {
  save(bigFileOf(mint), big);
  save(fileOf(mint), small);
  haveBig.add(mint);
  have.add(mint);
  // A new logo may be a new colour: read it again now, while it is fresh in
  // mind, rather than on some visitor's page.
  tints.delete(mint);
  void tintOf(mint);
}

/** Fetch and shrink the logos of these mints that are missing or older than a week, in list order. */
export async function syncIcons(list: TokenRecord[]): Promise<void> {
  if (running) return;
  running = true;
  try {
    mkdirSync(TOKEN_ICON_DIR, { recursive: true });
    const now = Date.now();
    const queue = list.filter(
      (rec) => (rec.icon || TOKEN_OWN_ICONS.has(rec.mint)) && MINT.test(rec.mint) && !fresh(rec.mint, now),
    );
    if (!queue.length) return;
    let made = 0;
    const work = async () => {
      for (let rec = queue.shift(); rec; rec = queue.shift()) {
        try {
          write(rec.mint, await iconOf(rec));
          failed.delete(rec.mint);
          made += 1;
        } catch {
          failed.set(rec.mint, now);
        }
      }
    };
    const total = queue.length;
    await Promise.all(Array.from({ length: WORKERS }, work));
    console.log(`[icons] ${made}/${total} thumbnails synced`);
  } catch (err) {
    console.warn("[icons] sync failed:", err);
  } finally {
    running = false;
  }
}

/**
 * A logo's colour, as the two ends of a tile's gradient (`--hi`, `--lo`), for
 * the home page's asset tiles to be painted in the way its app tiles are
 * painted in their marks' colours. Read once per mint from the thumbnail on
 * disk and kept; null until it has been, which the first render that asks
 * starts. A page that must have it waits for it with tintOf / tintsOf.
 */
const tints = new Map<string, string>();
const tinting = new Map<string, Promise<string>>();

export function iconTint(mint: string): string | null {
  const tint = tints.get(mint);
  if (tint != null) return tint || null;
  void tintOf(mint);
  return null;
}

/**
 * The same, waited for: the watchlist menu's rows carry it, so a tile picked
 * from one is painted at once. A 24px read of a 64px file, a few
 * milliseconds; null for a mint with no logo on disk.
 */
export async function tintOf(mint: string): Promise<string | null> {
  const held = tints.get(mint);
  if (held != null) return held || null;
  const file = iconFile(mint);
  if (!file) return null;
  let task = tinting.get(mint);
  if (!task) {
    // A read that fails is not kept: the next page to ask tries again, rather
    // than the tile staying graphite until a restart.
    task = readTint(file).then(
      (t) => {
        tints.set(mint, t);
        tinting.delete(mint);
        return t;
      },
      () => {
        tinting.delete(mint);
        return "";
      },
    );
    tinting.set(mint, task);
  }
  return (await task) || null;
}

/**
 * How long a page waits on its tiles' colours. A read is a few milliseconds;
 * this only bounds a disk or sharp that has stalled, past which the page goes
 * out with graphite tiles rather than not at all.
 */
const TINT_WAIT_MS = 250;

/** Every one of these mints' colours read, or the wait up: what a render needs before it asks iconTint. */
export async function tintsOf(mints: string[]): Promise<void> {
  const pending = mints.filter((m) => !tints.has(m) && iconFile(m));
  if (!pending.length) return;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TINT_WAIT_MS);
  });
  await Promise.race([Promise.all(pending.map(tintOf)), late]);
  clearTimeout(timer);
}

/**
 * The logo's strongest hue, by its opaque pixels' chroma, at two lightnesses
 * dark enough to carry white type. A logo with no colour to speak of (black,
 * white, grey) gets a graphite one rather than whatever hue its noise lands on.
 */
export async function readTint(file: string): Promise<string> {
  const { data } = await sharp(file).resize(24, 24, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Float64Array(36);
  const sat = new Float64Array(36);
  let chroma = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const c = max - min;
    // A black or white ground (Solana's stripes sit on black) says nothing
    // about how colourful the mark on it is.
    if (max < 0.2 || min > 0.9) continue;
    count += 1;
    chroma += c;
    if (c < 0.08) continue;
    const h = max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
    const l = (max + min) / 2;
    const bin = Math.floor(h * 6) % 36;
    bins[bin] += c;
    sat[bin] += c / (1 - Math.abs(2 * l - 1) || 1);
  }
  if (!count || chroma / count < 0.1) return "--hi:#6e6e76;--lo:#2a2a2f";
  let best = 0;
  for (let i = 1; i < 36; i++) if (bins[i] > bins[best]) best = i;
  const hue = best * 10 + 5;
  const s = Math.min(0.85, Math.max(0.4, sat[best] / bins[best]));
  return `--hi:${hsl(hue, s, 0.54)};--lo:${hsl(hue, s, 0.27)}`;
}

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
