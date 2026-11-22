/**
 * Checkout by Solana Pay, for an ad (client/ads) or a Shop pack (client/shop):
 * the code, in SOL or USDC, until the server has seen the transfer
 * (src/social/adPay.ts) or the dialog is closed. This only asks whether it has.
 */
import { el } from "./dom.js";
import { load } from "./lazy.js";
import { dialog, injectStyles } from "./ui.js";
import { injectFormStyles } from "../swap/ui.js";

/** How often checkout asks whether the transfer has been seen. */
const POLL_MS = 3000;

const CSS =
  ".sp-funds{width:max-content;margin:0 auto 4px}" +
  ".sp-memo{display:flex;justify-content:center;align-items:baseline;gap:8px;margin-top:12px;font-size:12px;color:var(--f)}" +
  ".sp-memo code{font:600 15px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--t);letter-spacing:.04em}" +
  ".sp-fine{margin:10px 0 0;font-size:12px;line-height:1.45;text-align:center;color:var(--f)}";

/** Base units as a decimal amount, without a float. */
export function decimal(units, places) {
  const text = String(units).padStart(places + 1, "0");
  const frac = text.slice(-places).replace(/0+$/, "");
  return frac ? `${text.slice(0, -places)}.${frac}` : text.slice(0, -places);
}

export function usd(cents) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** A row of buttons, one of them pressed. */
export function segment(box, options, current, choose) {
  box.replaceChildren(
    ...options.map(([key, label]) =>
      el("button", {
        type: "button",
        text: label,
        class: key === current ? "on" : "",
        "aria-pressed": String(key === current),
        onclick: () => choose(key),
      }),
    ),
  );
}

/**
 * The Solana Pay code for `order` ({id, memo, cents, usdc, lamports, urls}),
 * asking `check` whether it is paid. SOL first: every wallet holds some, and a
 * wallet asked for a token it does not hold refuses the request. Once paid,
 * `paid` runs and the dialog says `done`; its button runs `finish`.
 *
 * @param {any} order
 * @param {{
 *   pull: (path: string) => Promise<any>, check: string, fine: string,
 *   done: { title: string, text: string }, paid?: () => void, finish: () => void,
 * }} opts
 */
export async function payDialog(order, { pull, check, fine, done, paid, finish }) {
  injectFormStyles();
  injectStyles("sp-css", CSS);
  let open = true;
  let fund = order.urls.sol ? "sol" : "usdc";
  const { body, close, setTitle } = dialog(`Pay ${usd(order.cents)}`, () => {
    open = false;
  });
  const funds = el("div", { class: "swx-seg sp-funds", role: "group", "aria-label": "Pay in" });
  const sum = el("div", { class: "swx-note" });
  const holder = el("div", { class: "swx-qr", role: "img", "aria-label": "Solana Pay QR code" });
  const status = el("div", { class: "swx-note", role: "status", text: "Waiting for the payment…" });
  body.replaceChildren(
    order.urls.sol ? funds : null,
    sum,
    holder,
    el("div", { class: "sp-memo" }, el("span", { text: "Memo" }), el("code", { text: order.memo })),
    el("p", { class: "sp-fine", text: fine }),
    status,
  );
  draw();

  async function draw() {
    segment(
      funds,
      [
        ["sol", "SOL"],
        ["usdc", "USDC"],
      ],
      fund,
      (key) => {
        fund = key;
        draw();
      },
    );
    sum.textContent =
      fund === "sol"
        ? `Scan with a Solana wallet to pay ${decimal(order.lamports, 9)} SOL (${usd(order.cents)}).`
        : `Scan with a Solana wallet to pay ${decimal(order.usdc, 6)} USDC (${usd(order.cents)}).`;
    try {
      const qr = await load("qr", "__qr");
      // Generated markup, built entirely by the encoder from the server's Solana Pay URL.
      if (holder.isConnected) holder.innerHTML = qr.svg(order.urls[fund]);
    } catch {
      holder.replaceChildren(el("div", { class: "swx-note err", text: "Could not draw the code." }));
    }
  }

  while (open) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (!open) return;
    try {
      const state = await pull(check);
      if (state.paid) return thanks();
      if (!state.open) {
        status.textContent = "This code has expired. Close it and check out again.";
        status.className = "swx-note err";
        return;
      }
    } catch {
      // A missed answer; the next one tells.
    }
  }

  function thanks() {
    paid?.();
    setTitle("Paid");
    const disc = el("div", { class: "swx-check", role: "img", "aria-label": "Paid" });
    const button = el("button", {
      class: "swx-go",
      type: "button",
      text: "Done",
      onclick: () => {
        close();
        finish();
      },
    });
    body.replaceChildren(
      el(
        "div",
        { class: "swx-done" },
        disc,
        el("div", { class: "swx-done-t", text: done.title }),
        el("div", { class: "swx-done-s", text: done.text }),
      ),
      button,
    );
    button.focus();
  }
}
