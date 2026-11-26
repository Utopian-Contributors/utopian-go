/**
 * What search engines read: robots.txt, the sitemap, and the wallet page's
 * addresses (/wallet, /wallet/<list>, /wallet/<token>), each with a title,
 * description and card of its own. Also the page an address nothing lives
 * at gets.
 *
 * The wallet is the site's one body of pages a search engine can index:
 * every token the index carries, its price, its line and its market, open to
 * anyone whether signed in or not (the portfolio is the one part that needs
 * an account, and signed out its place says so). The page itself is one
 * document; what differs per address is its head, written here, and which
 * list or token it opens on, which client/wallet/main.js reads off <body>.
 *
 * The figures in a head are the index's own, never refreshed for it. A
 * crawler walks every address, and a fetch per page would spend the Helius
 * budget the search cards live on; the page's script asks for live ones.
 */
import type express from "express";
import { readFileSync } from "fs";
import path from "path";
import { SITE_URL } from "./config";
import { authPath, esc } from "./pages";
import { TOKEN_LISTS, pagedTokens, tokenByMint } from "./lib/tokens/store";
import { change } from "./lib/tokens/ticker";
import type { TokenList, TokenRecord } from "./types";

// —— The 404 ——

/** The built 404 page; empty until the client is built. */
let notFoundDoc = "";

/** (Re)read the built 404 page. Called at boot and whenever the build replaces it. */
export function loadSeoDocs(publicDir: string): void {
  try {
    notFoundDoc = readFileSync(path.join(publicDir, "404.html"), "utf8");
  } catch (err) {
    console.warn("[seo] 404.html load failed:", err instanceof Error ? err.message : err);
    notFoundDoc = "";
  }
}

/** Answer with the 404 page, or a plain line before the client is built. */
export function sendNotFound(_req: express.Request, res: express.Response): void {
  res.status(404);
  res.setHeader("Cache-Control", "no-cache");
  if (notFoundDoc) res.type("html").send(notFoundDoc);
  else res.type("text").send("Not found.");
}

// —— Wallet addresses ——

/** A token's symbol as a path segment: "$WIF" → "wif", "BRK.Bx" → "brk-bx", "我的刀盾" → "". */
export function slugOf(symbol: string): string {
  return symbol
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The lists' own addresses: a token whose symbol slugs to one of these is at its mint. */
const RESERVED = new Set<string>(TOKEN_LISTS);

/**
 * Who owns each symbol's address. A symbol several tokens share (24 of them:
 * PEPE, META, WBTC…) goes to the busiest, and the rest are at their mint.
 * Ownership can change on a rebuild; the mint address never does, and both
 * stay answerable. Rebuilt when the index is: pagedTokens is a new array then.
 */
let tableFor: readonly TokenRecord[] | null = null;
let owners = new Map<string, TokenRecord>();

function table(): Map<string, TokenRecord> {
  const tokens = pagedTokens();
  if (tableFor !== tokens) {
    owners = new Map();
    for (const rec of tokens) {
      const slug = slugOf(rec.symbol);
      if (slug && !RESERVED.has(slug) && !MINT.test(slug) && !owners.has(slug)) owners.set(slug, rec);
    }
    tableFor = tokens;
  }
  return owners;
}

/** A token's wallet address: /wallet/bonk, or /wallet/<mint> where its symbol is someone else's. */
export function walletTokenPath(rec: TokenRecord): string {
  const slug = slugOf(rec.symbol);
  return slug && table().get(slug) === rec ? `/wallet/${slug}` : `/wallet/${rec.mint}`;
}

/** A list's wallet address; Trending is the page's own. */
export function walletListPath(list: TokenList): string {
  return list === "trending" ? "/wallet" : `/wallet/${list}`;
}

/** What a wallet address opens on. */
export type WalletTarget = { list: TokenList; token?: undefined } | { token: TokenRecord; list?: undefined };

/**
 * The wallet address a request names, and its canonical spelling: `redirect`
 * when it was asked for another way (/wallet/BONK, /wallet/<mint> of a token
 * with a name, the old ?t= and ?c=). Null for a segment that is neither a
 * list nor a token the index carries.
 */
export function resolveWallet(req: express.Request): { target: WalletTarget; path: string; redirect: boolean } | null {
  const seg = req.path.replace(/^\/wallet\/?/i, "").replace(/\/+$/, "");
  // The addresses this page had before it had paths: ?t=<mint> and ?c=<list>.
  const t = typeof req.query.t === "string" ? req.query.t : "";
  const c = typeof req.query.c === "string" ? req.query.c : "";
  const asked = seg || (t ? t : c && c !== "trending" ? c : "");
  let target: WalletTarget | null;
  if (!asked) target = { list: "trending" };
  else if ((TOKEN_LISTS as readonly string[]).includes(asked.toLowerCase())) target = { list: asked.toLowerCase() as TokenList };
  else {
    const rec = MINT.test(asked) ? tokenByMint(asked) : table().get(slugOf(asked));
    target = rec ? { token: rec } : null;
  }
  if (!target) return null;
  const canonical = target.token ? walletTokenPath(target.token) : walletListPath(target.list);
  return { target, path: canonical, redirect: req.path !== canonical || !!(t || c) };
}

// —— The wallet page's head ——

/** How each list is named in a title, and said in a description. */
const LIST_TITLE: Record<TokenList, string> = {
  trending: "Trending Solana Tokens",
  stocks: "Tokenized Stocks on Solana",
  memes: "Solana Memecoins",
  rwas: "Real-World Assets on Solana",
  majors: "Major Tokens on Solana",
  defi: "DeFi Tokens on Solana",
};

const LIST_PHRASE: Record<TokenList, string> = {
  trending: "trending Solana tokens",
  stocks: "tokenized stocks on Solana",
  memes: "Solana memecoins",
  rwas: "real-world assets on Solana",
  majors: "major tokens on Solana",
  defi: "DeFi tokens on Solana",
};

/** The same price spelled out, for a title or a description: "$0.00005835". */
function plainPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(v)) - 1);
  return `$${v.toFixed(Math.min(20, zeros + 4)).replace(/0+$/, "")}`;
}

