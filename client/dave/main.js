/**
 * Dave — lazy-loaded by social.js on /social/dave, exposed as `window.__dave`.
 *
 * A chat with the agent in src/social/dave.ts. Chats are kept on this device
 * (localStorage, per account), listed in the menu, and each goes to the
 * server whole with every question; the server keeps none of them. When Dave prepares a trade it comes
 * back as a card, and the passkey is what turns that card into a swap.
 */
import { el } from "../js/dom.js";
import { assertion, why } from "../js/passkey.js";
import { injectStyles } from "../js/ui.js";
import CSS from "./dave.css";

/** Matches DAVE_TURNS and DAVE_CHARS in src/social/dave.ts. */
const TURNS = 16;
const CHARS = 1500;
/** Chats kept, and turns kept of each. */
const CHATS = 30;
const KEEP_TURNS = 40;

const HELLO = "Hi, I'm Dave. I can search the web, look at your wallet, prepare a trade for you to confirm with your passkey, or just chat.";
const IDEAS = ["What's new in Solana today?", "What's in my wallet?", "Buy $5 of BONK with SOL"];

/**
 * @typedef {{role: "user" | "assistant", text: string, trade?: any, sources?: {title: string, url: string}[], done?: string}} Turn
 * @typedef {{id: string, at: number, turns: Turn[]}} Chat
 */

/** This account's chats on this device, newest first. Empty where storage is refused. */
function readChats(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list.filter((c) => c && Array.isArray(c.turns)) : [];
  } catch {
    return [];
  }
}

function writeChats(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, CHATS).map((c) => ({ ...c, turns: c.turns.slice(-KEEP_TURNS) }))));
  } catch {
    // Private mode, or full: the chats last as long as the page.
  }
}

