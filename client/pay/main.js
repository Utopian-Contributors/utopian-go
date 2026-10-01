/**
 * The Pay dialog — lazy-loaded, exposed as `window.__pay`.
 *
 * A profile's Pay button opens it: one amount, in SOL or USDC, and two ways to
 * move it. Send pays from the signed-in account's own wallet, which the server
 * signs for (POST /api/social/send, the same route as the wallet page's Send).
 * Scan QR code draws a Solana Pay request, so any wallet app can pay it.
 *
 * On someone else's profile both go to them. On your own, the code asks to be
 * paid, which is the old "Pay via QR code" with an amount on it. Send asks who
 * to pay first, since a wallet cannot send to itself.
 *
 * The amount is sized from the payer's balance, the way a trade is, and draws
 * on the trade form's controls (swap/form.css) to do it.
 */
import { el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";
import { dialog, injectStyles } from "../js/ui.js";
import { injectFormStyles } from "../swap/ui.js";
import CSS from "./pay.css";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/** What a payment can be made in: the two quote tokens /api/balances reports. */
const FUNDS = [
  { symbol: "SOL", mint: SOL_MINT, decimals: 9, key: "sol" },
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, key: "usdc" },
];

/** Left behind on a Max SOL send: the account's own rent minimum and the fee. As on the wallet page. */
const SOL_KEEP = 2_000_000n;

/** Quick sizes, as percentages of what the wallet can send. */
const PCTS = [25, 50, 100];

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE = /^@?([a-z0-9_]{3,16})$/i;

/** The trade dialog's tick, for the same green disc. */
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// —— base units, never through a float ——

/** Decimal text to base units. Null when it isn't a number, or has more places than the token. */
function toUnits(text, decimals) {
  const t = String(text).trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function toDecimal(units, decimals) {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Rounded, for the balance line only. */
function pretty(raw, decimals) {
  const n = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 });
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Something went wrong."), {
      stepUp: data.stepUp,
      passkey: data.passkey,
    });
  }
  return data;
}

/** A @name or an address, as {name, address}. A bare address has no name. */
async function lookup(text) {
  if (ADDRESS.test(text)) return { name: "", address: text };
  const handle = text.match(HANDLE);
  if (!handle) throw new Error("Enter a @name or a Solana address.");
  const res = await fetch(`/api/social/u/${handle[1].toLowerCase()}`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user?.address) throw new Error(data.error || "No such person.");
  return { name: data.user.name, address: data.user.address };
}

/**
 * What the code says. With an amount, a Solana Pay transfer request, which
 * wallet apps open with the sum and the token already filled in. Without one,
 * the bare address, as the profile's code always was: every wallet and
 * exchange scanner reads that, and the sender picks the amount.
 */
function payUrl(address, amt, label) {
  if (!amt) return address;
  const p = new URLSearchParams({ amount: amt.text });
  if (amt.fund.mint !== SOL_MINT) p.set("spl-token", amt.fund.mint);
  if (label) p.set("label", label);
  return `solana:${address}?${p}`;
}

/**
 * @param {{
 *   to: {name: string, address: string},
 *   me: null | {name: string, address: string, passkey?: boolean},
 *   login: () => void,
 * }} opts
 */
