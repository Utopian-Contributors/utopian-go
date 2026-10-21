import { HELIUS_RPC_URL, TOKEN_PRICE_TIMEOUT_MS } from "../../config";
import { TokenAsset } from "../../types";

/**
 * What the chain says about a mint the token index does not carry: the wallet
 * page's answer to "what is this token I hold?". One Helius `getAssetBatch`
 * call for a list of them.
 *
 * Every field is the creator's own say-so, and these are mostly airdropped
 * spam, so each is cut to size and a link is kept only when it is https. The
 * image is passed on as its own URL for the browser to fetch, not synced into
 * /icon/ the way an indexed token's is: nothing about a mint we do not list
 * should be stored or served from here.
 */

/** Mints per call: the most a holdings page names (lib/holdings.ts). */
export const MAX_ASSETS = 50;

/** Metadata changes rarely and is read when someone asks; this absorbs a reopen. */
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHED = 2_000;

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const ARWEAVE = "https://arweave.net/";

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PNnBxHDp7DRBQkUa";

interface RawAsset {
  id?: string;
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string; external_url?: string };
  };
  authorities?: { address?: string; scopes?: string[] }[];
  mutable?: boolean;
  token_info?: {
    symbol?: string;
    supply?: number;
    decimals?: number;
    token_program?: string;
    mint_authority?: string;
    freeze_authority?: string;
  };
  mint_extensions?: { metadata?: { name?: string; symbol?: string; uri?: string } };
}

interface RpcReply {
  result?: (RawAsset | null)[];
  error?: { message?: string };
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // Control characters out, whitespace runs to one space: it is shown as text, never markup.
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** https as it is; ipfs:// and ar:// through a public gateway, since a browser fetches neither. */
function link(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 500) return undefined;
  const s = v.trim();
  if (s.startsWith("ipfs://")) return IPFS_GATEWAY + s.slice(7).replace(/^ipfs\//, "");
  if (s.startsWith("ar://")) return ARWEAVE + s.slice(5);
  try {
    const url = new URL(s);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function address(v: unknown): string | undefined {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : undefined;
}

function readAsset(mint: string, a: RawAsset | null | undefined): TokenAsset {
  const meta = a?.content?.metadata;
  const ext = a?.mint_extensions?.metadata;
  const info = a?.token_info;
  const decimals = info?.decimals;
  const supply = info?.supply;
  const out: TokenAsset = {
    mint,
    name: text(meta?.name || ext?.name, 64),
    symbol: text(meta?.symbol || info?.symbol || ext?.symbol, 16),
    description: text(meta?.description, 400),
    image: link(a?.content?.links?.image),
    website: link(a?.content?.links?.external_url),
    uri: link(a?.content?.json_uri || ext?.uri),
    decimals: typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : undefined,
    // A JSON number, so past 2^53 it is already rounded; near enough to read.
    supply: typeof supply === "number" && Number.isFinite(supply) && supply >= 0 ? BigInt(Math.trunc(supply)).toString() : undefined,
    program: info?.token_program === TOKEN_2022_PROGRAM ? "Token-2022" : info?.token_program ? "Token" : undefined,
    mintAuthority: address(info?.mint_authority),
    freezeAuthority: address(info?.freeze_authority),
    updateAuthority: address(a?.authorities?.find((x) => x.scopes?.includes("full"))?.address),
    mutable: typeof a?.mutable === "boolean" ? a.mutable : undefined,
  };
  for (const key of Object.keys(out) as (keyof TokenAsset)[]) if (out[key] === undefined) delete out[key];
  return out;
}

const cache = new Map<string, { at: number; value: TokenAsset }>();

/** What Helius knows of each mint, in the order asked. A mint it has nothing on comes back bare. */
export async function fetchAssets(mints: string[]): Promise<TokenAsset[]> {
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is not configured");

  const now = Date.now();
  const found = new Map<string, TokenAsset>();
  for (const mint of mints) {
    const hit = cache.get(mint);
    if (hit && now - hit.at < CACHE_TTL_MS) found.set(mint, hit.value);
  }
  const ask = mints.filter((m) => !found.has(m));

  if (ask.length) {
    const res = await fetch(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "assets",
        method: "getAssetBatch",
        params: { ids: ask, options: { showFungible: true } },
      }),
    });
    if (!res.ok) throw new Error(`Helius responded ${res.status}`);
    const body = (await res.json()) as RpcReply;
    if (body.error) throw new Error(`RPC error: ${(body.error.message || "").slice(0, 200)}`);

    const list = Array.isArray(body.result) ? body.result : [];
    // Past the cap is a flood, not a working set, as in lib/holdings.ts.
    if (cache.size >= MAX_CACHED) cache.clear();
    ask.forEach((mint, i) => {
      const raw = list[i];
      const value = readAsset(mint, raw && raw.id === mint ? raw : list.find((r) => r?.id === mint));
      cache.set(mint, { at: now, value });
      found.set(mint, value);
    });
  }

  return mints.map((m) => found.get(m) ?? { mint: m });
}
