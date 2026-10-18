/**
 * The confirmation every send goes through, drawn the way the trade dialog
 * confirms a buy: what leaves, in dollars over the quantity; who it goes to,
 * the address spelled out in full; what the network takes; and one button.
 *
 * Every send is confirmed with the account's passkey, whatever it is worth.
 * The server refuses a send without one, so a session cookie on its own moves
 * nothing. An account with no passkey yet adds one here, with its password,
 * and confirms with it straight after.
 *
 * Shared by the Pay dialog and the wallet page's Send, so the two cannot
 * drift into confirming differently.
 */
import { el } from "./dom.js";
import { dollars as usd } from "./num.js";
import { assertion, register, why } from "./passkey.js";
import { livePrice } from "./price.js";
import { injectStyles } from "./ui.js";
import { injectFormStyles } from "../swap/ui.js";
import PAY_CSS from "../pay/pay.css";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * What the network takes, in SOL. A token send also opens the recipient's
 * token account when they have never held that token, and the sender pays
 * its rent (0.00204 SOL), which is why that one is a ceiling.
 */
const FEE_SOL = "0.000005 SOL";
const FEE_TOKEN = "Up to 0.0021 SOL";

/** The trade dialog's tick, for the same green disc. */
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

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

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * @param {HTMLElement} body where the screens draw
 * @param {{
 *   me: {name: string, address: string, passkey?: false | {id: string}},
 *   token: {mint: string, symbol: string, decimals: number, price?: number},
 *   amount: {units: bigint, text: string},
 *   to: {name?: string, address: string},
 *   setTitle: (title: string) => void,
 *   back: () => void,
 *   close: () => void,
 *   sent?: () => void,
 * }} p
 */
export function confirmSend(body, p) {
  injectFormStyles();
  injectStyles("pay-css", PAY_CSS);
  p.setTitle("Confirm send");

  const sum = `${p.amount.text} ${p.token.symbol}`;
  const who = p.to.name ? `@${p.to.name}` : short(p.to.address);
  const head = el("div", { class: "swx-recv" });
  const sub = el("div", { class: "swx-sub" });
  const go = el("button", { class: "swx-go", type: "button", text: `Send ${sum}`, onclick: () => attempt(go, send) });
  const back = el("button", { class: "swx-2nd", type: "button", text: "Back", onclick: () => !busy && p.back() });
  /** Where the password goes while the account has no passkey to confirm with. */
  const setup = el("div");
  const note = el("div", { class: "swx-note", role: "alert" });
  let busy = false;

  const detail = (key, value) =>
    el("div", { class: "swx-row" }, el("span", { class: "swx-k", text: key }), el("span", { class: "swx-v", text: value }));

  /** Dollars lead and the quantity sits under them, as on the trade's confirmation; the quantity alone when unpriced. */
  function state(price) {
    const priced = Number.isFinite(price) && price > 0;
    head.className = `swx-recv${priced ? "" : " qty"}`;
    head.textContent = priced ? usd((Number(p.amount.units) / 10 ** p.token.decimals) * price) : p.amount.text;
    sub.textContent = priced ? sum : "";
    sub.hidden = !priced;
  }

  body.replaceChildren(
    el(
      "div",
      { class: "swx-pane" },
      el("div", { class: "swx-lbl" }, el("span", { text: "You send" })),
      el("div", { class: "swx-body" }, el("span", { class: "swx-lock", text: p.token.symbol }), head),
      sub,
    ),
    el(
      "div",
      { class: "pay-to" },
      el("div", { class: "swx-lbl" }, el("span", { text: "To" })),
      p.to.name ? el("div", { class: "pay-who", text: `@${p.to.name}` }) : null,
      el("div", { class: "pay-addr", text: p.to.address }),
    ),
    el(
      "div",
      { class: "swx-sum" },
      detail("Network fee", p.token.mint === SOL_MINT ? FEE_SOL : FEE_TOKEN),
      detail("From", short(p.me.address)),
    ),
    el("p", {
      class: "pay-warn",
      text: p.to.name ? "A sent payment cannot be undone." : "Check every character. A sent payment cannot be undone.",
    }),
    setup,
    el("div", { class: "swx-act" }, go, back),
    note,
  );
  state(p.token.price);
  void livePrice(p.token.mint).then((price) => {
    if (price != null && head.isConnected) state(price);
  });
  if (p.me.passkey) go.focus();
  else needPasskey();

  /** One go at sending, with `button` saying it is underway and Back held until it is over. */
  async function attempt(button, run) {
    if (busy) return;
    busy = true;
    note.textContent = "";
    note.className = "swx-note";
    button.disabled = back.disabled = true;
    const was = button.textContent;
    button.textContent = "Confirming…";
    try {
      await run(button);
    } catch (cause) {
      // The passkey went away since the dialog read the account.
      if (cause.stepUp && cause.passkey === false) {
        p.me.passkey = false;
        needPasskey();
      }
      note.textContent = why(cause);
      note.className = "swx-note err";
    } finally {
      busy = false;
      button.disabled = back.disabled = false;
      button.textContent = was;
    }
  }

  /** @param {HTMLButtonElement} button */
  async function send(button) {
    const proof = await assertion(await post("/api/social/send/passkey/options"));
    button.textContent = "Sending…";
    const { signature } = await post("/api/social/send", {
      to: p.to.address,
      mint: p.token.mint,
      amount: p.amount.units.toString(),
      ...proof,
    });
    p.sent?.();
    if (note.isConnected) done(signature);
  }

  /** No passkey on the account: add one with the password, then confirm with it. */
  function needPasskey() {
    go.hidden = true;
    const pass = el("input", {
      class: "pay-field",
      type: "password",
      id: "snd-pw",
      autocomplete: "current-password",
      required: true,
      minlength: "8",
      maxlength: "128",
    });
    const ok = el("button", { class: "swx-go", type: "submit", text: `Add passkey and send ${sum}` });
    const form = el(
      "form",
      { class: "pay-step" },
      el("div", { class: "pay-warn", text: "Every send is confirmed with a passkey, and this account has none yet. Enter your password to add one." }),
      el("label", { class: "pay-lbl", for: "snd-pw", text: "Password" }),
      pass,
      ok,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      attempt(ok, async (button) => {
        p.me.passkey = (await register(p.me.name, pass.value, post)).me.passkey;
        try {
          await send(button);
        } finally {
          // The passkey is on the account whatever became of the send, so a
          // retry is the plain button.
          setup.replaceChildren();
          go.hidden = false;
        }
      });
    });
    setup.replaceChildren(form);
    pass.focus();
  }

  function done(signature) {
    p.setTitle("Sent");
    const disc = el("div", { class: "swx-check", role: "img", "aria-label": "Payment sent" });
    disc.innerHTML = CHECK_SVG;
    const finish = el("button", { class: "swx-go", type: "button", text: "Done", onclick: p.close });
    body.replaceChildren(
      el(
        "div",
        { class: "swx-done" },
        disc,
        el("div", { class: "swx-done-t", text: `You sent ${sum}` }),
        el("div", { class: "swx-done-s", text: `to ${who}` }),
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
