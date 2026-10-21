/**
 * Dave — the script of his own page, /dave (client/dave.html).
 *
 * A chat with the agent in src/social/dave.ts. Chats are kept on the server,
 * per account, so they follow the person to any device; the menu lists them.
 * The page sends each question and which chat it is in, and draws what comes
 * back. When Dave prepares a trade it comes back as a card, and the passkey
 * is what turns that card into a swap.
 *
 * The document already holds the header, the greeting and the field. This
 * file asks who is signed in and brings them to life. It and the document
 * share a 14 KB budget, so it borrows only the smallest helpers, and the Log
 * in dialog is its own bundle, fetched by the few who need it.
 */
import { $, el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { assertion, why } from "../js/passkey.js";

/** Matches DAVE_CHARS and DAVE_KEEP in src/social/dave.ts. */
const CHARS = 1500;
const KEEP = 200;

const IDEAS = ["What's new in Solana today?", "What's in my wallet?", "Buy $5 of BONK with SOL"];

/**
 * @typedef {{role: "user" | "assistant", text: string, trade?: any, sources?: {title: string, url: string}[], done?: string}} Turn
 * @typedef {{id: string, title: string, at: number}} Head
 */

const log = $("dv-log");
const hello = /** @type {HTMLElement} */ (log.firstElementChild);
const input = /** @type {HTMLTextAreaElement} */ ($("dv-in"));
const go = /** @type {HTMLButtonElement} */ ($("dv-go"));
const menu = $("dv-menu");
const fresh = $("dv-new");

/** @type {null | {name: string, passkey: false | {id: string}}} */
let me = null;
let busy = false;
/** @type {Head[]} The menu, newest first. */
let chats = [];
/** The open chat; a new one has no id until its first answer. */
let chat = { id: "", turns: /** @type {Turn[]} */ ([]) };

/** JSON in, JSON out; a refusal throws its message. */
async function pull(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) me = null;
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function ago(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Text with its web addresses as links. */
function linked(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    out.push(text.slice(at, m.index));
    out.push(el("a", { href: m[0], target: "_blank", rel: "noopener nofollow", text: m[0].replace(/^https?:\/\/(www\.)?/, "") }));
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out;
}

/** A decimal string with thousands separators. */
const num = (text) => Number(text).toLocaleString("en-US", { maximumFractionDigits: 6 });

/*
 * A phone's keyboard does not shrink the page: iOS pans the view up over it,
 * and the header goes off the top. While it is up, the page is fitted to what
 * the keyboard leaves and moved to where the view went (dave.css body.kb), as
 * Messenger does: the header stays at the top and the field on the keyboard.
 */
const view = window.visualViewport;
const root = document.documentElement;
function fitKeyboard() {
  const up = !!view && root.clientHeight - view.height > 120;
  document.body.classList.toggle("kb", up);
  if (up) {
    root.style.setProperty("--vvh", `${view.height}px`);
    root.style.setProperty("--vvt", `${view.offsetTop}px`);
  }
  log.scrollTop = log.scrollHeight;
}
view?.addEventListener("resize", fitKeyboard);
view?.addEventListener("scroll", fitKeyboard);

function bubble(t, index) {
  // Whole class names, not pieces: the build prunes the sheet to names it finds written here.
  const box = el("div", { class: t.role === "user" ? "dv-m dv-u" : "dv-m dv-a" }, el("p", {}, ...linked(t.text)));
  if (t.sources?.length) {
    box.append(el("div", { class: "dv-src" }, ...t.sources.slice(0, 3).map((s) => el("a", { href: s.url, target: "_blank", rel: "noopener nofollow", text: s.title || s.url }))));
  }
  if (t.trade) box.append(card(t, index));
  return box;
}

/** A prepared trade, and the passkey button that makes it happen. */
function card(t, index) {
  const p = t.trade;
  const row = (k, v, strong) => el("div", { class: "dv-row" }, el("span", { class: "dv-mu", text: k }), el(strong ? "b" : "span", { text: v }));
  const note = el("p", { class: "dv-note" });
  const ok = el("button", { type: "button", class: "dv-ok", text: "Confirm with passkey" });
  const box = el(
    "div",
    { class: "dv-tr" },
    row("Sell", `${num(p.sell.amount)} ${p.sell.symbol}`, true),
    row("Get about", `${num(p.buy.amount)} ${p.buy.symbol}`, true),
    p.usd ? row("Worth", `$${p.usd.toLocaleString("en-US")}`) : null,
    row("Max slippage", `${p.slippageBps / 100}%`),
    ok,
    note,
  );
  if (t.done) return finished(box, t.done);
  if (!me?.passkey) {
    ok.replaceWith(el("a", { class: "dv-ok", href: "/social/edit", text: "Add a passkey to trade" }));
    return box;
  }
  const asked = chat;
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    note.textContent = "";
    note.className = "dv-note";
    ok.textContent = "Confirming…";
    try {
      const proof = await assertion(await pull("/api/social/dave/trade/options", "POST", {}));
      ok.textContent = "Trading…";
      // Which trade, not what: the server reads it back from the chat.
      const sent = await pull("/api/social/dave/trade", "POST", { chat: asked.id, index, ...proof });
      t.done = sent.signature;
      finished(box, sent.signature, !sent.confirmed);
    } catch (cause) {
      ok.disabled = false;
      ok.textContent = "Confirm with passkey";
      note.textContent = why(cause);
      note.className = "dv-note dv-err";
    }
  });
  return box;
}

function finished(box, signature, pending = false) {
  box.querySelector(".dv-ok")?.remove();
  const note = box.querySelector(".dv-note");
  note.className = "dv-note dv-done";
  note.replaceChildren(
    pending ? "Sent, still confirming. " : "Done. ",
    el("a", { href: `https://solscan.io/tx/${signature}`, target: "_blank", rel: "noopener", text: "View transaction" }),
  );
  return box;
}

