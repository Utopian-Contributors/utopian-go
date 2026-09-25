/**
 * The wallet page's account dialogs: recovery phrase, receive, send. One lazy
 * bundle, fetched the first time any of them is opened.
 */
import { el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Left behind on a Max SOL send: the account's own rent minimum and the fee. */
const SOL_KEEP = 2_000_000n;

async function send(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { setup: data.setup });
  return data;
}

/** A <dialog> that removes itself, and whatever it showed, when closed. */
function modal(title, ...kids) {
  const dialog = el(
    "dialog",
    { class: "ks", "aria-label": title },
    el("h2", { text: title }),
    ...kids,
    el("button", { type: "button", class: "wl-b ks-x", text: "Close", onclick: () => dialog.close() }),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Decimal text to base units, without a float in between. Null when it isn't a number. */
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

function short(a) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** @param {{passkey: boolean}} me */
function phrase(me) {
  const err = el("p", { class: "ks-err", role: "alert" });
  const out = el("div", {});
  const pass = el("input", {
    type: "password",
    id: "ks-p",
    autocomplete: "current-password",
    required: true,
    minlength: "8",
    maxlength: "128",
  });
  const form = el(
    "form",
    { class: "ks-f" },
    el("label", { for: "ks-p", text: "Password" }),
    pass,
    el("button", { type: "submit", class: "wl-cta", text: "Show phrase" }),
  );
  const key =
    me.passkey && window.PublicKeyCredential
      ? el("button", { type: "button", class: "wl-b", text: "Unlock with passkey", onclick: viaPasskey })
      : null;

  function show(words) {
    pass.value = "";
    form.hidden = true;
    if (key) key.hidden = true;
    err.textContent = "";
    out.replaceChildren(el("ol", { class: "ks-w" }, ...words.split(" ").map((word) => el("li", { text: word }))));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      show((await send("/api/social/phrase", { password: pass.value })).phrase);
    } catch (cause) {
      err.textContent = cause.message;
    }
  });

  async function viaPasskey() {
    err.textContent = "";
    key.disabled = true;
    try {
      needPasskey();
      const opt = await send("/api/social/phrase/passkey/options");
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
      show(
        (
          await send("/api/social/phrase/passkey", {
            challenge: opt.challenge,
            clientData: b64u(response.clientDataJSON),
            authenticatorData: b64u(response.authenticatorData),
            signature: b64u(response.signature),
          })
        ).phrase,
      );
    } catch (cause) {
      err.textContent = why(cause);
      if (cause.setup) {
        key.hidden = true;
        pass.focus();
      }
    } finally {
      key.disabled = false;
    }
  }

  modal(
    "Recovery phrase",
    el("p", { class: "ks-n", text: "These 12 words control this wallet. Anyone who sees them can take everything in it." }),
    el("p", { class: "ks-n ks-warn", text: "Nobody from UtopianGO will ask for them." }),
    key,
    form,
    err,
    out,
  );
}

/** @param {{address: string}} me */
function receive(me) {
  const code = el("div", { class: "ks-qr", role: "img", "aria-label": "QR code of this wallet's address" });
  const copy = el("button", {
    type: "button",
    class: "wl-cta",
    text: "Copy address",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(me.address);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select the address to copy it";
      }
    },
  });
  modal(
    "Receive",
    el("p", { class: "ks-n", text: "Send SOL or any Solana token to this address." }),
    code,
    el("p", { class: "ks-a", text: me.address }),
    copy,
  );
  load("qr", "__qr").then(
    // Markup built entirely by the QR encoder from this address.
    (qr) => (code.innerHTML = qr.svg(`solana:${me.address}`)),
    () => code.remove(),
  );
}

/**
 * @param {{address: string}} me
 * @param {import('../../src/types').Holding[]} holdings
 * @param {() => void} onSent
 */
function transfer(me, holdings, onSent) {
  const err = el("p", { class: "ks-err", role: "alert" });
  const done = el("p", { class: "ks-n" });
  const pick = el(
    "select",
    { id: "ks-t" },
    ...holdings.map((h, i) => el("option", { value: String(i), text: `${h.symbol} — ${toDecimal(BigInt(h.amount), h.decimals)}` })),
  );
  const to = el("input", {
    id: "ks-to",
    class: "ks-mono",
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Recipient's Solana address",
    maxlength: "44",
  });
  const amount = el("input", { id: "ks-am", inputmode: "decimal", required: true, autocomplete: "off", placeholder: "0.0" });
  const go = el("button", { type: "submit", class: "wl-cta", text: "Send" });
  const held = () => holdings[Number(pick.value)];

  const paste = navigator.clipboard?.readText
    ? el("button", {
        type: "button",
        class: "ks-side",
        text: "Paste",
        onclick: async () => {
          try {
            to.value = (await navigator.clipboard.readText()).trim();
            label();
          } catch {
            err.textContent = "The browser did not allow pasting. Paste into the field instead.";
          }
        },
      })
    : null;
  const max = el("button", {
    type: "button",
    class: "ks-side",
    text: "Max",
    onclick: () => {
      const h = held();
      let units = BigInt(h.amount);
      if (h.mint === SOL_MINT) units = units > SOL_KEEP ? units - SOL_KEEP : 0n;
      amount.value = toDecimal(units, h.decimals);
      label();
    },
  });

  function label() {
    const h = held();
    const addr = to.value.trim();
    go.textContent = amount.value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)
      ? `Send ${amount.value} ${h.symbol} to ${short(addr)}`
      : "Send";
  }

  const form = el(
    "form",
    { class: "ks-f" },
    el("label", { for: "ks-t", text: "Token" }),
    pick,
    el("label", { for: "ks-to", text: "To" }),
    el("div", { class: "ks-row" }, to, paste),
    el("label", { for: "ks-am", text: "Amount" }),
    el("div", { class: "ks-row" }, amount, max),
    go,
  );
  for (const input of [pick, to, amount]) input.addEventListener("input", label);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    done.replaceChildren();
    const h = held();
    const units = toUnits(amount.value, h.decimals);
    if (units == null || units <= 0n) return void (err.textContent = "Enter an amount.");
    if (units > BigInt(h.amount)) return void (err.textContent = `You hold ${toDecimal(BigInt(h.amount), h.decimals)} ${h.symbol}.`);
    go.disabled = true;
    go.textContent = "Sending…";
    try {
      const { signature } = await send("/api/social/send", { to: to.value.trim(), mint: h.mint, amount: units.toString() });
      form.hidden = true;
      done.replaceChildren(
        `Sent ${amount.value} ${h.symbol}. `,
        el("a", { href: `https://solscan.io/tx/${signature}`, target: "_blank", rel: "noopener", text: "Check the transaction" }),
      );
      onSent();
    } catch (cause) {
      err.textContent = cause.message;
    } finally {
      go.disabled = false;
      label();
    }
  });

  modal("Send", holdings.length ? form : el("p", { class: "ks-n", text: "This wallet holds nothing to send yet." }), err, done);
}

window.__keys = { open: phrase, receive, send: transfer };