/** A chat's name in the menu: its first question. */
function titleOf(chat) {
  const first = chat.turns.find((t) => t.role === "user")?.text || "New chat";
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

const MENU_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const NEW_SVG =
  '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6z"/></svg>';

/** A button drawn with an inline icon. */
function iconButton(cls, label, svg) {
  const button = el("button", { type: "button", class: cls, "aria-label": label, title: label });
  button.innerHTML = svg;
  return button;
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

/** What the model reads back of a turn: a trade card is said in words. */
function spoken(t) {
  let text = t.text;
  if (t.trade) {
    const p = t.trade;
    text += `\n[Prepared trade: sell ${p.sell.amount} ${p.sell.symbol} for about ${p.buy.amount} ${p.buy.symbol}. ${t.done ? `Confirmed: ${t.done}` : "Not confirmed yet."}]`;
  }
  return { role: t.role, text: text.slice(-CHARS) };
}

/*
 * A phone's keyboard does not shrink the page: iOS pans the view up over it,
 * and the header goes off the top. While it is up, the page is fitted to what
 * the keyboard leaves and moved to where the view went (dave.css body.kb), as
 * Messenger does. Only on this page: social.js drops body.dave on leaving.
 */
const view = window.visualViewport;
const root = document.documentElement;
function fitKeyboard() {
  if (!document.body.classList.contains("dave")) return;
  const up = !!view && root.clientHeight - view.height > 120;
  document.body.classList.toggle("kb", up);
  if (up) {
    root.style.setProperty("--vvh", `${view.height}px`);
    root.style.setProperty("--vvt", `${view.offsetTop}px`);
  }
  const log = document.querySelector(".dv-log");
  if (log) log.scrollTop = log.scrollHeight;
}
view?.addEventListener("resize", fitKeyboard);
view?.addEventListener("scroll", fitKeyboard);

/** The header's middle: the robot and his name on one line, a line about him under it. */
function identity(line) {
  return el(
    "div",
    { class: "dv-id" },
    el("div", { class: "dv-nm" }, el("img", { src: "/ic-dave.svg", alt: "", width: "24", height: "24" }), el("h2", { text: "Dave" })),
    el("p", { class: "muted", text: line }),
  );
}

function mount(kit) {
  injectStyles("dv-css", CSS);
  document.body.classList.add("dave");
  const { main, send } = kit;
  kit.useSide(false);
  const me = kit.me();
  if (!me) {
    main.replaceChildren(
      el("section", { class: "dv" }, el("div", { class: "dv-hd" }, identity("Log in to chat with Dave.")),
        el("button", { type: "button", class: "go-pill dv-login", text: "Log in", onclick: () => kit.openAuth("login") })),
    );
    return;
  }

  const log = el("div", { class: "dv-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", { class: "dv-in", rows: "1", maxlength: String(CHARS), placeholder: "Message Dave", enterkeyhint: "send", "aria-label": "Message Dave" });
  const go = el("button", { type: "submit", class: "dv-go", "aria-label": "Send", text: "↑" });
  const form = el("form", { class: "dv-f" }, input, go);
  const menu = iconButton("dv-ib", "Chats", MENU_SVG);
  const fresh = iconButton("dv-ib", "New chat", NEW_SVG);
  const key = `dave:chats:${me.name}`;
  let busy = false;
  let chats = readChats(key);
  /** The open chat. A new one joins the list with its first question. */
  let chat = chats[0] ?? { id: "", at: 0, turns: [] };
  let turns = chat.turns;

  function keep() {
    if (!chat.id) {
      if (!turns.length) return;
      chat.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    chat.at = Date.now();
    chats = [chat, ...readChats(key).filter((c) => c.id !== chat.id)];
    writeChats(key, chats);
  }

  function open(next) {
    if (busy) return;
    chat = next;
    turns = chat.turns;
    paint();
  }

  function bubble(t) {
    const box = el("div", { class: `dv-m dv-${t.role === "user" ? "u" : "a"}` }, el("p", {}, ...linked(t.text)));
    if (t.sources?.length) {
      box.append(
        el("div", { class: "dv-src" }, ...t.sources.slice(0, 3).map((s) => el("a", { href: s.url, target: "_blank", rel: "noopener nofollow", text: s.title || s.url }))),
      );
    }
    if (t.trade) box.append(card(t));
    return box;
  }

  /** A prepared trade, and the passkey button that makes it happen. */
  function card(t) {
    const p = t.trade;
    const note = el("p", { class: "dv-note" });
    const ok = el("button", { type: "button", class: "go-pill dv-ok", text: "Confirm with passkey" });
    const box = el(
      "div",
      { class: "dv-tr" },
      el("div", { class: "dv-row" }, el("span", { class: "muted", text: "Sell" }), el("b", { text: `${num(p.sell.amount)} ${p.sell.symbol}` })),
      el("div", { class: "dv-row" }, el("span", { class: "muted", text: "Get about" }), el("b", { text: `${num(p.buy.amount)} ${p.buy.symbol}` })),
      p.usd ? el("div", { class: "dv-row" }, el("span", { class: "muted", text: "Worth" }), el("span", { text: `$${p.usd.toLocaleString("en-US")}` })) : null,
      el("div", { class: "dv-row" }, el("span", { class: "muted", text: "Max slippage" }), el("span", { text: `${p.slippageBps / 100}%` })),
      ok,
      note,
    );
    if (t.done) return finished(box, t.done);
    if (!kit.me()?.passkey) {
      ok.replaceWith(el("a", { class: "go-pill dv-ok", href: "/social/edit", text: "Add a passkey to trade" }));
      return box;
    }
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      note.textContent = "";
      note.className = "dv-note";
      ok.textContent = "Confirming…";
      try {
        const proof = await assertion(await send("/api/social/dave/trade/options"));
        ok.textContent = "Trading…";
        const sent = await send("/api/social/dave/trade", {
          inputMint: p.inputMint,
          outputMint: p.outputMint,
          amount: p.amount,
          quotedOut: p.quotedOut,
          slippageBps: p.slippageBps,
          ...proof,
        });
        t.done = sent.signature;
        keep();
        finished(box, sent.signature, !sent.confirmed);
      } catch (cause) {
        ok.disabled = false;
        ok.textContent = "Confirm with passkey";
        note.textContent = why(cause);
        note.className = "dv-note err";
      }
    });
    return box;
  }

  function finished(box, signature, pending = false) {
    box.querySelector(".dv-ok")?.remove();
    const note = box.querySelector(".dv-note");
    note.className = "dv-note ok";
    note.replaceChildren(
      pending ? "Sent, still confirming. " : "Done. ",
      el("a", { href: `https://solscan.io/tx/${signature}`, target: "_blank", rel: "noopener", text: "View transaction" }),
    );
    return box;
  }

  function paint() {
    log.replaceChildren(bubble({ role: "assistant", text: HELLO }), ...turns.map(bubble));
    if (!turns.length) {
      log.append(el("div", { class: "dv-ideas" }, ...IDEAS.map((idea) => el("button", { type: "button", text: idea, onclick: () => ask(idea) }))));
    }
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    text = text.trim().slice(0, CHARS);
    if (!text || busy) return;
    busy = true;
    go.disabled = true;
    input.value = "";
    size();
    turns.push({ role: "user", text });
    keep();
    paint();
    const thinking = el("div", { class: "dv-m dv-a dv-wait", "aria-label": "Dave is thinking" }, el("i"), el("i"), el("i"));
    log.append(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      const reply = await send("/api/social/dave", { turns: turns.slice(-TURNS).map(spoken) });
      turns.push({ role: "assistant", text: reply.text, trade: reply.trade, sources: reply.sources });
    } catch (cause) {
      // Not kept as Dave's turn: the question stays, to be asked again.
      thinking.replaceWith(el("p", { class: "err dv-m", text: cause.message }));
      turns.pop();
      keep();
      busy = false;
      go.disabled = false;
      input.value = text;
      return;
    }
    keep();
    busy = false;
    go.disabled = false;
    paint();
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
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ask(input.value);
  });
  fresh.addEventListener("click", () => {
    open({ id: "", at: 0, turns: [] });
    input.focus();
  });

  /** The menu: every chat on this device, newest first, to open or delete. */
  menu.addEventListener("click", () => {
    const opener = document.activeElement;
    const list = el("ul", { class: "dv-list" });
    const close = () => {
      document.removeEventListener("keydown", onKey);
      sheet.remove();
      /** @type {HTMLElement} */ (opener)?.focus?.();
    };
    const onKey = (e) => e.key === "Escape" && close();
    const draw = () => {
      chats = readChats(key);
      list.replaceChildren(
        ...chats.map((c) => {
          const row = el(
            "li",
            { class: c.id === chat.id ? "on" : "" },
            el("button", { type: "button", class: "dv-open", onclick: () => (open(c), close()) }, el("span", { text: titleOf(c) }), el("small", { class: "muted", text: kit.ago(c.at) })),
            el("button", {
              type: "button",
              class: "dv-del",
              "aria-label": `Delete “${titleOf(c)}”`,
              text: "×",
              onclick: () => {
                writeChats(key, readChats(key).filter((x) => x.id !== c.id));
                if (c.id === chat.id) open(readChats(key)[0] ?? { id: "", at: 0, turns: [] });
                draw();
              },
            }),
          );
          return row;
        }),
      );
      if (!chats.length) list.append(el("li", { class: "muted dv-none", text: "No chats yet." }));
    };
    const panel = el(
      "nav",
      { class: "dv-panel", "aria-label": "Chats with Dave" },
      el("div", { class: "dv-ph" }, el("h3", { text: "Chats" }), el("button", { type: "button", class: "dv-ib", "aria-label": "Close", text: "×", onclick: close })),
      el("button", { type: "button", class: "go-pill dv-start", text: "New chat", onclick: () => (fresh.click(), close()) }),
      list,
      el("a", { class: "dv-back", href: "/social", text: "← Back to Social" }),
    );
    const sheet = el("div", { class: "dv-sheet" }, el("div", { class: "dv-veil", onclick: close }), panel);
    draw();
    document.body.append(sheet);
    document.addEventListener("keydown", onKey);
    panel.querySelector(".dv-start").focus();
  });

  main.replaceChildren(
    el(
      "section",
      { class: "dv" },
      el("div", { class: "dv-hd" }, menu, identity("Search, trade, or just chat."), fresh),
      log,
      form,
    ),
  );
  paint();
}

window.__dave = { mount };
