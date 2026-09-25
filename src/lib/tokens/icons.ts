import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
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

/** The icon URL comes from Jupiter's token metadata, which anyone can set: public https hosts only. */
function allowed(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return false;
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return false;
  return !/^[\d.]+$/.test(host) && !host.startsWith("[");
}

async function download(start: string): Promise<Buffer> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(url)) throw new Error("host refused");
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_ICON_TIMEOUT_MS),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
    if (Number(res.headers.get("content-length")) > TOKEN_ICON_MAX_BYTES) throw new Error("too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > TOKEN_ICON_MAX_BYTES) throw new Error("too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("too many redirects");
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
  return sharp(input, { limitInputPixels: 4096 * 4096, animated: false })
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
