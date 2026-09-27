/**
 * The trade dialog — lazy-loaded entry point, exposed as `window.__swap`.
 *
 * Deliberately narrow: one side is always the token that was searched for, and
 * the other is always SOL or USDC. That is why this is ~5 KB where a general
 * swap widget is 300 KB — no token picker, no chart, no route inspector.
 *
 * Direction is reversible. Buying spends the quote token, selling returns to
 * it, and the fee lands in our referral account either way: Jupiter charges on
 * whichever side matches the fee account it is handed, so the SOL account
 * collects on `SOL → X` (input side) and on `X → SOL` (output side) alike.
 */
import { el } from "../js/dom.js";
import { load } from "../js/lazy.js";
// Dollars for someone who does not think in lamports. Shared with the wallet
// page rather than defined twice, so a balance reads the same in both places.
import { dollars as usd } from "../js/num.js";
import { renderPicker } from "../js/picker.js";
import { account } from "../js/me.js";
import { onSession, readSession, shortAddr } from "../js/session.js";
import { dialog } from "../js/ui.js";
import { restore, settled, signAndSend } from "../js/wallet.js";
import { build, quote, toBase58 } from "./jup.js";
import { injectFormStyles } from "./ui.js";

/**
 * Half a percent. Slippage is also how much a bot that sees the trade coming
 * can take from it, so at 1% every trade offered up to 1% on top of the fee.
 */
const SLIPPAGE_BPS = 50;
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * How often the confirmation screen re-prices the trade it is showing.
 *
 * A review step that quotes you once and then sits there is worse than no
 * review step: the numbers you agreed to are the ones you stopped looking at.
 * Fifteen seconds is well inside the window where a quote still builds.
 */
const REQUOTE_MS = 15_000;

/** Price impact at or above this reads as a warning rather than a detail. */
const HIGH_IMPACT_PCT = 1;

/** Lamports held back from MAX so the wallet can still pay network fees. */
const SOL_RESERVE = 10_000_000n;

/**
 * SOL a wallet needs to trade when it is spending something else: the network
 * fee, plus rent for a token account the trade may open. Below this the chain
 * refuses the trade, and says so in words nobody reads as "add SOL".
 */
const FEE_SOL = 3_000_000n;
const FEE_SOL_TEXT = "0.003";

/** Quick sizes, as percentages of what the wallet can spend. */
const PCTS = [5, 25, 50, 100];

/** How long to wait for a sent trade to land before calling it in flight. */
const LAND_MS = 60_000;

/** Tick for the completion disc. */
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** A wallet or RPC error that really means the wallet is out of SOL. */
const NO_SOL = /prior credit|insufficient lamports|InsufficientFundsForFee|insufficient funds for fee|AccountNotFound/i;

/**
 * How long to keep listening for a wallet before accepting that there is none.
 *
 * Only ever waited out when the answer is genuinely nothing — `settled`
 * resolves the moment a wallet registers, and an extension has registered long
 * before anyone reaches this code. The wait exists for a wallet's own in-app
 * browser, where the provider is injected with the page and may land a tick or
 * two after we announce ourselves. 400 ms is imperceptible against a wallet
 * that is about to open its own approval sheet, and it is the difference
 * between trading and being told there is no wallet while inside one.
 */
const SETTLE_MS = 400;

/** Is this a device where the wallet is an app rather than an extension? */
const handheld = () =>
  window.matchMedia("(pointer: coarse) and (hover: none)").matches;

/**
 * Wallets that will open a URL in their own in-app browser.
 *
 * This is the whole reason the hand-off is worth building. The alternative — the
 * deeplink protocols that ask a wallet to sign a transaction over an encrypted
 * round trip — needs an x25519 handshake and a nacl box per session, which is
 * more code than this entire bundle, and Phantom has since deprecated the
 * sign-and-send call it would be built on. Opening our own page inside the
 * wallet's browser needs no protocol at all: the wallet injects its provider
 * exactly as an extension does, js/wallet.js discovers it through the same
 * Wallet Standard handshake, and the trade is the one we would have built
 * anyway — referral account included. What today's jup.ag punt hands away, this
 * keeps.
 *
 * The templates are transcribed from each wallet's own documentation and the
 * path shapes are not interchangeable: Phantom takes no version segment,
 * Solflare and Backpack both require `v1` (Backpack's unversioned route never
 * resolves), and MetaMask takes a bare host with no scheme and no `ref`.
 *
 * NOT YET CONFIRMED ON A HANDSET. Every one of these is read from docs, not
 * observed working. The failure mode is a button that opens a wallet which then
 * fails to register — in which case this screen is where to look first.
 */
const LINKS = [
  { name: "Phantom", to: (u, r) => `https://phantom.app/ul/browse/${u}?ref=${r}` },
  { name: "Solflare", to: (u, r) => `https://solflare.com/ul/v1/browse/${u}?ref=${r}` },
  { name: "Backpack", to: (u, r) => `https://backpack.app/ul/v1/browse/${u}?ref=${r}` },
  // Bare host, and therefore the one link that cannot carry which token was
  // being traded. A visitor who takes it lands on the search page instead of
  // the dialog — degraded, not broken.
  { name: "MetaMask", to: () => `https://link.metamask.io/dapp/${location.host}` },
];

/** Quote tokens. Each has a referral token account, so each side can earn. */
const FUNDS = [
  { symbol: "SOL", mint: SOL_MINT, decimals: 9, key: "sol", fee: "faSol", preset: "1" },
  {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    key: "usdc",
    fee: "faUsdc",
    preset: "100",
  },
];

/**
 * How far the preset ladder may fall before we stop dividing. Four steps takes
 * SOL from 1 down to 0.0001 — past that the position is too small to pre-fill
 * and the "not enough" note is the honest answer.
 */
