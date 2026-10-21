/**
 * The wallet page's dialogs: recovery phrase, receive, send, and what a token
 * we do not list says about itself. One lazy bundle, fetched the first time
 * any of them is opened.
 */
import { el } from "../js/dom.js";
import { dismissible } from "../js/sheet.js";
import { load } from "../js/lazy.js";
import { amount } from "../js/num.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";
import { confirmSend } from "../js/sendconfirm.js";
import { dialog } from "../js/ui.js";

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
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Something went wrong."), {
      setup: data.setup,
    });
  }
  return data;
}

/** A <dialog> that removes itself, and whatever it showed, when closed. */
function modal(title, ...kids) {
  const dialog = el(
    "dialog",
    { class: "ks", "aria-label": title },
    el("h2", { text: title }),
    ...kids,
  );
  dismissible(/** @type {HTMLDialogElement} */ (dialog));
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

/** @param {{passkey: false | {id: string}}} me */
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
    // Same as the Social profile: the words do not outlast two minutes.
    setTimeout(() => out.replaceChildren(), 120_000);
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
 * The wallet's Send: which token, to whom, how much, then the confirmation
 * every send goes through (js/sendconfirm.js), in the trade dialog's shell.
 *
 * @param {{name: string, address: string, passkey: false | {id: string}}} me
 * @param {import('../../src/types').Holding[]} holdings
 * @param {() => void} onSent
 */
function transfer(me, holdings, onSent) {
  const err = el("p", { class: "ks-err", role: "alert" });
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
    const addr = to.value.trim();
    go.textContent = amount.value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? "Review" : "Send";
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

  const { body, close, setTitle } = dialog("Send");

  /** The form again, as it was left: Back from the confirmation. */
  function back() {
    setTitle("Send");
    body.replaceChildren(form, err);
    to.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    err.textContent = "";
    const h = held();
    const addr = to.value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return void (err.textContent = "That isn't a Solana address.");
    const units = toUnits(amount.value, h.decimals);
    if (units == null || units <= 0n) return void (err.textContent = "Enter an amount.");
    if (units > BigInt(h.amount)) return void (err.textContent = `You hold ${toDecimal(BigInt(h.amount), h.decimals)} ${h.symbol}.`);
    // The whole address is spelled out on the next screen, never shortened: a
    // lookalike that matches only its first and last few characters is
    // exactly how a poisoned address works.
    confirmSend(body, {
      me,
      token: { mint: h.mint, symbol: h.symbol, decimals: h.decimals, price: h.price },
      amount: { units, text: toDecimal(units, h.decimals) },
      to: { address: addr },
      setTitle,
      back,
      close,
      sent: onSent,
    });
  });

  body.append(holdings.length ? form : el("p", { class: "ks-n", text: "This wallet holds nothing to send yet." }), err);
}

