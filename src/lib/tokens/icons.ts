import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { lookup, type LookupAddress } from "dns";
import { request } from "https";
import { isIP, type LookupFunction } from "net";
import path from "path";
import sharp from "sharp";
import {
  TOKEN_ICON_DIR,
  TOKEN_ICON_EDGE,
  TOKEN_ICON_MAX_BYTES,
  TOKEN_ICON_RETRY_MS,
  TOKEN_ICON_TIMEOUT_MS,
  TOKEN_ICON_TTL_MS,
} from "../../config";
import { TokenRecord } from "../../types";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WORKERS = 4;
/** Tried after the logo's own URL. ipfs.io and dweb.link answer 429 to a sync's burst. */
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];

sharp.cache(false);

const have = new Set<string>();
const failed = new Map<string, number>();
let running = false;

function fileOf(mint: string): string {
  return path.join(TOKEN_ICON_DIR, `${mint}.webp`);
}

export function hasIcon(mint: string): boolean {
  return have.has(mint);
}

export function iconFile(mint: string): string | null {
  return MINT.test(mint) && have.has(mint) ? fileOf(mint) : null;
}

export function restoreIcons(): void {
  try {
    for (const name of readdirSync(TOKEN_ICON_DIR)) {
      if (name.endsWith(".webp")) have.add(name.slice(0, -5));
    }
  } catch {
    // No directory yet.
  }
}

function fresh(mint: string, now: number): boolean {
  const miss = failed.get(mint);
  if (miss && now - miss < TOKEN_ICON_RETRY_MS) return true;
  if (!have.has(mint)) return false;
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

function get(url: URL): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        lookup: publicLookup,
        headers: { Accept: "image/png,image/jpeg,image/webp,image/gif,image/avif" },
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
        if (Number(res.headers["content-length"]) > TOKEN_ICON_MAX_BYTES) {
          res.destroy();
          return reject(new Error("too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > TOKEN_ICON_MAX_BYTES) {
            res.destroy();
            reject(new Error("too large"));
            return;
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

async function download(start: string): Promise<Buffer> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(url)) throw new Error("host refused");
    const got = await get(url);
    if ("body" in got) return got.body;
    url = new URL(got.redirect, url);
  }
  throw new Error("too many redirects");
}

/**
 * Raster formats only, by their first bytes.
 *
 * SVG is refused: librsvg would render it, and a small file can describe a
 * drawing that takes minutes, on the threads file serving and DNS also use.
 */
function raster(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const gif = buf.toString("latin1", 0, 4) === "GIF8";
  const webp = buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
  const avif = buf.toString("latin1", 4, 8) === "ftyp" && /^(avif|avis|heic|mif1)$/.test(buf.toString("latin1", 8, 12));
  return png || jpeg || gif || webp || avif;
}

/** The content path of an IPFS URL, in either the /ipfs/<cid> or the <cid>.ipfs.<host> form. */
function ipfsPath(url: URL): string | null {
  if (url.pathname.startsWith("/ipfs/")) return url.pathname.slice(6);
  const sub = /^([a-z0-9]{46,})\.ipfs\./.exec(url.hostname);
  return sub ? `${sub[1]}${url.pathname === "/" ? "" : url.pathname}` : null;
}

function sources(icon: string): string[] {
  const path = ipfsPath(new URL(icon));
  const all = path ? [icon, ...IPFS_GATEWAYS.map((g) => g + path)] : [icon];
  return [...new Set(all)];
}

async function fetchIcon(icon: string): Promise<Buffer> {
  let last: unknown;
  for (const url of sources(icon)) {
    try {
      return await download(url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function thumb(input: Buffer): Promise<Buffer> {
  if (!raster(input)) return Promise.reject(new Error("not a raster image"));
  return sharp(input, { limitInputPixels: 2048 * 2048, animated: false })
    .timeout({ seconds: 5 })
    .resize(TOKEN_ICON_EDGE, TOKEN_ICON_EDGE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 70, alphaQuality: 80, effort: 6 })
    .toBuffer();
}

function write(mint: string, bytes: Buffer): void {
  const file = fileOf(mint);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  have.add(mint);
}

/** Fetch and shrink the logos of these mints that are missing or older than a week, in list order. */
export async function syncIcons(list: TokenRecord[]): Promise<void> {
  if (running) return;
  running = true;
  try {
    mkdirSync(TOKEN_ICON_DIR, { recursive: true });
    const now = Date.now();
    const queue = list.filter((rec) => rec.icon && MINT.test(rec.mint) && !fresh(rec.mint, now));
    if (!queue.length) return;
    let made = 0;
    const work = async () => {
      for (let rec = queue.shift(); rec; rec = queue.shift()) {
        try {
          write(rec.mint, await thumb(await fetchIcon(rec.icon!)));
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