const LADDER_STEPS = 4;

/** Kept across dialogs so a second trade doesn't re-prompt the wallet. */
let session = null;

/**
 * Logging out in the header has to reach in here too.
 *
 * This bundle holds a live wallet object and a connected account, and neither
 * is stored anywhere the header can clear. Without this, Logout would empty
 * the corner of the page while the buy dialog went on quoting, signing and
 * displaying the address someone had just asked it to forget. The same check
 * covers an account switch: a session whose address no longer matches the
 * remembered one is not this visitor's session any more.
 */
onSession(() => {
  // The signed-in account's wallet is not the browser wallet this event is about.
  if (session?.custodial) return;
  const saved = readSession();
  if (!saved || saved.address !== session?.account?.address) session = null;
});

// —— base-unit arithmetic on strings ——
// Money must not round-trip through a float. 0.1 SOL is 100000000 lamports,
// not 100000000.00000001, and the difference is a rejected transaction.

/** @returns {string|null} base units, or null when the text isn't a number */
function toUnits(value, decimals) {
  const text = String(value).trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > decimals) return null;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = (whole + padded).replace(/^0+/, "");
  return digits === "" ? "0" : digits;
}

/** Exact decimal string from base units — used to fill the input. */
function toDecimal(raw, decimals) {
  const s = String(raw).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Rounded, human-facing amount. Display only — never fed back into a quote. */
function pretty(raw, decimals) {
  const n = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(n)) return "0";
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Data attributes the server writes onto the price strip, by fund key. */
const FUND_PRICE_ATTR = { sol: "solUsd", usdc: "usdcUsd" };

/** USD price of a quote token, or null when the index was not warm. */
function fundPrice(key) {
  const attr = FUND_PRICE_ATTR[key];
  const raw = attr && document.getElementById("hm-tk")?.dataset[attr];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The amount to assume before anyone types anything.
 *
 * A dialog that opens on an empty field asks a question; one that opens on
 * "1 SOL → 25,910,321 BONK" answers it. Start at the top of the ladder and
 * divide by ten until it fits what the wallet can spend, so the assumed
 * position is one the user could really take. `spendable` is null before a
 * wallet is connected, in which case the top of the ladder stands.
 */
function defaultAmount(preset, decimals, spendable) {
  let units = BigInt(toUnits(preset, decimals));
  if (spendable != null) {
    for (let i = 0; i < LADDER_STEPS && units > spendable; i++) units /= 10n;
  }
  return toDecimal(units.toString(), decimals);
}

/** The server re-quotes the same pair and amount for the account, then signs and sends. */
async function serverSwap(q) {
  const res = await fetch("/api/social/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      amount: q.inAmount,
      slippageBps: SLIPPAGE_BPS,
      // What this screen showed. The server's own quote may not pay less than
      // this, less the slippage, or it refuses instead of trading.
      quotedOut: q.outAmount,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.signature !== "string") {
    // A signature on an error means it was sent and failed on chain.
    throw Object.assign(new Error(data.error || "Swap failed."), { signature: data.signature });
  }
  return { signature: data.signature, confirmed: data.confirmed === true };
}

/**
 * Wait for a trade a browser wallet broadcast to land, asking our server,
 * which holds the RPC key. Resolves "pending" rather than throwing when the
 * lookup itself fails: the trade may well be fine.
 *
 * @returns {Promise<{status: "confirmed"} | {status: "failed", error: string} | {status: "pending"}>}
 */
async function landed(signature) {
  const end = Date.now() + LAND_MS;
  while (Date.now() < end) {
    try {
      const res = await fetch("/api/tx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ signature }),
      });
      const data = await res.json();
      if (data?.status === "confirmed" || data?.status === "failed") return data;
    } catch {
      // Keep asking; one dropped poll says nothing about the trade.
    }
    await new Promise((r) => setTimeout(r, 1_200));
  }
  return { status: "pending" };
}

/**
 * @param {{mint: string, symbol: string, decimals?: number, fallback: string}} t
 */
function open(t) {
  /**
   * Teardown owed by whichever screen is mounted — the confirmation one keeps
   * a re-quote timer running, and Escape or the backdrop closes the dialog out
   * from under it without going through its own Back button.
   */
  let cleanup = null;
  /**
   * Whether this dialog ever put a transaction on the wire.
   *
   * Handed to the caller on close so a page showing balances knows whether it
   * has anything to re-read. Deliberately not "did the trade succeed": a trade
   * that reverted on chain still spent its fee, and that is worth re-reading too.
   */
  let sent = false;
  const { body, close, setTitle } = dialog(`Trade ${t.symbol}`, () => {
    cleanup?.();
    cleanup = null;
    t.onClose?.(sent);
  });
  // Buying SOL cannot be funded with SOL, and vice versa for USDC.
  const funds = FUNDS.filter((f) => f.mint !== t.mint);
  /** The searched token's USD price, carried in from the card. */
  const tokenUsd = Number.isFinite(t.price) ? t.price : null;
  // Selling means converting a typed amount of the token into base units,
  // which needs its decimals. Records from an older snapshot may lack them.
  const canSell = t.decimals != null;

  let fund = funds[0];
  // The wallet page opens this straight into a sell from a position's minus
  // button; everywhere else a trade starts as a buy. Selling needs the mint's
  // decimals to turn a typed amount into base units, so a request to sell
  // something we cannot size falls back to buying rather than to a dead form.
  let mode = t.mode === "sell" && t.decimals != null ? "sell" : "buy";
  let typed = "";
  let balances = {};
  /** Once someone edits the field, stop replacing it with assumed positions. */
  let touched = false;

  form();

  // A wallet remembered from a previous visit is re-authorised without a
  // prompt, so the dialog arrives already connected — real quotes, a real
  // balance, and no Connect step in front of any of it. Deliberately not
  // awaited: the form is on screen and priced from the page's own numbers
  // while this runs, and it repaints only if a wallet actually answers.
  // A signed-in account trades from its own wallet, which the server signs for.
  if (!session?.custodial) {
    void account().then(async (me) => {
      if (!body.isConnected) return;
      if (me) {
        session = { custodial: true, account: { address: me.address } };
        form();
        return;
      }
      if (session) return;
      const found = await restore();
      if (!found || session || !body.isConnected) return;
      session = found;
      form();
    });
  }

  /** Wallet chooser, shown only when connecting needs a choice. */
  function picker(found) {
    setTitle("Connect a wallet");
    renderPicker(body, found, (picked) => {
      session = picked;
      form();
    });
  }

  /**
   * The URL that reopens this trade somewhere else.
   *
   * Carries the mint and nothing more. js/url.js reads it back at boot and
   * js/token.js opens the dialog on the card it names, so a scan or a tap lands
   * on the trade rather than on a search page with the trade one click further
   * on. See url.js for why an amount must never be added to it: this string is
   * handed to a wallet's own domain on the way through and written to its logs
   * and ours, and what someone was about to spend is a fact about them.
   */
  function tradeUrl() {
    const p = new URLSearchParams({ q: t.symbol, buy: t.mint });
    return `${location.origin}/?${p}`;
  }

  /**
   * How to reach a wallet this browser has not got.
   *
   * Two audiences, one screen, because they are the same problem approached
   * from opposite ends. On a desktop the wallet is on a phone somewhere in the
   * room, and the only thing a web page can hand a phone is something its
   * camera can read. On a phone the wallet is an app on this very device, and
   * the only thing that reaches inside it is its own deeplink — while a QR
   * drawn there would be a code asking to be scanned by the screen displaying
   * it. So the screen shows whichever crossing can actually be made from here,
   * and never both.
   *
   * The two meet in the middle: a phone that scans the desktop's code arrives
   * in its own browser, where no wallet is injected either — and gets this same
   * screen, now showing the wallet links. That second step is the one that ends
   * inside a wallet, which is the only place the trade can be signed.
   */
  async function handoff() {
    const url = tradeUrl();
    const back = el("button", {
      class: "swx-2nd",
      type: "button",
      text: "Back",
      onclick: form,
    });
    // The floor, and the only rung that never depends on a wallet being
    // installed. It earns us nothing, which is exactly why it is last.
    const floor = el("a", {
      class: "swx-acct",
      href: t.fallback,
      target: "_blank",
      rel: "noopener",
      style: "display:block;text-align:center;margin-top:12px",
      text: "Or trade on Jupiter",
    });

    if (handheld()) {
      setTitle("Open in a wallet");
      const list = el("div");
      const ref = encodeURIComponent(location.origin);
      const enc = encodeURIComponent(url);
      for (const w of LINKS) {
        list.append(
          el("a", { class: "swx-lnk", href: w.to(enc, ref), text: w.name }),
        );
      }
      body.replaceChildren(
        el("div", {
          class: "swx-note",
          text: `Opens ${t.symbol} inside your wallet's browser, where the trade can be signed.`,
        }),
        list,
        back,
        floor,
      );
      return;
    }

    setTitle("Open on your phone");
    const holder = el("div", { class: "swx-qr" });
    body.replaceChildren(
      el("div", {
        class: "swx-note",
        text: `Scan with your phone's camera to trade ${t.symbol} there.`,
      }),
      holder,
      back,
      floor,
    );
    try {
      const qr = await load("qr", "__qr");
      // Generated markup, every value of it a number this bundle produced —
      // the same way the price cards inline their sparklines.
      holder.innerHTML = qr.svg(url);
    } catch {
      holder.replaceChildren(
        el("div", { class: "swx-note err", text: "Could not draw the code." }),
      );
    }
  }

  // —— the trade form: shown immediately, quotes without a wallet ——

  function form() {
    cleanup?.();
    cleanup = null;
    // Here rather than at module load: the chooser may be the only screen this
    // dialog ever shows, and its styles are in the shared sheet.
    injectFormStyles();
    setTitle(`Trade ${t.symbol}`);
    body.replaceChildren();
    const buying = mode === "buy";
    const feeAccount = document.body.dataset[fund.fee] || "";
    const feeBps = feeAccount ? Number(document.body.dataset.fee) || 0 : 0;

    // Which token sits on each side. The searched token is `t`; the other side
    // is always the selected quote token.
    const pay = buying
      ? { symbol: fund.symbol, mint: fund.mint, decimals: fund.decimals, key: fund.key }
      : { symbol: t.symbol, mint: t.mint, decimals: t.decimals, key: "token" };
    const recv = buying
      ? { symbol: t.symbol, decimals: t.decimals, key: "token" }
      : { symbol: fund.symbol, decimals: fund.decimals, key: fund.key };
    const reserve = pay.mint === SOL_MINT ? SOL_RESERVE : 0n;

    let current = null;
    let inflight = null;
    let busy = false;
    /**
     * The balance lookup was refused, so `balances` is empty for a reason that
     * is not "this wallet holds nothing".
     *
     * Kept as form state rather than announced once, because the announcement
     * cannot survive: `note` belongs to the quote, which repaints it on every
     * keystroke and every refresh. An unknown balance has to stay legible for
     * as long as it is unknown — it is the whole reason the "Not enough" check
     * below is not running.
     */
    let balanceUnknown = false;
    /** Why the amount cannot be traded, for the button to say instead of "Review". */
    let blocked = "";

    const balance = el("button", { class: "swx-bal", type: "button", text: "Balance —" });
    const amount = el("input", {
      class: "swx-amt",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "0.0",
      "aria-label": `Amount of ${pay.symbol} to ${buying ? "spend" : "sell"}`,
    });
    const receive = el("div", { class: "swx-recv dim", text: "0.0" });
    const action = el("button", {
      class: `swx-go${buying ? "" : " sell"}`,
      type: "button",
    });
    /**
     * The way out of this browser, standing next to the way through it.
     *
     * Beside Buy rather than behind it because the people who need it are
     * exactly the people for whom Buy does nothing — no extension here, or no
     * extension possible — and a control they have to fail first to discover is
     * a control most of them never will. Its label is the crossing that can be
     * made from this device: a code to carry the trade to a phone, or a link to
     * carry it into a wallet. See handoff().
     */
    const bridge = el("button", {
      class: "swx-2nd",
      type: "button",
      text: handheld() ? "Open in wallet" : "Use QR Code",
      onclick: handoff,
    });
    const note = el("div", { class: "swx-note" });

    // Sizing from the balance, inside the pane the amount is typed into.
    const chips = PCTS.map((pct) =>
      el("button", {
        type: "button",
        text: `${pct}%`,
        "aria-label": `${pct}% of your ${pay.symbol}`,
        onclick: () => sizeTo(pct),
      }),
    );

    /** Segmented SOL/USDC control; lives on whichever side the quote token is. */
    function quoteControl() {
      const seg = el("div", {
        class: "swx-seg",
        role: "group",
        "aria-label": buying ? "Pay with" : "Receive",
      });
      for (const f of funds) {
        seg.append(
          el("button", {
            type: "button",
            text: f.symbol,
            class: f === fund ? "on" : "",
            onclick: () => {
              if (fund === f) return;
              fund = f;
              // Amounts don't carry across a currency change — 0.5 SOL and
              // 0.5 USDC are two very different orders.
              typed = "";
              touched = false;
              form();
            },
          }),
        );
      }
      return seg;
    }

    const lock = () => el("span", { class: "swx-lock", text: t.symbol });

    const flip = el("button", {
      class: `swx-flip${buying ? "" : " up"}`,
      type: "button",
      text: "↓",
      title: buying ? `Sell ${t.symbol} instead` : `Buy ${t.symbol} instead`,
      "aria-label": buying ? `Switch to selling ${t.symbol}` : `Switch to buying ${t.symbol}`,
      onclick: () => {
        mode = buying ? "sell" : "buy";
        typed = "";
        touched = false;
        form();
      },
    });
    if (!canSell) {
      flip.disabled = true;
      flip.title = "Sell unavailable for this token";
    }

    body.append(
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: "You pay" }), balance),
        el("div", { class: "swx-body" }, buying ? quoteControl() : lock(), amount),
        el("div", { class: "swx-pct", role: "group", "aria-label": "Size from balance" }, ...chips),
      ),
      el("div", { class: "swx-arrow" }, flip),
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: "You receive" })),
        el("div", { class: "swx-body" }, buying ? lock() : quoteControl(), receive),
      ),
      el("div", { class: "swx-act" }, action, bridge),
      note,
    );
    if (session) {
      body.append(
        el("div", {
          class: "swx-acct",
          style: "text-align:center;margin-top:8px",
          text: shortAddr(session.account.address),
        }),
      );
    }

    // Open on an assumed position so the conversion is on screen immediately.
    if (!typed) typed = assume();
    amount.value = typed;

    // Focus selects the assumed amount so typing replaces it outright. Skipped
    // on narrow screens: the position is already filled in, and throwing up a
    // keyboard over the answer helps nobody.
    if (window.matchMedia("(min-width: 521px)").matches) {
      amount.focus();
      amount.select();
    }
    label();
    showBalance();
    if (session) loadBalances();
    refresh();

    // —— helpers ——

    function setNote(text, kind) {
      note.textContent = text || "";
      note.className = `swx-note${kind ? ` ${kind}` : ""}`;
    }

    function spendable() {
      const raw = balances[pay.key];
      if (raw == null) return null;
      const left = BigInt(raw) - reserve;
      return left > 0n ? left : 0n;
    }

    /**
     * Base units of one side, in dollars.
     *
     * The searched token is priced by the card that opened this dialog; the
     * other side is always SOL or USDC, priced by the strip the server renders.
     * Both come from the same index the quote does, so the two sides are
     * comparable rather than one being an oracle and one a market.
     */
    function toUsd(side, units) {
      const price = side.key === "token" ? tokenUsd : fundPrice(side.key);
      if (price == null || side.decimals == null) return NaN;
      return (Number(units) / 10 ** side.decimals) * price;
    }

    /**
     * What this trade is worth, worked out from prices the page already has.
     *
     * Used only before a wallet is connected, and it is what lets that be true:
     * the dialog opens already answering "what would I get", and the honest way
     * to answer it at that moment is with the numbers the server already sent —
     * the card's own price and the ticker's — rather than by asking a third
     * party about a visitor who has agreed to nothing. No route, no slippage,
     * no price impact; those need a real quote, and a real quote is what the
     * connected form fetches a moment later.
     *
     * @returns {number|null} base units of the receive side, or null if either
     *   side is unpriced — in which case the field says so rather than guessing.
     */
    function estimate(units) {
      const spent = toUsd(pay, units);
      const price = recv.key === "token" ? tokenUsd : fundPrice(recv.key);
      if (!Number.isFinite(spent) || price == null || recv.decimals == null) {
        return null;
      }
      return (spent / price) * 10 ** recv.decimals;
    }

    /**
     * Buying assumes a fixed position sized to the wallet; selling assumes the
     * whole holding, since exiting a position usually means exiting it.
     */
    function assume() {
      if (buying) return defaultAmount(fund.preset, fund.decimals, spendable());
      const held = spendable();
      return held != null && held > 0n ? toDecimal(held.toString(), pay.decimals) : "";
    }

    /** Base units for `pct` of what can be spent, or null before a balance is known. */
    function sizeAt(pct) {
      const max = spendable();
      if (max == null || max === 0n) return null;
      return pct === 100 ? max : (max * BigInt(pct)) / 100n;
    }

    function sizeTo(pct) {
      const units = sizeAt(pct);
      if (units == null || units === 0n) return;
      amount.value = toDecimal(units.toString(), pay.decimals);
      typed = amount.value;
      touched = true;
      refresh();
    }

    /** Enable the sizes once there is a balance to size from, and mark the one typed. */
    function markChips() {
      const units = toUnits(amount.value, pay.decimals);
      PCTS.forEach((pct, i) => {
        const size = sizeAt(pct);
        const b = chips[i];
        b.disabled = size == null || size === 0n;
        b.title = !session ? "Connect a wallet to size from your balance" : "";
        b.classList.toggle("on", size != null && size.toString() === units);
      });
    }

    /**
     * Spending USDC or a token still costs SOL: the network fee is only ever
     * paid in SOL. Null when there is enough, or when we cannot tell.
     */
    function solShortfall() {
      if (pay.mint === SOL_MINT || balances.sol == null) return null;
      const have = BigInt(balances.sol);
      return have < FEE_SOL ? have : null;
    }

    function showBalance() {
      markChips();
      // Nothing to show before a wallet is connected, and an empty "Balance —"
      // reads like a zero rather than an unknown.
      balance.hidden = !session;
      const raw = balances[pay.key];
      balance.textContent = balanceUnknown
        ? "Balance unknown"
        : raw == null
          ? "Balance —"
          : `Balance ${pretty(raw, pay.decimals)}`;
    }

    async function startConnect() {
      busy = true;
      action.disabled = true;
      action.classList.add("busy");
      action.textContent = "Looking for a wallet…";
      // Asking rather than glancing. The old synchronous read was correct for
      // an extension and wrong everywhere else; see settled() in js/wallet.js.
      const found = await settled(SETTLE_MS);
      // The dialog can be dismissed, or the form rebuilt by a flip, while we
      // wait. Everything below writes to a form that may no longer be on
      // screen, so it is checked once here rather than in each branch.
      if (!action.isConnected) return;

      if (!found.length) {
        // Was: a note, then window.open(jup.ag) on an 800 ms timer, then close.
        // Three things wrong with it. The timer never looked for a wallet
        // again, so one that registered at t+50 ms was punted anyway. The
        // window.open fired 800 ms after the click, outside the user-activation
        // window, so Safari swallowed it while close() ran regardless and the
        // visitor was left with nothing at all. And the destination earns no
        // referral, which made the worst-handled path also the only unpaid one.
        //
        // The hand-off screen replaces all of it: every route out of here is
        // now something the visitor clicks, which is its own user activation,
        // and the two routes that reach a wallet keep the fee.
        return handoff();
      }
      if (found.length > 1) return picker(found);

      // busy, disabled and the spinner are already on from the search above.
      action.textContent = "Check your wallet…";
      try {
        session = { wallet: found[0], account: await connect(found[0]) };
        form();
      } catch (err) {
        setNote(err?.message || "Connection declined.", "err");
        busy = false;
        label();
      }
    }

    async function loadBalances() {
      try {
        // POSTed rather than queried. A wallet address in a query string is
        // written to the hosting provider's request log beside the caller's IP,
        // which is how a site that keeps no user records ends up holding a
        // record of who owns which wallet. A body is not logged.
        const res = await fetch("/api/balances", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            owner: session.account.address,
            mint: t.mint,
          }),
        });
        // Every way this can fail means the same thing to the form — throttled,
        // upstream error, dropped connection, unreadable body — so they are
        // funnelled into one handler below rather than each being given its
        // own. A lookup that did not happen must never be mistaken for one that
        // came back empty: `balances` stays {}, `spendable()` returns null, and
        // the "Not enough" check silently stops running.
        if (!res.ok) throw new Error(`balances ${res.status}`);
        const data = await res.json();
        if (data?.error) throw new Error(data.error);
        balanceUnknown = false;
        // The reply outlived the screen that asked for it. `typed` is read by
        // the confirmation screen's re-quote, so writing it here would change
        // the size of a trade someone is in the middle of agreeing to — the
        // balance itself is still worth keeping, the assumed position is not.
        if (!receive.isConnected) {
          balances = data;
          return;
        }
        balances = data;
        showBalance();
        // Now that the wallet's actual depth is known, revise the assumed
        // position — unless the user already put their own number in.
        if (!touched) {
          const next = assume();
          if (next !== typed) {
            typed = next;
            amount.value = next;
            refresh();
          }
        }
      } catch {
        // Unknown is not zero: leave the field usable and let Jupiter decide —
        // but do not let a check that never ran read as one that passed.
        balanceUnknown = true;
        if (!receive.isConnected) return;
        showBalance();
        // The quote may already have painted its note before this failed, so
        // restate it rather than re-quoting to say the same thing.
        if (current) setNote(quoteNote());
      }
    }

    /** The standing note for a priced form: slippage, plus any live caveat. */
    function quoteNote() {
      const slippage = `${SLIPPAGE_BPS / 100}% max slippage`;
      return balanceUnknown
        ? `${slippage} — balance unknown, check you can cover this`
        : slippage;
    }

    function label() {
      if (busy) return;
      if (!session) {
        // The quote is already on screen; connecting is the next step, not a
        // gate in front of seeing what you'd get.
        action.textContent = "Connect wallet";
        action.disabled = false;
      } else {
        // Naming the review rather than the trade: the next screen is where
        // the trade is actually agreed to, and it carries the verb.
        action.textContent = current
          ? `Review ${buying ? "buy" : "sell"}`
          : blocked || "Enter an amount";
        action.disabled = !current;
      }
      action.classList.remove("busy");
    }

    async function refresh() {
      // The confirmation screen replaces the form's nodes but not its closures,
      // so an /api/balances reply that lands late can still reach this and
      // re-price the trade underneath a screen the user is reading — and
      // `current` is what the Buy button signs. Detachment is the reliable
      // signal that this form is no longer the mounted screen.
      if (!receive.isConnected) return;
      inflight?.abort();
      current = null;
      blocked = "";
      markChips();
      const units = toUnits(amount.value, pay.decimals);

      if (!units || units === "0") {
        receive.textContent = "0.0";
        receive.className = "swx-recv dim";
        setNote("");
        label();
        return;
      }

      const max = spendable();
      if (max != null && BigInt(units) > max) {
        receive.textContent = "0.0";
        receive.className = "swx-recv dim";
        setNote(`Not enough ${pay.symbol}.`, "err");
        blocked = `Not enough ${pay.symbol}`;
        label();
        return;
      }

      const short = solShortfall();
      if (short != null) {
        receive.textContent = "0.0";
        receive.className = "swx-recv dim";
        setNote(
          `Not enough SOL for network fees. Keep about ${FEE_SOL_TEXT} SOL in this wallet to trade — it has ${pretty(short, 9)} SOL.`,
          "err",
        );
        blocked = "Add SOL for fees";
        label();
        return;
      }

      // Nothing has been connected, so nothing about this visitor goes anywhere
      // for a number that is only here to start the conversation. The estimate
      // comes off prices the page already carries; the real quote is fetched
      // the moment there is a wallet to trade with, which is also the moment
      // Jupiter becomes a party to the trade rather than a stranger being told
      // about one. `current` stays null, so nothing signable is ever built from
      // an estimate.
      if (!session) {
        const out = estimate(units);
        receive.textContent = out == null ? "—" : pretty(out, recv.decimals);
        receive.className = out == null ? "swx-recv dim" : "swx-recv";
        setNote("Estimate — connect a wallet to price this trade");
        label();
        return;
      }

      receive.textContent = "…";
      receive.className = "swx-recv dim";
      const controller = new AbortController();
      inflight = controller;
      try {
        const q = await quote({
          input: pay.mint,
          output: buying ? t.mint : fund.mint,
          amount: units,
          slippageBps: SLIPPAGE_BPS,
          feeBps,
          signal: controller.signal,
        });
        // Detachment is re-checked here as well as on entry: a quote in flight
        // when the confirmation screen mounts would otherwise land afterwards
        // and replace `current` — the very object the Buy button signs — with
        // one whose figures were never shown to anyone.
        if (controller !== inflight || !receive.isConnected) return;
        current = q;
        receive.textContent =
          recv.decimals != null ? pretty(q.outAmount, recv.decimals) : "—";
        receive.className = "swx-recv";
        // The slippage line owns this element on every quote, so an unknown
        // balance has to ride along with it or be erased by it — see quoteNote.
        setNote(quoteNote());
      } catch (err) {
        if (controller !== inflight || err?.name === "AbortError") return;
        receive.textContent = "0.0";
        receive.className = "swx-recv dim";
        setNote(err?.message || "No route for that amount.", "err");
      } finally {
        label();
      }
    }

    let debounce;
    amount.addEventListener("input", () => {
      typed = amount.value;
      touched = true;
      markChips();
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 250);
    });

    balance.addEventListener("click", () => {
      const max = spendable();
      if (max == null || max === 0n) return;
      amount.value = toDecimal(max.toString(), pay.decimals);
      typed = amount.value;
      touched = true;
      refresh();
    });

    action.addEventListener("click", () => {
      if (busy) return;
      if (!session) return startConnect();
      if (!current) return;
      review();
    });

    // —— the confirmation screen: the same trade, priced and itemised ——

    /**
     * Everything the form showed, restated as figures that do not move while
     * being read, plus the ones the form had no room for: what the trade can
     * settle at in the worst allowed case, what it moves the pool by, and
     * which route it takes.
     *
     * The quote is re-fetched on a timer here rather than frozen. A stale
     * confirmation is the failure mode this screen exists to prevent — asking
     * someone to agree to a number and then sending a different one.
     */
    function review() {
      setTitle(`Confirm ${buying ? "buy" : "sell"}`);
      body.replaceChildren();

      let sending = false;
      let done = false;
      let timer = null;
      let pending = null;

      const payAmt = el("div", { class: "swx-recv" });
      const recvAmt = el("div", { class: "swx-recv" });
      // The dollar figures above are our own index's valuation; these are the
      // quantities the transaction actually moves, read straight off the quote
      // being signed. Both belong on screen: dollars are what the trade means,
      // token amounts are what it does, and only the second is what the wallet
      // will be asked to approve.
      const payUnits = el("div", { class: "swx-sub" });
      const recvUnits = el("div", { class: "swx-sub" });
      const rows = el("div", { class: "swx-sum" });
      const rnote = el("div", { class: "swx-note" });
      const go = el("button", {
        class: `swx-go${buying ? "" : " sell"}`,
        type: "button",
        text: `${buying ? "Buy" : "Sell"} ${t.symbol}`,
      });
      const back = el("button", { class: "swx-2nd", type: "button", text: "Back" });

      const leave = () => {
        clearInterval(timer);
        timer = null;
        pending?.abort();
        pending = null;
      };
      cleanup = leave;

      const setRNote = (text, kind) => {
        rnote.textContent = text || "";
        rnote.className = `swx-note${kind ? ` ${kind}` : ""}`;
      };

      const detail = (key, value, warn) =>
        el(
          "div",
          { class: "swx-row" },
          el("span", { class: "swx-k", text: key }),
          el("span", { class: `swx-v${warn ? " warn" : ""}`, text: value }),
        );

      /** Base units and symbol, e.g. "1.0000 SOL". Empty when decimals are unknown. */
      function units(side, raw) {
        return side.decimals == null ? "" : `${pretty(raw, side.decimals)} ${side.symbol}`;
      }

      /**
       * One side of the trade, on the two lines the pane gives it.
       *
       * Dollars lead and the quantity sits under them: dollars are what the
       * trade means, the quantity is what it does, and both belong on screen.
       *
       * Unless we hold no price for that side, which for a mint created this
       * morning is the ordinary case and not the exotic one. The dollar line
       * then printed "—" while the quantity — exact, and the figure the wallet
       * is actually about to be asked to approve — sat in the small grey line
       * underneath, so the one question a confirmation screen exists to answer
       * was answered in the quietest text in the pane and contradicted by the
       * loudest. The quantity is promoted into the headline in that case, and
       * the line beneath it is dropped rather than left repeating it.
       *
       * @param {HTMLElement} head the large line
       * @param {HTMLElement} sub the quiet line under it
       * @param {{symbol: string, decimals?: number, key: string}} side
       * @param {string} raw base units of that side, off the quote
       * @param {number} value the same amount in dollars, or NaN
       */
      function stateSide(head, sub, side, raw, value) {
        const qty = units(side, raw);
        const priced = Number.isFinite(value);
        head.className = `swx-recv${priced ? "" : " qty"}`;
        // A dash only when there is neither a price nor the decimals to state
        // a quantity with — nothing is known about this side's size at all.
        head.textContent = priced ? usd(value) : qty || "—";
        sub.textContent = priced ? qty : "";
        sub.hidden = !sub.textContent;
      }

      /**
       * A floor, stated as a floor.
       *
       * `pretty` rounds to nearest, which is right for a figure that only has
       * to read well and wrong for this one: rounding 1.23456 up to 1.2346
       * prints a minimum fractionally *above* the amount the chain will
       * actually enforce, so the one number on the screen that carries a
       * promise would be the one number that could be short. Truncating can
       * only ever understate it.
       */
      function atLeast(side, raw) {
        if (side.decimals == null) return "";
        const exact = toDecimal(String(raw), side.decimals);
        const [whole, frac = ""] = exact.split(".");
        // Same visual precision as pretty(), reached by dropping digits rather
        // than by rounding them.
        const n = Number(exact);
        const keep = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
        const cut = frac.slice(0, keep).replace(/0+$/, "");
        const grouped = Number(whole).toLocaleString("en-US");
        return `${cut ? `${grouped}.${cut}` : grouped} ${side.symbol}`;
      }

      function paint(q) {
        // Jupiter's valuation of the input side leads, and ours is the fallback
        // — the opposite way round from how this started, for a reason worth
        // stating. Our figure comes from the price strip the server rendered
        // into the page, and that strip is written once at page load and never
        // touched again: the SPA navigates with pushState, so a tab left open
        // all day still converts at breakfast's SOL price. `swapUsdValue` rides
        // on the quote itself and is therefore exactly as fresh as the trade it
        // is describing. Ours is still worth keeping for the case Jupiter omits
        // it, which is the case it was written for.
        const quoted = Number(q.swapUsdValue);
        const spend = toUsd(pay, q.inAmount);
        const paid = Number.isFinite(quoted) && quoted > 0 ? quoted : spend;
        const got = toUsd(recv, q.outAmount);

        stateSide(payAmt, payUnits, pay, q.inAmount, paid);
        stateSide(recvAmt, recvUnits, recv, q.outAmount, got);

        // Impact is a fraction from Jupiter, and it is only worth a row when
        // it is large enough to cost real money — as money, not as basis points.
        const impact = Number(q.priceImpactPct) * 100;
        const costly = impact >= HIGH_IMPACT_PCT && Number.isFinite(paid);

        // Stated in tokens, not dollars. This is the one number on the screen
        // the chain actually enforces — the transaction reverts below it — and
        // converting it through our own price index would restate a hard
        // guarantee as an estimate that moves with a number we control.
        const least = atLeast(recv, q.otherAmountThreshold);

        rows.replaceChildren(
          // The quote's platformFee.amount names the wrong mint often enough
          // that the rate is the only part worth trusting — see
          // JUP_FEE_ACCOUNT_SOL — so the charge is worked out from it here.
          ...(feeBps > 0
            ? [detail("Fee", usd(paid * (feeBps / 10000)))]
            : []),
          ...(costly
            ? [detail("Cost of moving the price", usd(paid * (impact / 100)), true)]
            : []),
          ...(least ? [detail("Guaranteed minimum", least)] : []),
          detail("Wallet", shortAddr(session.account.address)),
        );
      }

      /** Re-price what is on screen. Silent on success, explicit on failure. */
      async function requote() {
        if (sending || done) return;
        const units = toUnits(typed, pay.decimals);
        if (!units || units === "0") return;

        pending?.abort();
        const controller = new AbortController();
        pending = controller;
        try {
          const q = await quote({
            input: pay.mint,
            output: buying ? t.mint : fund.mint,
            amount: units,
            slippageBps: SLIPPAGE_BPS,
            feeBps,
            signal: controller.signal,
          });
          if (controller !== pending || sending || done) return;
          current = q;
          paint(q);
          setRNote("");
        } catch (err) {
          if (controller !== pending || err?.name === "AbortError") return;
          // Keep the last good figures on screen, but stop implying they are
          // current — the button still works, and Jupiter re-checks on build.
          setRNote("Could not refresh the price. Figures may be stale.", "err");
        }
      }

      body.append(
        el(
          "div",
          { class: "swx-pane" },
          el("div", { class: "swx-lbl" }, el("span", { text: "You pay" })),
          el(
            "div",
            { class: "swx-body" },
            el("span", { class: "swx-lock", text: pay.symbol }),
            payAmt,
          ),
          payUnits,
        ),
        el(
          "div",
          { class: "swx-arrow" },
          el("span", { class: "swx-flip static", "aria-hidden": "true", text: "↓" }),
        ),
        el(
          "div",
          { class: "swx-pane" },
          el("div", { class: "swx-lbl" }, el("span", { text: "You receive" })),
          el(
            "div",
            { class: "swx-body" },
            el("span", { class: "swx-lock", text: recv.symbol }),
            recvAmt,
          ),
          recvUnits,
        ),
        rows,
        go,
        back,
        rnote,
      );

      paint(current);
      go.focus();
      timer = setInterval(requote, REQUOTE_MS);

      back.addEventListener("click", () => {
        if (sending) return;
        // Once something has been sent this button reads "Done", and done means
        // done: the trade is on the wire, and dropping back into a form still
        // holding the amount just traded is an invitation to send it twice.
        //
        // Closing is also what tells the opener anything happened — the dialog
        // hands `sent` to its onClose, which is the signal the wallet page waits
        // on before it starts watching for the new balance. Going back to the
        // form instead left that page showing pre-trade figures until whenever
        // the dialog was eventually dismissed.
        if (done) return close();
        leave();
        form();
      });

      /**
       * The trade landed: the whole dialog becomes one green disc and what
       * happened, so there is no reading a note under a button to find out.
       */
      function complete(sig, q) {
        cleanup = null;
        setTitle(buying ? "Bought" : "Sold");
        const disc = el("div", { class: "swx-check", role: "img", "aria-label": "Trade complete" });
        disc.innerHTML = CHECK_SVG;
        const gotQty = units(recv, q.outAmount);
        const paidQty = units(pay, q.inAmount);
        const finish = el("button", { class: "swx-go", type: "button", text: "Done", onclick: close });
        body.replaceChildren(
          el(
            "div",
            { class: "swx-done" },
            disc,
            el("div", { class: "swx-done-t", text: buying ? `You bought ${t.symbol}` : `You sold ${t.symbol}` }),
            // Quoted, not read back off the chain — it can only be at or above
            // the guaranteed minimum, hence "about".
            gotQty && paidQty
              ? el("div", { class: "swx-done-s", text: `About ${gotQty} for ${paidQty}` })
              : null,
            el(
              "div",
              { class: "swx-done-s" },
              el("a", {
                href: `https://solscan.io/tx/${sig}`,
                target: "_blank",
                rel: "noopener",
                text: "View transaction",
              }),
            ),
          ),
          finish,
        );
        finish.focus();
      }

      /** An error, in the terms someone can act on. */
      function explain(err) {
        const message = err?.message ?? "";
        if (NO_SOL.test(message)) {
          return `Not enough SOL for network fees. Keep about ${FEE_SOL_TEXT} SOL in this wallet to trade.`;
        }
        if (/0x1771|slippage/i.test(message)) return "The price moved. Review the trade and try again.";
        if (!session?.custodial && /reject|denied|cancel|user/i.test(message)) return "Cancelled.";
        return message || "Swap failed.";
      }

      go.addEventListener("click", async () => {
        if (sending || done) return;
        sending = true;
        // Nothing may re-price under a transaction that is being signed.
        leave();
        // The figures on screen, kept for the completion screen: `current`
        // is cleared below, and the next re-quote would replace it anyway.
        const q = current;
        go.disabled = true;
        go.classList.add("busy");
        go.textContent = session.custodial ? "Sending…" : "Confirm in wallet…";
        back.disabled = true;
        setRNote("");

        try {
          let sig;
          let status;
          if (session.custodial) {
            // The server answers once the trade has landed, or has stopped waiting.
            const r = await serverSwap(q);
            sig = r.signature;
            status = r.confirmed ? { status: "confirmed" } : { status: "pending" };
          } else {
            sig = toBase58(
              await signAndSend(
                session.wallet,
                session.account,
                await build({ quote: q, taker: session.account.address, feeAccount }),
              ),
            );
            sent = true;
            go.textContent = "Confirming…";
            status = await landed(sig);
          }
          sent = true;
          if (status.status === "failed") throw new Error(status.error);
          done = true;
          current = null;
          // Re-arm sized to what's left, so trading again is one click.
          touched = false;
          typed = "";
          if (status.status === "confirmed") return complete(sig, q);

          // Broadcast, but not seen landing within the wait. Not a failure —
          // a congested network can take longer — so say what is known and
          // hand over the link that settles it.
          rnote.replaceChildren(
            "Sent — still confirming. ",
            el("a", {
              href: `https://solscan.io/tx/${sig}`,
              target: "_blank",
              rel: "noopener",
              text: "Check the transaction",
            }),
          );
          rnote.className = "swx-note";
          go.textContent = `${buying ? "Buy" : "Sell"} sent`;
          back.disabled = false;
          back.textContent = "Done";
        } catch (err) {
          // Sent and reverted still moved the fee, so the opener should re-read.
          if (err?.signature) sent = true;
          setRNote(explain(err), "err");
          go.textContent = `${buying ? "Buy" : "Sell"} ${t.symbol}`;
          go.disabled = false;
          back.disabled = false;
          // Whatever went wrong, the figures are now older than the attempt.
          cleanup = leave;
          timer = setInterval(requote, REQUOTE_MS);
          void requote();
        } finally {
          sending = false;
          go.classList.remove("busy");
        }
      });
    }
  }
}

window.__swap = { open };
