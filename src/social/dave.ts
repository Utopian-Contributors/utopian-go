/**
 * Dave, the chat agent on /dave.
 *
 * A short tool loop on Claude: he can search the web (Brave, the same key
 * search uses), read the signed-in account's wallet, and propose a trade.
 * He never trades himself. A proposal comes back to the page as a card, and
 * only the person's passkey turns it into a swap (/dave/trade in routes.ts,
 * then swapFor, which re-quotes and refuses anything below what was shown).
 *
 * Chats are kept in dave_chats (db.ts): the page sends a question and which
 * chat it belongs to, and the history Dave reads comes from there, never from
 * the page. The tool steps of one reply live only for that request.
 */
import { ANTHROPIC_API_KEY, DAVE_MODEL, JUP_FEE_BPS, JUP_SWAP_ENDPOINT } from "../config";
import { braveSearch } from "../lib/brave";
import { readBook } from "../lib/holdings";
import { JupiterBusy, jupFetch } from "../lib/jupiterGate";
import { lookupMints, searchTokens } from "../lib/tokens/store";
import type { DaveTurn, User } from "./db";
import { base58Decode } from "./keys";
import { SocialError } from "./limits";
import { solanaPubkey } from "./pay";
import { SOL_MINT, mintInfo } from "./send";
import { feeAccount } from "./swap";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Turns of a chat Dave reads back, characters in a question, and turns a chat keeps. */
export const DAVE_TURNS = 16;
export const DAVE_CHARS = 1500;
export const DAVE_KEEP = 200;
/** Model calls in one reply: tool rounds, then one last answer without tools. */
const MAX_STEPS = 5;
/** What Dave proposes trading with, by default: the trade dialog's own 1%. */
const SLIPPAGE_BPS = 100;

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** A trade Dave proposes, as the page shows it and posts it back to /dave/trade. */
export interface Proposal {
  inputMint: string;
  outputMint: string;
  /** Base units of the input. */
  amount: string;
  /** Base units of the output Jupiter quoted. */
  quotedOut: string;
  slippageBps: number;
  sell: { symbol: string; amount: string };
  buy: { symbol: string; amount: string };
  usd?: number;
}

export interface Reply {
  text: string;
  trade?: Proposal;
  sources?: { title: string; url: string }[];
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web for current information: news, prices, facts, anything after your training. Returns the top results with title, URL and a snippet.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
  {
    name: "wallet",
    description:
      "The signed-in person's Solana wallet: its address and every priced holding with amount and USD value. Use before proposing a trade, so the amount is one they can afford.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_trade",
    description:
      "Quote a swap from the person's wallet and show it to them as a card they confirm with their passkey. This does NOT trade: nothing moves until they confirm. Give the amount either in the token being sold (amount) or in US dollars (usd), not both. Tokens are a ticker (SOL, USDC, BONK) or a mint address.",
    input_schema: {
      type: "object",
      properties: {
        sell: { type: "string", description: "Token to sell (pay with)." },
        buy: { type: "string", description: "Token to buy (receive)." },
        amount: { type: "number", description: "How much of the sell token." },
        usd: { type: "number", description: "How much to trade, in US dollars." },
      },
      required: ["sell", "buy"],
    },
  },
];

function system(me: User, today: string): string {
  return [
    "You are Dave, a friendly, concise assistant built into utopian-go, a search engine with a Solana wallet and a social network.",
    "You can chat about anything, search the web, look at the person's wallet, and propose token swaps on Solana.",
    `Today is ${today}. The person is signed in as @${me.name}; their wallet address is ${me.address}.`,
    "Keep replies short: a few sentences, plain text, no markdown headings or tables. Cite a source URL when you rely on a search.",
    "Trading rules: only propose a trade when the person asks for one. Check the wallet first. Propose at most one trade per reply.",
    "propose_trade only shows a card; the person must confirm it with their passkey, and the trade happens then. Never say a trade is done, sent or executed. Say you have prepared it and they can confirm below.",
    "If a token is ambiguous or not found, ask which one they mean. You give information, not financial advice.",
  ].join("\n");
}