function paint() {
  log.replaceChildren(hello, ...chat.turns.map((t, i) => bubble(t, i)));
  if (!chat.turns.length) {
    log.append(el("div", { class: "dv-ideas" }, ...IDEAS.map((idea) => el("button", { type: "button", text: idea, onclick: () => ask(idea) }))));
  }
  log.scrollTop = log.scrollHeight;
}

/** Open a chat: a new one (null), or one of the menu's, read from the server. */
async function open(head) {
  if (busy) return;
  if (!head) {
    chat = { id: "", turns: [] };
    return paint();
  }
  busy = true;
  try {
    const { chat: found } = await pull(`/api/social/dave/chats/${encodeURIComponent(head.id)}`);
    chat = { id: found.id, turns: found.turns };
    paint();
  } catch (cause) {
    log.replaceChildren(hello, el("p", { class: "dv-m dv-err", text: cause.message }));
  } finally {
    busy = false;
  }
}

/** Signed out: the field and the menu ask you to log in, and come back signed in. */
function logIn() {
  load("lg", "__login").then((login) => login.open("login", () => location.reload()), () => location.assign("/wallet"));
}

async function ask(text) {
  text = text.trim().slice(0, CHARS);
  if (!text || busy) return;
  if (!me) return logIn();
  busy = true;
  go.disabled = true;
  input.value = "";
  size();
  log.querySelector(".dv-ideas")?.remove();
  log.append(bubble({ role: "user", text }, -1));
  const thinking = el("div", { class: "dv-m dv-a dv-wait", "aria-label": "Dave is thinking" }, el("i"), el("i"), el("i"));
  log.append(thinking);
  log.scrollTop = log.scrollHeight;
  const asked = chat;
  try {
    const reply = await pull("/api/social/dave", "POST", { chat: asked.id, text });
    asked.id = reply.chat.id;
    asked.turns.push(...reply.turns);
    // As the server trims, so a trade's place in the chat is the same on both sides.
    if (asked.turns.length > KEEP) asked.turns.splice(0, asked.turns.length - KEEP);
    chats = [reply.chat, ...chats.filter((c) => c.id !== reply.chat.id)];
  } catch (cause) {
    // Not kept by the server either: the question goes back in the field, to ask again.
    thinking.replaceWith(el("p", { class: "dv-m dv-err", text: cause.message }));
    if (!input.value) input.value = text;
    size();
    return;
  } finally {
    busy = false;
    go.disabled = false;
  }
  if (asked === chat) paint();
}

/** The field grows with what is typed, up to a few lines. */
function size() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

input.addEventListener("input", size);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(input.value);
  }
});
$("dv-f").addEventListener("submit", (e) => {
  e.preventDefault();
  ask(input.value);
});
fresh.addEventListener("click", () => {
  open(null);
  input.focus();
});

/** The menu: every chat on the account, newest first, to open or delete. */
menu.addEventListener("click", () => {
  if (!me) return logIn();
  const list = el("ul", { class: "dv-list" });
  const close = () => {
    document.removeEventListener("keydown", onKey);
    sheet.remove();
    menu.focus();
  };
  const onKey = (e) => e.key === "Escape" && close();
  const draw = () => {
    list.replaceChildren(
      ...chats.map((c) =>
        el(
          "li",
          { class: c.id === chat.id ? "on" : "" },
          el("button", { type: "button", class: "dv-open", onclick: () => (close(), open(c)) }, el("span", { text: c.title }), el("small", { text: ago(c.at) })),
          el("button", {
            type: "button",
            class: "dv-del",
            "aria-label": `Delete “${c.title}”`,
            text: "×",
            onclick: async () => {
              try {
                chats = (await pull(`/api/social/dave/chats/${encodeURIComponent(c.id)}`, "DELETE")).chats;
              } catch {
                return;
              }
              if (c.id === chat.id) open(null);
              draw();
            },
          }),
        ),
      ),
    );
    if (!chats.length) list.append(el("li", { class: "dv-none", text: "No chats yet." }));
  };
  const start = el("button", { type: "button", class: "dv-ok dv-start", text: "New chat", onclick: () => (close(), fresh.click()) });
  const panel = el(
    "nav",
    { class: "dv-panel", "aria-label": "Chats with Dave" },
    el("div", { class: "dv-ph" }, el("h2", { text: "Chats" }), el("button", { type: "button", class: "dv-ib", "aria-label": "Close", text: "×", onclick: close })),
    start,
    list,
    el("div", { class: "dv-out" }, el("a", { href: "/", text: "Search" }), el("a", { href: "/wallet", text: "Wallet" }), el("a", { href: "/social", text: "Social" })),
  );
  const sheet = el("div", { class: "dv-sheet" }, el("div", { class: "dv-veil", onclick: close }), panel);
  draw();
  // The list as the server has it now: another device may have added to it.
  pull("/api/social/dave/chats").then((data) => {
    chats = data.chats;
    if (sheet.isConnected) draw();
  }, () => {});
  document.body.append(sheet);
  document.addEventListener("keydown", onKey);
  start.focus();
});

paint();
pull("/api/social/me").then(
  async (data) => {
    me = data.me;
    if (!me) {
      $("dv-line").textContent = "Log in to chat with Dave.";
      input.placeholder = "Log in to message Dave";
      return;
    }
    // The latest chat, as on any device the person last used.
    chats = (await pull("/api/social/dave/chats")).chats;
    if (chats[0] && !chat.id && !chat.turns.length && !busy) open(chats[0]);
  },
  () => {},
);