/** Large dollar figures, compact: $40.1B, $812.4K; cents below a thousand. */
function compactUsd(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "";
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
}

/** "Bonk (Bonk)" says the name twice; the symbol goes in brackets only when it adds something. */
function labelOf(rec: TokenRecord): string {
  return slugOf(rec.name) === slugOf(rec.symbol) ? rec.name : `${rec.name} (${rec.symbol})`;
}

/** One token's day, in a sentence: what a search result shows under its title. */
function tokenSentence(rec: TokenRecord): string {
  const plain = plainPrice(rec.price);
  const moved =
    rec.change24h == null || !Number.isFinite(rec.change24h)
      ? ""
      : rec.change24h === 0
        ? ", flat over the last 24 hours"
        : `, ${rec.change24h > 0 ? "up" : "down"} ${change(Math.abs(rec.change24h)).replace(/^\+/, "")} over the last 24 hours`;
  const cap = compactUsd(rec.mcap);
  const vol = compactUsd(rec.volume24h);
  return (
    `${labelOf(rec)} is at ${plain || "no price yet"}${moved}.` +
    (cap && vol ? ` Its market cap is ${cap}, with ${vol} traded in the last day.` : cap ? ` Its market cap is ${cap}.` : vol ? ` ${vol} of it traded in the last day.` : "")
  );
}

/** A token's wallet page title; the page's script sets the same one when the token is picked. */
export function walletTokenTitle(rec: TokenRecord): string {
  return `${labelOf(rec)} Price, Chart and Trade | UtopianGO Wallet`;
}

interface Head {
  title: string;
  description: string;
  path: string;
  crumbs: [string, string][];
  /** Its share card (lib/og/cards.ts), and what the card shows for anyone who cannot see it. */
  card: string;
  cardAlt: string;
}

function headOf(target: WalletTarget, at: string): Head {
  if (target.token) {
    const rec = target.token;
    return {
      title: walletTokenTitle(rec),
      description: `${tokenSentence(rec)} See its chart and market, and trade it, in the UtopianGO wallet.`,
      path: at,
      crumbs: [
        ["Wallet", "/wallet"],
        [labelOf(rec), at],
      ],
      card: `/og/wallet/${rec.mint}.png`,
      cardAlt: `${labelOf(rec)}'s logo, price and chart over the last 24 hours`,
    };
  }
  if (target.list === "trending") {
    return {
      title: "UtopianGO Wallet | Solana Token Prices and Your Portfolio",
      description:
        "Live prices and charts for every Solana token we index: trending tokens, tokenized stocks, memecoins, DeFi and more. Trade any of them, and see your own portfolio once you log in.",
      path: at,
      crumbs: [["Wallet", "/wallet"]],
      card: "/og/wallet/trending.png",
      cardAlt: "The UtopianGO wallet: the busiest Solana tokens, with their prices and moves today",
    };
  }
  const name = LIST_TITLE[target.list];
  return {
    title: `${name}: Prices Today | UtopianGO Wallet`,
    description: `Live prices, 24-hour moves and charts for ${LIST_PHRASE[target.list]}, busiest first. Open any one for its market, and trade it from the UtopianGO wallet.`,
    path: at,
    crumbs: [
      ["Wallet", "/wallet"],
      [name, at],
    ],
    card: `/og/wallet/${target.list}.png`,
    cardAlt: `The top ${LIST_PHRASE[target.list]}, with their prices and moves today`,
  };
}