/** The mint's two ends, enough to tell a row of them apart, as History shows them. */
function short(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** An authority's address, or None: a token with none can never be minted more of, or frozen. */
function authority(asset, key) {
  const a = asset[key];
  if (a) return el("span", { class: "ks-mono", text: a });
  // No token_info at all is no answer, not an answer of none.
  return asset.decimals == null ? null : "None";
}

function link(href, text) {
  return el("a", { href, text, target: "_blank", rel: "noopener noreferrer nofollow" });
}

/**
 * The token's logo from wherever its creator put it, fetched by the browser
 * directly: a mint we do not list never goes through /icon/. No referrer, so
 * the host learns an address asked and nothing of this page.
 */
function logo(asset) {
  const coin = () => el("span", { class: "ks-ti wl-coin", text: "$", "aria-hidden": "true" });
  if (!asset?.image) return coin();
  const img = el("img", {
    class: "ks-ti",
    src: asset.image,
    alt: "",
    width: "40",
    height: "40",
    referrerpolicy: "no-referrer",
    decoding: "async",
  });
  img.addEventListener("error", () => img.replaceWith(coin()), { once: true });
  return img;
}

/**
 * One token: the amount, then every field the chain had for it.
 * @param {{mint: string, amount: string, decimals: number}} held
 * @param {import('../../src/types').TokenAsset | null} asset null while it is read, or when it could not be
 * @param {boolean} signed a transaction's change, which says + as well as −
 */
function tokenCard(held, asset, signed) {
  const a = asset ?? { mint: held.mint };
  const out = held.amount.startsWith("-");
  const units = held.amount.replace(/^-/, "");
  const sign = out ? "−" : signed ? "+" : "";
  const qty = `${sign}${amount(units, held.decimals).title ?? "0"} ${a.symbol || "tokens"}`;
  const supply = a.supply && a.decimals != null ? amount(a.supply, a.decimals).title : null;
  const rows = [
    ["Mint", el("span", { class: "ks-mono", text: held.mint })],
    ["Decimals", a.decimals != null ? String(a.decimals) : null],
    ["Supply", supply],
    ["Program", a.program ?? null],
    ["Mint authority", authority(a, "mintAuthority")],
    ["Freeze authority", authority(a, "freezeAuthority")],
    ["Update authority", a.updateAuthority ? el("span", { class: "ks-mono", text: a.updateAuthority }) : null],
    ["Metadata", a.mutable == null ? null : a.mutable ? "Can still be changed" : "Fixed"],
    ["Description", a.description ?? null],
    ["Website", a.website ? link(a.website, a.website) : null],
    ["Metadata file", a.uri ? link(a.uri, a.uri) : null],
  ].filter(([, v]) => v != null);

  return el(
    "section",
    { class: "ks-tk" },
    el(
      "div",
      { class: "ks-th" },
      logo(asset),
      el(
        "div",
        { class: "ks-tt" },
        el("strong", { text: a.name || a.symbol || short(held.mint) }),
        el("span", { class: `ks-tq${out ? "" : signed ? " up" : ""}`, text: qty }),
      ),
    ),
    el("dl", { class: "ks-dl" }, ...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, v)])),
    el("p", { class: "ks-tl" }, link(`https://solscan.io/token/${held.mint}`, "View on Solscan")),
  );
}

/**
 * Tokens the index does not carry: how much, and what the chain says of each.
 * Opened from the portfolio's "no price for" note with everything it named,
 * or from one History row's unnamed token with that row's change.
 *
 * @param {{mint: string, amount: string, decimals: number}[]} list
 * @param {{total?: number, signed?: boolean}} [opts] `total` when the list is the first of more
 */
function tokens(list, { total = list.length, signed = false } = {}) {
  const many = list.length > 1;
  const cards = el("div", { class: "ks-tks" }, ...list.map((h) => tokenCard(h, null, signed)));
  const status = el("p", { class: "ks-n", text: `Reading what the chain says about ${many ? "them" : "it"}…` });
  const err = el("p", { class: "ks-err", role: "alert" });
  modal(
    many ? "Unidentified tokens" : "Unidentified token",
    el("p", {
      class: "ks-n",
      text: many
        ? "We don't list these, so they have no price here. Anything below is what their creators say about them: anyone can make a token and send it to any wallet."
        : "We don't list this, so it has no price here. Anything below is what its creator says about it: anyone can make a token and send it to any wallet.",
    }),
    status,
    cards,
    total > list.length ? el("p", { class: "ks-n", text: `And ${total - list.length} more not shown.` }) : null,
    err,
  );

  void (async () => {
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ mints: [...new Set(list.map((h) => h.mint))] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.assets) throw new Error(data?.error || "");
      const byMint = new Map(data.assets.map((a) => [a.mint, a]));
      cards.replaceChildren(...list.map((h) => tokenCard(h, byMint.get(h.mint) ?? null, signed)));
      status.remove();
    } catch (e) {
      status.remove();
      err.textContent = (e instanceof Error && e.message) || `Could not read what the chain says about ${many ? "them" : "it"}.`;
    }
  })();
}

window.__keys = { open: phrase, receive, send: transfer, tokens };
