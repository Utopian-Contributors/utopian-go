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
import { build, quote, toBase58 } from "./jup.js";
import { dialog } from "./ui.js";
import { connect, signAndSend, wallets } from "./wallet.js";

const SLIPPAGE_BPS = 100;
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

function shortAddr(a) {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/**
 * Dollars, two decimals, for someone who does not think in lamports.
 *
 * Sub-cent amounts state themselves as a bound rather than as $0.00, which
 * reads as free. Everything the confirmation screen shows goes through here.
 */
function usd(v) {
  if (!Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  const { body, close, setTitle } = dialog(`Trade ${t.symbol}`, () => {
    cleanup?.();
    cleanup = null;
  });
  // Buying SOL cannot be funded with SOL, and vice versa for USDC.
  const funds = FUNDS.filter((f) => f.mint !== t.mint);
  /** The searched token's USD price, carried in from the card. */
  const tokenUsd = Number.isFinite(t.price) ? t.price : null;
  // Selling means converting a typed amount of the token into base units,
  // which needs its decimals. Records from an older snapshot may lack them.
  const canSell = t.decimals != null;

  let fund = funds[0];
  let mode = "buy";
  let typed = "";
  let balances = {};
  /** Once someone edits the field, stop replacing it with assumed positions. */
  let touched = false;

  form();

  /** Wallet picker, shown only when connecting needs a choice. */
  function picker(found) {
    body.replaceChildren();
    const list = el("div", { class: "swx-w" });
    const note = el("div", { class: "swx-note" });

    for (const wallet of found) {
      const row = el("button", { type: "button" });
      // Data URIs only. Wallet Standard supplies the icon inline, and this is a
      // pre-connect screen — an extension offering a remote URL instead would
      // make the browser fetch it, which is exactly the third-party contact the
      // dialog otherwise no longer makes before a wallet is chosen.
      if (/^data:image\//i.test(wallet.icon ?? "")) {
        row.append(el("img", { src: wallet.icon, alt: "" }));
      }
      row.append(el("span", { text: wallet.name }));
      row.addEventListener("click", async () => {
        row.disabled = true;
        note.textContent = "";
        try {
          session = { wallet, account: await connect(wallet) };
          form();
        } catch (err) {
          row.disabled = false;
          note.textContent = err?.message || "Connection declined.";
          note.className = "swx-note err";
        }
      });
      list.append(row);
    }

    body.append(
      el("div", { class: "swx-lbl" }, el("span", { text: "Choose a wallet" })),
      list,
      note,
    );
  }

  // —— the trade form: shown immediately, quotes without a wallet ——

  function form() {
    cleanup?.();
    cleanup = null;
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
    const note = el("div", { class: "swx-note" });

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
      ),
      el("div", { class: "swx-arrow" }, flip),
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: "You receive" })),
        el("div", { class: "swx-body" }, buying ? lock() : quoteControl(), receive),
      ),
      action,
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

    function showBalance() {
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
      const found = wallets();
      if (!found.length) {
        setNote("No Solana wallet detected — opening Jupiter.", "err");
        setTimeout(() => {
          window.open(t.fallback, "_blank", "noopener");
          close();
        }, 800);
        return;
      }
      if (found.length > 1) return picker(found);

      busy = true;
      action.disabled = true;
      action.classList.add("busy");
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
          : "Enter an amount";
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

        payAmt.textContent = usd(paid);
        recvAmt.textContent = usd(got);
        payUnits.textContent = units(pay, q.inAmount);
        recvUnits.textContent = units(recv, q.outAmount);

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
        leave();
        form();
      });

      go.addEventListener("click", async () => {
        if (sending || done) return;
        sending = true;
        // Nothing may re-price under a transaction that is being signed.
        leave();
        go.disabled = true;
        go.classList.add("busy");
        go.textContent = "Confirm in wallet…";
        back.disabled = true;
        setRNote("");

        try {
          const tx = await build({
            quote: current,
            taker: session.account.address,
            feeAccount,
          });
          const sig = toBase58(await signAndSend(session.wallet, session.account, tx));
          done = true;
          // "Sent", not "Bought". signAndSend resolves when the wallet has
          // broadcast the transaction, which is not the same as it landing and
          // not the same as it succeeding: a swap carries the quote's
          // otherAmountThreshold and reverts on-chain if the route settles
          // below it, and a transaction can also expire without landing at all.
          // This app holds no RPC of its own to ask with — the wallet does the
          // sending — so the honest claim is the one we can actually make, and
          // the link is how someone checks the rest.
          rnote.replaceChildren(
            el("a", {
              href: `https://solscan.io/tx/${sig}`,
              target: "_blank",
              rel: "noopener",
              text: "Check the transaction",
            }),
          );
          rnote.className = "swx-note ok";
          go.textContent = `${buying ? "Buy" : "Sell"} sent`;
          current = null;
          // Re-arm sized to what's left, so trading again is one click.
          touched = false;
          typed = "";
          back.disabled = false;
          back.textContent = "Done";
        } catch (err) {
          const msg = /reject|denied|cancel|user/i.test(err?.message ?? "")
            ? "Cancelled."
            : err?.message || "Swap failed.";
          setRNote(msg, "err");
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