function headTags(h: Head): string {
  const url = esc(SITE_URL + h.path);
  const d = esc(h.description);
  // Data, not script: the CSP's script-src does not govern it. `<` escaped so
  // no token's name can close the element.
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: h.crumbs.map(([name, u], i) => ({ "@type": "ListItem", position: i + 1, name, item: SITE_URL + u })),
  }).replace(/</g, "\\u003c");
  return (
    `<title>${esc(h.title)}</title>` +
    `<meta name="description" content="${d}">` +
    `<link rel="canonical" href="${url}">` +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="UtopianGO">' +
    `<meta property="og:title" content="${esc(h.title.replace(/ \| UtopianGO Wallet$/, ""))}">` +
    `<meta property="og:description" content="${d}"><meta property="og:url" content="${url}">` +
    `<meta property="og:image" content="${esc(SITE_URL + h.card)}">` +
    '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' +
    `<meta property="og:image:alt" content="${esc(h.cardAlt)}">` +
    '<meta name="twitter:card" content="summary_large_image">' +
    `<script type="application/ld+json">${ld}</script>`
  );
}

/** The wallet document's slots this writes into (client/wallet.html). */
const TITLE_SLOT = "<title>Wallet</title>";
const BODY_SLOT = '<body class="res wl-pg';
const REGISTER_SLOT = 'href="/register?next=/wallet" id="wl-in-r"';
const LOGIN_SLOT = 'href="/login?next=/wallet" id="wl-in-l"';

/**
 * The wallet document (as renderPage left it, signed in or out) for one
 * address: its head, what it opens on (data-c, data-t on <body>, read by
 * client/wallet/main.js), and the sign-in prompt's links back to it. Throws
 * if the build moved a slot.
 */
export function walletDoc(html: string, target: WalletTarget, at: string): string {
  const open = target.token ? ` data-t="${target.token.mint}"` : target.list !== "trending" ? ` data-c="${target.list}"` : "";
  const swaps: [string, string][] = [
    [TITLE_SLOT, headTags(headOf(target, at))],
    [BODY_SLOT, `<body${open} class="res wl-pg`],
    [REGISTER_SLOT, `href="${esc(authPath("/register", at))}" id="wl-in-r"`],
    [LOGIN_SLOT, `href="${esc(authPath("/login", at))}" id="wl-in-l"`],
  ];
  let out = html;
  for (const [from, into] of swaps) {
    if (!out.includes(from)) throw new Error(`wallet.html: no ${from}`);
    out = out.replace(from, () => into);
  }
  return out;
}

// —— robots.txt and the sitemap ——

/**
 * Social answers a crawler with a redirect to the login page, and /api/ is
 * what a page's script asks for; a crawler rendering the search page would
 * otherwise spend the search API's quota on queries nobody typed. A results
 * page (/?q=) stays crawlable so the crawler can read the noindex it
 * carries (sendIndex in src/server.ts). The wallet is open: its pages are
 * the ones worth finding.
 */
export function robotsTxt(): string {
  return [
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /social",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /news/go/",
    "",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    "",
  ].join("\n");
}

/** The pages worth indexing that are not the wallet's. */
const STATIC_PAGES = ["/", "/games", "/slots", "/pinball", "/snake", "/shotgun", "/rally"];

/**
 * Every indexable URL: the pages above, the wallet's lists, and a wallet
 * address for every verified token (and those named by hand). About 1,500,
 * well under the protocol's 50,000 per file, so one sitemap. Kept per index
 * rebuild.
 */
let sitemapFor: readonly TokenRecord[] | null = null;
let sitemapXml = "";

export function sitemap(): string {
  const tokens = pagedTokens();
  if (sitemapFor === tokens && sitemapXml) return sitemapXml;
  const urls = [...STATIC_PAGES, ...TOKEN_LISTS.map(walletListPath), ...tokens.map(walletTokenPath)];
  sitemapXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `<url><loc>${esc(SITE_URL + u)}</loc></url>`).join("\n") +
    "\n</urlset>\n";
  sitemapFor = tokens;
  return sitemapXml;
}

export function mountSeo(app: express.Express): void {
  app.get("/robots.txt", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("text/plain").send(robotsTxt());
  });

  app.get("/sitemap.xml", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("application/xml").send(sitemap());
  });
}
