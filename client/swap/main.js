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
  const { body, close } = dialog(`Trade ${t.symbol}`);
  // Buying SOL cannot be funded with SOL, and vice versa for USDC.
  const funds = FUNDS.filter((f) => f.mint !== t.mint);
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
      if (wallet.icon) row.append(el("img", { src: wallet.icon, alt: "" }));
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
      ? { symbol: t.symbol, decimals: t.decimals }
      : { symbol: fund.symbol, decimals: fund.decimals };
    const reserve = pay.mint === SOL_MINT ? SOL_RESERVE : 0n;

    let current = null;
    let inflight = null;
    let busy = false;

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
      balance.textContent =
        raw == null ? "Balance —" : `Balance ${pretty(raw, pay.decimals)}`;
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
        const url =
          `/api/balances?owner=${encodeURIComponent(session.account.address)}` +
          `&mint=${encodeURIComponent(t.mint)}`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const data = await res.json();
        if (data?.error) throw new Error(data.error);
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
        // Unknown is not zero: leave the field usable and let Jupiter decide.
      }
    }

    function label() {
      if (busy) return;
      if (!session) {
        // The quote is already on screen; connecting is the next step, not a
        // gate in front of seeing what you'd get.
        action.textContent = "Connect wallet";
        action.disabled = false;
      } else {
        const verb = buying ? "Buy" : "Sell";
        action.textContent = current ? `${verb} ${t.symbol}` : "Enter an amount";
        action.disabled = !current;
      }
      action.classList.remove("busy");
    }

    async function refresh() {
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
        if (controller !== inflight) return;
        current = q;
        receive.textContent =
          recv.decimals != null ? pretty(q.outAmount, recv.decimals) : "—";
        receive.className = "swx-recv";
        setNote(`${SLIPPAGE_BPS / 100}% max slippage`);
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

    action.addEventListener("click", async () => {
      if (busy) return;
      if (!session) return startConnect();
      if (!current) return;

      busy = true;
      action.disabled = true;
      action.classList.add("busy");
      action.textContent = "Confirm in wallet…";
      setNote("");

      try {
        const tx = await build({
          quote: current,
          taker: session.account.address,
          feeAccount,
        });
        const sig = toBase58(await signAndSend(session.wallet, session.account, tx));
        note.replaceChildren(
          el("a", {
            href: `https://solscan.io/tx/${sig}`,
            target: "_blank",
            rel: "noopener",
            text: "View transaction",
          }),
        );
        note.className = "swx-note ok";
        action.textContent = `${buying ? "Bought" : "Sold"} ${t.symbol}`;
        current = null;
        // Re-arm sized to what's left, so trading again is one click.
        touched = false;
        typed = "";
        loadBalances();
      } catch (err) {
        const msg = /reject|denied|cancel|user/i.test(err?.message ?? "")
          ? "Cancelled."
          : err?.message || "Swap failed.";
        setNote(msg, "err");
        action.textContent = `${buying ? "Buy" : "Sell"} ${t.symbol}`;
        action.disabled = false;
      } finally {
        busy = false;
        action.classList.remove("busy");
      }
    });
  }
}

window.__swap = { open };