async function claude(body: Record<string, unknown>): Promise<{ content: Block[]; stop_reason: string }> {
  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: DAVE_MODEL, max_tokens: 1024, ...body }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new SocialError(502, "Dave could not be reached. Try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { content?: Block[]; stop_reason?: string; error?: { message?: string } };
  if (res.status === 429 || res.status === 529) throw new SocialError(503, "Dave is busy. Try again in a minute.");
  if (!res.ok || !Array.isArray(data.content)) {
    console.warn(`[dave] anthropic responded ${res.status}:`, data.error?.message);
    throw new SocialError(502, "Dave could not answer. Try again.");
  }
  return { content: data.content, stop_reason: data.stop_reason ?? "" };
}

/** A ticker, name or mint to the token it most likely means. */
function findToken(query: string): { mint: string; symbol: string; price: number; decimals?: number } | null {
  const q = query.trim();
  if (!q) return null;
  if (/^\$?sol$/i.test(q)) {
    const rec = lookupMints([SOL_MINT]).get(SOL_MINT);
    return { mint: SOL_MINT, symbol: "SOL", price: rec?.price ?? 0, decimals: 9 };
  }
  if (solanaPubkey(q)) {
    const rec = lookupMints([q]).get(q);
    return { mint: q, symbol: rec?.symbol ?? q.slice(0, 4), price: rec?.price ?? 0, decimals: rec?.decimals };
  }
  const hit = searchTokens(q, 1)[0];
  return hit ? { mint: hit.mint, symbol: hit.symbol, price: hit.price, decimals: hit.decimals } : null;
}

/** Whole tokens to base units, without a float's tail. */
export function toBase(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e15) return 0n;
  const [whole, frac = ""] = amount.toFixed(Math.min(decimals, 12)).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

/** Base units to a short decimal string. */
export function fromBase(units: bigint, decimals: number): string {
  const text = units.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const frac = text.slice(text.length - decimals).replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
}

async function decimalsOf(mint: string, known?: number): Promise<number> {
  if (mint === SOL_MINT) return 9;
  try {
    return (await mintInfo(base58Decode(mint)!)).decimals;
  } catch {
    if (known != null) return known;
    throw new SocialError(503, "Could not read that token.");
  }
}

async function proposeTrade(input: Record<string, unknown>): Promise<Proposal> {
  const sell = findToken(String(input.sell ?? ""));
  const buy = findToken(String(input.buy ?? ""));
  if (!sell) throw new Error(`No token found for "${input.sell}".`);
  if (!buy) throw new Error(`No token found for "${input.buy}".`);
  if (sell.mint === buy.mint) throw new Error("Sell and buy are the same token.");
  const usd = Number(input.usd);
  let whole = Number(input.amount);
  if (!(whole > 0) && usd > 0) {
    if (!(sell.price > 0)) throw new Error(`No price for ${sell.symbol}; give the amount in ${sell.symbol}.`);
    whole = usd / sell.price;
  }
  if (!(whole > 0)) throw new Error("Give an amount to trade.");
  const [inDec, outDec] = await Promise.all([decimalsOf(sell.mint, sell.decimals), decimalsOf(buy.mint, buy.decimals)]);
  const amount = toBase(whole, inDec);
  if (amount <= 0n || amount >= 2n ** 64n) throw new Error("That amount is out of range.");

  const q = new URLSearchParams({
    inputMint: sell.mint,
    outputMint: buy.mint,
    amount: amount.toString(),
    slippageBps: String(SLIPPAGE_BPS),
  });
  // The same fee swapFor quotes with, so its fresh quote lands where this one did.
  if (feeAccount(sell.mint, buy.mint)) q.set("platformFeeBps", String(JUP_FEE_BPS));
  let res: Response;
  try {
    res = await jupFetch(`${JUP_SWAP_ENDPOINT}/quote?${q}`, { headers: { Accept: "application/json" } }, "trade", {
      timeoutMs: 10_000,
    });
  } catch (err) {
    throw new Error(err instanceof JupiterBusy ? "Jupiter is busy right now." : "Jupiter did not answer.");
  }
  const quote = (await res.json().catch(() => ({}))) as { outAmount?: string; error?: string };
  if (!res.ok || !/^\d{1,30}$/.test(String(quote.outAmount ?? ""))) {
    throw new Error(quote.error || "No route for this trade.");
  }
  const out = BigInt(quote.outAmount!);
  return {
    inputMint: sell.mint,
    outputMint: buy.mint,
    amount: amount.toString(),
    quotedOut: out.toString(),
    slippageBps: SLIPPAGE_BPS,
    sell: { symbol: sell.symbol, amount: fromBase(amount, inDec) },
    buy: { symbol: buy.symbol, amount: fromBase(out, outDec) },
    ...(sell.price > 0 ? { usd: Math.round(Number(fromBase(amount, inDec)) * sell.price * 100) / 100 } : {}),
  };
}