function open({ to, me, login }) {
  const own = !!me && me.address === to.address;
  const title = own ? "Pay" : `Pay @${to.name}`;
  const { body, close, setTitle } = dialog(title);
  injectFormStyles();
  injectStyles("pay-css", CSS);

  let fund = FUNDS[0];
  let typed = "";
  /** Base-unit strings by fund key, from /api/balances. */
  let balances = {};
  /** The lookup failed, which is not the same as an empty wallet. */
  let balanceUnknown = false;
  /** Who Send pays from your own profile, kept across Back. */
  let typedTo = "";
  /** The form's repaint, while the form is the screen showing. */
  let repaint = null;

  form();
  if (me) loadBalances();

  async function loadBalances() {
    try {
      // POSTed, as everywhere else: an address in a query string ends up in a request log.
      const res = await fetch("/api/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ owner: me.address }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error);
      balances = data;
      balanceUnknown = false;
    } catch {
      balanceUnknown = true;
    }
    repaint?.();
  }

  /** Base units Send may spend, or null while that is unknown. */
  function spendable() {
    const raw = balances[fund.key];
    if (raw == null) return null;
    const units = BigInt(raw);
    if (fund.mint !== SOL_MINT) return units;
    return units > SOL_KEEP ? units - SOL_KEEP : 0n;
  }

  // —— the amount, and the two ways to pay it ——

  function form() {
    setTitle(title);
    const balance = el("button", {
      class: "swx-bal",
      type: "button",
      "aria-label": `Send all your ${fund.symbol}`,
      onclick: () => sizeTo(100),
    });
    const amount = el("input", {
      class: "swx-amt",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "0.0",
      "aria-label": `Amount of ${fund.symbol}`,
    });
    amount.value = typed;
    const chips = PCTS.map((pct) =>
      el("button", {
        type: "button",
        text: pct === 100 ? "Max" : `${pct}%`,
        "aria-label": `${pct}% of your ${fund.symbol}`,
        onclick: () => sizeTo(pct),
      }),
    );
    const seg = el(
      "div",
      { class: "swx-seg", role: "group", "aria-label": "Pay in" },
      ...FUNDS.map((f) =>
        el("button", {
          type: "button",
          text: f.symbol,
          class: f === fund ? "on" : "",
          "aria-pressed": String(f === fund),
          onclick: () => {
            if (fund === f) return;
            fund = f;
            // 0.5 SOL and 0.5 USDC are very different payments.
            typed = "";
            form();
          },
        }),
      ),
    );
    const send = el("button", { class: "swx-go", type: "button", text: me ? "Send" : "Log in to send", onclick: onSend });
    const scan = el("button", { class: "swx-2nd", type: "button", text: "Scan QR code", onclick: onScan });
    const note = el("div", { class: "swx-note" });

    body.replaceChildren(
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: own ? "Amount" : "You pay" }), me ? balance : null),
        el("div", { class: "swx-body" }, seg, amount),
        me ? el("div", { class: "swx-pct", role: "group", "aria-label": "Size from balance" }, ...chips) : null,
      ),
      el("div", { class: "swx-act" }, send, scan),
      note,
    );
    amount.addEventListener("input", () => {
      typed = amount.value.trim();
      update();
    });
    amount.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSend();
    });
    repaint = update;
    update();
    // As in the trade dialog: no keyboard thrown up over a phone's sheet.
    if (window.matchMedia("(min-width: 521px)").matches) amount.focus();

    /** The amount, or null when there is none to pay. */
    function entered() {
      const units = toUnits(typed, fund.decimals);
      return units ? { units, text: toDecimal(units, fund.decimals), fund } : null;
    }

    function sizeTo(pct) {
      const max = spendable();
      if (!max) return;
      typed = toDecimal((max * BigInt(pct)) / 100n, fund.decimals);
      amount.value = typed;
      update();
    }

    function update() {
      if (!amount.isConnected) return;
      const raw = balances[fund.key];
      balance.textContent = balanceUnknown
        ? "Balance unknown"
        : raw == null
          ? "Balance —"
          : `Balance ${pretty(raw, fund.decimals)} ${fund.symbol}`;
      const max = spendable();
      const units = toUnits(typed, fund.decimals);
      chips.forEach((chip, i) => {
        chip.disabled = !max;
        chip.classList.toggle("on", !!max && units === (max * BigInt(PCTS[i])) / 100n);
      });
      const bad = typed !== "" && units == null;
      const over = !!me && units != null && max != null && units > max;
      if (bad) setNote(`Enter an amount in ${fund.symbol}.`, "err");
      else if (over) setNote(`Not enough ${fund.symbol}.`, "err");
      else if (me && balanceUnknown) setNote("Balance unknown. Check you can cover this.");
      else setNote("");
      // Without an amount, the code still works: the payer picks one in their wallet.
      scan.disabled = bad;
      send.disabled = !!me && (!units || over);
    }

    function setNote(text, kind) {
      note.textContent = text;
      note.className = `swx-note${kind ? ` ${kind}` : ""}`;
    }

    function onSend() {
      if (!me) {
        close();
        login();
        return;
      }
      if (send.disabled) return;
      const amt = entered();
      if (!amt) return;
      if (own) recipient(amt);
      else review(amt, to);
    }

    function onScan() {
      if (!scan.disabled) code(entered());
    }
  }

  // —— your own profile: who to pay ——

  function recipient(amt) {
    repaint = null;
    setTitle(`Send ${amt.text} ${amt.fund.symbol}`);
    const input = el("input", {
      class: "pay-field",
      id: "pay-to",
      type: "text",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      placeholder: "@name or Solana address",
      maxlength: "44",
    });
    input.value = typedTo;
    const go = el("button", { class: "swx-go", type: "submit", text: "Continue" });
    const note = el("div", { class: "swx-note", role: "alert" });
    const step = el(
      "form",
      {},
      el("label", { class: "pay-lbl", for: "pay-to", text: "To" }),
      input,
      el("div", { class: "swx-act" }, go, el("button", { class: "swx-2nd", type: "button", text: "Back", onclick: form })),
      note,
    );
    step.addEventListener("submit", async (e) => {
      e.preventDefault();
      typedTo = input.value.trim();
      note.textContent = "";
      note.className = "swx-note";
      go.disabled = true;
      try {
        const who = await lookup(typedTo);
        if (who.address === me.address) throw new Error("That is this wallet's own address.");
        if (step.isConnected) review(amt, who, () => recipient(amt));
      } catch (cause) {
        note.textContent = cause.message;
        note.className = "swx-note err";
      } finally {
        go.disabled = false;
      }
    });
    body.replaceChildren(step);
    input.focus();
  }

  // —— the review, where Send actually sends ——

  /**
   * @param {{units: bigint, text: string, fund: typeof FUNDS[number]}} amt
   * @param {{name: string, address: string}} who
   */
  function review(amt, who, back = form) {
    repaint = null;
    setTitle("Review payment");
    const sum = `${amt.text} ${amt.fund.symbol}`;
    const confirm = el("button", { class: "swx-go", type: "button", text: `Send ${sum}`, onclick: () => submit(confirm, {}) });
    /** The password or passkey a send over the day's allowance needs. */
    const extra = el("div");
    const note = el("div", { class: "swx-note", role: "alert" });
    let busy = false;

    body.replaceChildren(
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: "You send" })),
        el("div", { class: "swx-body" }, el("span", { class: "swx-lock", text: amt.fund.symbol }), el("div", { class: "swx-recv", text: amt.text })),
      ),
      el(
        "div",
        { class: "pay-to" },
        el("div", { class: "swx-lbl" }, el("span", { text: "To" })),
        who.name ? el("div", { class: "pay-who", text: `@${who.name}` }) : null,
        el("div", { class: "pay-addr", text: who.address }),
      ),
      el("p", {
        class: "pay-warn",
        text: who.name ? "A sent payment cannot be undone." : "Check every character. A sent payment cannot be undone.",
      }),
      extra,
      el("div", { class: "swx-act" }, confirm, el("button", { class: "swx-2nd", type: "button", text: "Back", onclick: back })),
      note,
    );
    confirm.focus();

    /** @param {HTMLButtonElement} button @param {Record<string, string>} proof */
    async function submit(button, proof) {
      if (busy) return;
      busy = true;
      note.textContent = "";
      note.className = "swx-note";
      button.disabled = true;
      const was = button.textContent;
      button.textContent = "Sending…";
      try {
        const { signature } = await post("/api/social/send", {
          to: who.address,
          mint: amt.fund.mint,
          amount: amt.units.toString(),
          ...proof,
        });
        // The balance this dialog sized from has moved.
        balances = {};
        loadBalances();
        if (note.isConnected) done(amt, who, signature);
      } catch (cause) {
        if (cause.stepUp && !Object.keys(proof).length) {
          confirm.hidden = true;
          stepUp(cause.passkey);
        } else {
          note.textContent = cause.message;
          note.className = "swx-note err";
        }
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = was;
      }
    }

    /** Over the day's allowance: the server wants the password or the passkey again. */
    function stepUp(withPasskey) {
      const pass = el("input", {
        class: "pay-field",
        type: "password",
        id: "pay-pw",
        autocomplete: "current-password",
        required: true,
        minlength: "8",
        maxlength: "128",
      });
      const ok = el("button", { class: "swx-go", type: "submit", text: `Confirm and send ${sum}` });
      const check = el("form", { class: "pay-step" }, el("label", { class: "pay-lbl", for: "pay-pw", text: "Password" }), pass, ok);
      check.addEventListener("submit", (e) => {
        e.preventDefault();
        submit(ok, { password: pass.value });
      });
      const key =
        withPasskey && window.PublicKeyCredential
          ? el("button", { class: "swx-2nd", type: "button", text: "Confirm with passkey", onclick: () => viaPasskey(key) })
          : null;
      extra.replaceChildren(
        el("div", {}, el("p", { class: "pay-warn", text: "This is more than a session can send on its own today." }), key, check),
      );
      (key || pass).focus();
    }

    async function viaPasskey(key) {
      note.textContent = "";
      try {
        needPasskey();
        const opt = await post("/api/social/send/passkey/options");
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: u8(opt.challenge),
            rpId: location.hostname,
            allowCredentials: [{ type: "public-key", id: u8(opt.id) }],
            userVerification: "required",
            timeout: 60_000,
          },
        });
        if (!cred) throw new Error("Passkey was cancelled.");
        const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
        await submit(key, {
          challenge: opt.challenge,
          clientData: b64u(response.clientDataJSON),
          authenticatorData: b64u(response.authenticatorData),
          signature: b64u(response.signature),
        });
      } catch (cause) {
        note.textContent = why(cause);
        note.className = "swx-note err";
      }
    }
  }

  // —— the code ——

  /** @param {null | {units: bigint, text: string, fund: typeof FUNDS[number]}} amt */
  async function code(amt) {
    repaint = null;
    setTitle(own ? "Get paid" : `Pay @${to.name}`);
    const sum = amt ? `${amt.text} ${amt.fund.symbol}` : "any amount";
    const holder = el("div", { class: "swx-qr", role: "img", "aria-label": "Payment QR code" });
    const copy = el("button", {
      class: "swx-2nd",
      type: "button",
      text: "Copy address",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(to.address);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Select the address to copy it";
        }
      },
    });
    body.replaceChildren(
      el("div", {
        class: "swx-note",
        text: own ? `Scan with a Solana wallet to send you ${sum}.` : `Scan with a Solana wallet to pay @${to.name} ${sum}.`,
      }),
      holder,
      el("div", { class: "pay-addr", text: to.address }),
      el("div", { class: "swx-act" }, copy, el("button", { class: "swx-2nd", type: "button", text: "Back", onclick: form })),
    );
    try {
      const qr = await load("qr", "__qr");
      // Generated markup, built entirely by the encoder from this string.
      if (holder.isConnected) holder.innerHTML = qr.svg(payUrl(to.address, amt, `@${to.name}`));
    } catch {
      holder.replaceChildren(el("div", { class: "swx-note err", text: "Could not draw the code." }));
    }
  }

  // —— sent ——

  function done(amt, who, signature) {
    setTitle("Sent");
    const disc = el("div", { class: "swx-check", role: "img", "aria-label": "Payment sent" });
    disc.innerHTML = CHECK_SVG;
    const finish = el("button", { class: "swx-go", type: "button", text: "Done", onclick: close });
    const a = who.address;
    body.replaceChildren(
      el(
        "div",
        { class: "swx-done" },
        disc,
        el("div", { class: "swx-done-t", text: `You sent ${amt.text} ${amt.fund.symbol}` }),
        el("div", { class: "swx-done-s", text: `to ${who.name ? `@${who.name}` : `${a.slice(0, 4)}…${a.slice(-4)}`}` }),
        el(
          "div",
          { class: "swx-done-s" },
          el("a", { href: `https://solscan.io/tx/${signature}`, target: "_blank", rel: "noopener", text: "View transaction" }),
        ),
      ),
      finish,
    );
    finish.focus();
  }
}

window.__pay = { open };
