/**
 * The Pay dialog — lazy-loaded, exposed as `window.__pay`.
 *
 * A profile's Pay button opens it: one amount, in $UTCC, and two ways to move
 * it. People pay each other in $UTCC and nothing else, so there is no token to
 * pick. Send pays from the signed-in account's own wallet, which the server
 * signs for (POST /api/social/send, the same route as the wallet page's Send).
 * Scan QR code draws a Solana Pay request for $UTCC, so any wallet app can pay it.
 *
 * On someone else's profile both go to them. On your own, the code asks to be
 * paid, which is the old "Pay via QR code" with an amount on it. Send asks who
 * to pay first, since a wallet cannot send to itself.
 *
 * The amount is typed, built up from quick steps, or the whole balance, and
 * draws on the trade form's controls (swap/form.css) to do it.
 */
import { el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";
import { dialog, injectStyles } from "../js/ui.js";
import { UTCC, utccText } from "../js/utcc.js";
import { injectFormStyles } from "../swap/ui.js";
import CSS from "./pay.css";

/** Quick steps, in whole coins, each added to the amount already there. */
const STEPS = [10, 100, 1_000, 10_000];

/** Where someone short of $UTCC can buy it: the coin's own page in the wallet. */
const BUY = `/wallet?t=${UTCC.mint}`;

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
 * What the code says: a Solana Pay transfer request for $UTCC, which wallet
 * apps open with the coin, and the sum when there is one, already filled in.
 * Without a sum the wallet asks for one. Never the bare address, which a
 * wallet would pay in whatever the payer picked.
 */
function payUrl(address, amt, label) {
  const p = new URLSearchParams();
  if (amt) p.set("amount", amt.text);
  p.set("spl-token", UTCC.mint);
  if (label) p.set("label", label);
  return `solana:${address}?${p}`;
}

/** "+10", "+1k": the steps as the buttons spell them. */
function stepText(step) {
  return step >= 1000 ? `+${step / 1000}k` : `+${step}`;
}

/**
 * @param {{
 *   to: {name: string, address: string},
 *   me: null | {name: string, address: string, passkey?: boolean},
 *   login: () => void,
 *   sent?: () => void,
 * }} opts
 */
function open({ to, me, login, sent }) {
  const own = !!me && me.address === to.address;
  const title = own ? "Pay" : `Pay @${to.name}`;
  const { body, close, setTitle } = dialog(title);
  injectFormStyles();
  injectStyles("pay-css", CSS);

  let typed = "";
  /** Base units of $UTCC the wallet holds, or null while that is unknown. */
  let held = null;
  /** The lookup failed, which is not the same as an empty wallet. */
  let balanceUnknown = false;
  /** Who Send pays from your own profile, kept across Back. */
  let typedTo = "";
  /** The form's repaint, while the form is the screen showing. */
  let repaint = null;

  form();
  if (me) loadBalance();

  async function loadBalance() {
    try {
      const data = await post("/api/balances", { owner: me.address, mint: UTCC.mint });
      if (data.token == null) throw new Error();
      held = BigInt(data.token);
      balanceUnknown = false;
    } catch {
      balanceUnknown = true;
    }
    repaint?.();
  }

  // —— the amount, and the two ways to pay it ——

  function form() {
    setTitle(title);
    const balance = el("button", {
      class: "swx-bal",
      type: "button",
      "aria-label": `Send all your ${UTCC.symbol}`,
      onclick: sendAll,
    });
    const amount = el("input", {
      class: "swx-amt",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "0",
      "aria-label": `Amount of ${UTCC.symbol}`,
    });
    amount.value = typed;
    const chips = STEPS.map((step) =>
      el("button", {
        type: "button",
        text: stepText(step),
        "aria-label": `Add ${step.toLocaleString("en-US")} ${UTCC.symbol}`,
        onclick: () => add(step),
      }),
    );
    const send = el("button", { class: "swx-go", type: "button", text: me ? "Send" : "Log in to send", onclick: onSend });
    const scan = el("button", { class: "swx-2nd", type: "button", text: "Scan QR code", onclick: onScan });
    const note = el("div", { class: "swx-note" });

    body.replaceChildren(
      el(
        "div",
        { class: "swx-pane" },
        el("div", { class: "swx-lbl" }, el("span", { text: own ? "Amount" : "You pay" }), me ? balance : null),
        // The trade form's locked ticker: one coin, so chosen is the truth about it.
        el("div", { class: "swx-body" }, el("span", { class: "swx-lock", text: UTCC.symbol }), amount),
        el("div", { class: "swx-pct", role: "group", "aria-label": "Add to the amount" }, ...chips),
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
      const units = toUnits(typed, UTCC.decimals);
      return units ? { units, text: toDecimal(units, UTCC.decimals) } : null;
    }

    /** Text that is not an amount counts as none, so a step replaces it. */
    function add(step) {
      const units = (toUnits(typed, UTCC.decimals) ?? 0n) + BigInt(step) * 10n ** BigInt(UTCC.decimals);
      typed = toDecimal(units, UTCC.decimals);
      amount.value = typed;
      update();
    }

    function sendAll() {
      if (!held) return;
      typed = toDecimal(held, UTCC.decimals);
      amount.value = typed;
      update();
    }

    function update() {
      if (!amount.isConnected) return;
      balance.textContent = balanceUnknown
        ? "Balance unknown"
        : held == null
          ? "Balance —"
          : `Balance ${utccText(held)} ${UTCC.symbol}`;
      const units = toUnits(typed, UTCC.decimals);
      const known = !!me && held != null;
      // A step the wallet cannot cover is off, so the buttons say what is affordable.
      chips.forEach((chip, i) => {
        chip.disabled = known && (units ?? 0n) + BigInt(STEPS[i]) * 10n ** BigInt(UTCC.decimals) > held;
      });
      const bad = typed !== "" && units == null;
      const over = known && units != null && units > held;
      if (bad) setNote(`Enter an amount in ${UTCC.symbol}.`, "err");
      else if (over) setNote(`Not enough ${UTCC.symbol}.`, "err", `Buy ${UTCC.symbol}`);
      else if (known && !held) setNote(`You have no ${UTCC.symbol} yet.`, "", `Buy ${UTCC.symbol}`);
      else if (me && balanceUnknown) setNote("Balance unknown. Check you can cover this.");
      else setNote("");
      // Without an amount, the code still works: the payer picks one in their wallet.
      scan.disabled = bad;
      send.disabled = !!me && (!units || over);
    }

    /** @param {string} text @param {string} [kind] @param {string} [buy] a link to the coin, worded */
    function setNote(text, kind, buy) {
      note.replaceChildren(text, buy ? " " : "", buy ? el("a", { href: BUY, text: buy }) : "");
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
    setTitle(`Send ${amt.text} ${UTCC.symbol}`);
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
   * @param {{units: bigint, text: string}} amt
   * @param {{name: string, address: string}} who
   */
  function review(amt, who, back = form) {
    repaint = null;
    setTitle("Review payment");
    const sum = `${amt.text} ${UTCC.symbol}`;
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
        el("div", { class: "swx-body" }, el("span", { class: "swx-lock", text: UTCC.symbol }), el("div", { class: "swx-recv", text: amt.text })),
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
          mint: UTCC.mint,
          amount: amt.units.toString(),
          ...proof,
        });
        // The balance this dialog sized from has moved, and so has the page's.
        held = null;
        loadBalance();
        sent?.();
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

  /** @param {null | {units: bigint, text: string}} amt */
  async function code(amt) {
    repaint = null;
    setTitle(own ? "Get paid" : `Pay @${to.name}`);
    const sum = amt ? `${amt.text} ${UTCC.symbol}` : `any amount of ${UTCC.symbol}`;
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
        el("div", { class: "swx-done-t", text: `You sent ${amt.text} ${UTCC.symbol}` }),
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