/** A question as the page sent it, trimmed; null if there is none. */
export function readQuestion(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim().slice(0, DAVE_CHARS) : "";
  return text || null;
}

/** A chat's name: its first question, shortened. */
export function titleOf(question: string): string {
  const line = question.replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * What Dave reads of a stored chat: its last turns, each a role and its text,
 * with a trade he prepared said in words, and whether it was confirmed.
 */
export function forModel(stored: DaveTurn[]): Turn[] {
  const turns: Turn[] = stored.slice(-DAVE_TURNS).map((t) => {
    let text = String(t.text ?? "");
    const p = t.trade as Proposal | undefined;
    if (p?.sell && p.buy) {
      const done = typeof t.done === "string" ? `Confirmed: ${t.done}` : "Not confirmed.";
      text += `\n[Prepared trade: sell ${p.sell.amount} ${p.sell.symbol} for about ${p.buy.amount} ${p.buy.symbol}. ${done}]`;
    }
    return { role: t.role === "assistant" ? "assistant" : "user", text: text.slice(-DAVE_CHARS * 3) || "…" };
  });
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

/** Dave's answer to the last question in `turns`, with any trade he prepared. */
export async function daveReply(me: User, turns: Turn[]): Promise<Reply> {
  if (!ANTHROPIC_API_KEY) throw new SocialError(503, "Dave is offline right now.");
  const messages: Message[] = turns.map((t) => ({ role: t.role, content: t.text }));
  const reply: Reply = { text: "" };
  const sys = system(me, new Date().toISOString().slice(0, 10));

  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const res = await claude({ system: sys, messages, tools: TOOLS, ...(last ? { tool_choice: { type: "none" } } : {}) });
    messages.push({ role: "assistant", content: res.content });
    reply.text = res.content
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (res.stop_reason !== "tool_use") break;

    const results: Block[] = [];
    for (const use of res.content) {
      if (use.type !== "tool_use") continue;
      let content: string;
      let isError = false;
      try {
        content = JSON.stringify(await runTool(me, use.name, use.input ?? {}, reply));
      } catch (err) {
        isError = true;
        content = err instanceof Error ? err.message : "That did not work.";
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  if (!reply.text) reply.text = reply.trade ? "Here's the trade. Confirm it below if it looks right." : "Sorry, I lost my train of thought.";
  return reply;
}

async function runTool(me: User, name: string, input: Record<string, unknown>, reply: Reply): Promise<unknown> {
  if (name === "web_search") {
    const query = String(input.query ?? "").slice(0, 200);
    if (!query) throw new Error("Empty query.");
    const found = await braveSearch(query);
    const results = found.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
    reply.sources = [...(reply.sources ?? []), ...results.map(({ title, url }) => ({ title, url }))].slice(0, 6);
    return results;
  }
  if (name === "wallet") {
    if (!me.address) throw new Error("This account has no wallet.");
    const book = await readBook(me.address);
    return {
      address: me.address,
      totalUsd: book.total,
      holdings: book.items.slice(0, 20).map((h) => ({
        symbol: h.symbol,
        mint: h.mint,
        amount: fromBase(BigInt(h.amount), h.decimals),
        usd: h.usd,
      })),
    };
  }
  if (name === "propose_trade") {
    if (reply.trade) throw new Error("One trade per reply.");
    reply.trade = await proposeTrade(input);
    return { shown: true, ...reply.trade, note: "Shown to the person as a card. Nothing happens until they confirm with their passkey." };
  }
  throw new Error(`Unknown tool ${name}.`);
}
