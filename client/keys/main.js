/**
 * The wallet page's dialogs: recovery phrase, receive, send, and what a token
 * we do not list says about itself. One lazy bundle, fetched the first time
 * any of them is opened.
 */
import { busy } from "../js/busy.js";
import { el } from "../js/dom.js";
import { dismissible } from "../js/sheet.js";
import { load } from "../js/lazy.js";
import { amount, dollars } from "../js/num.js";
import { assertion, why } from "../js/passkey.js";
import { livePrice } from "../js/price.js";
import { confirmSend } from "../js/sendconfirm.js";
import { dialog, injectStyles } from "../js/ui.js";
import CSS from "./keys.css";
import { mountHistory } from "../wallet/history.js";

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
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

/** A <dialog> that removes itself, and whatever it showed, when closed. */
function modal(title, ...kids) {
  injectStyles("ks-css", CSS);
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

function toDecimal(units, decimals) {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The phrase, behind the passkey and nothing else. An account without one is
 * pointed at Edit profile, where the password adds it.
 *
 * @param {{passkey: false | {id: string}}} me
 */
function phrase(me) {
  const err = el("p", { class: "ks-err", role: "alert" });
  const out = el("div", {});
  const key = me.passkey
    ? el("button", { type: "button", class: "ios-btn", text: "Show with passkey", onclick: viaPasskey })
    : el("p", { class: "ks-n" }, "Your recovery phrase is behind a passkey. ", el("a", { href: "/social/edit", text: "Add one in Edit profile" }), ".");

  function show(words) {
    key.hidden = true;
    err.textContent = "";
    out.replaceChildren(el("ol", { class: "ks-w" }, ...words.split(" ").map((word) => el("li", { text: word }))));
    // Same as the Social profile: the words do not outlast two minutes.
    setTimeout(() => out.replaceChildren(), 120_000);
  }

  function viaPasskey() {
    err.textContent = "";
    busy(key, async () => {
      const proof = await assertion(await send("/api/social/phrase/passkey/options"));
      show((await send("/api/social/phrase/passkey", proof)).phrase);
    }).catch((cause) => (err.textContent = why(cause)));
  }

  modal(
    "Recovery phrase",
    el("p", { class: "ks-n", text: "These 12 words control this wallet. Anyone who sees them can take everything in it." }),
    el("p", { class: "ks-n ks-warn", text: "Nobody from UtopianGO will ask for them." }),
    key,
    err,
    out,
  );
}

/** @param {{address: string}} me */
function receive(me) {
  const code = el("div", { class: "ks-qr", role: "img", "aria-label": "QR code of this wallet's address" });
  const copy = el("button", {
    type: "button",
    class: "ios-btn",
    text: "Copy Address",
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
    el("p", { class: "ks-n ks-c", text: "Send SOL or any Solana token to this address." }),
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

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE = /^@?([a-z0-9_]{3,16})$/i;
/** What the dropdown searches on: a name being typed, one letter in. */
const TYPING = /^@?([a-z0-9_]{1,16})$/i;

/** A @name or an address, as {name, address}. A bare address has no name. */
async function recipient(text) {
  if (ADDRESS.test(text)) return { name: "", address: text };
  const handle = text.match(HANDLE);
  if (!handle) throw new Error("Enter a @name or a Solana address.");
  const res = await fetch(`/api/social/u/${handle[1].toLowerCase()}`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user?.address) throw new Error(res.status === 404 ? `No one is called @${handle[1].toLowerCase()}.` : data.error || "Could not look that name up.");
  return { name: data.user.name, address: data.user.address };
}

/** The picture, or initials on a grey disc, as the account switcher draws them. */
function face(user) {
  if (user.avatarRev) {
    return el("img", { class: "ks-av", src: `/social/t/${user.name}?v=${user.avatarRev}`, alt: "", width: "32", height: "32", decoding: "async" });
  }
  return el("span", { class: "ks-av", "aria-hidden": "true", text: user.name.replace(/_/g, "").slice(0, 2).toUpperCase() });
}

/**
 * The wallet's Send: how many dollars, of which token, to whom, then the
 * confirmation every send goes through (js/sendconfirm.js), in the trade
 * dialog's shell.
 *
 * Everything is in dollars: the amount is typed in them and turned into the
 * token's base units at today's price, and no quantity of a token is shown.
 * A token with no price cannot be priced in dollars, so it is not offered.
 *
 * To takes a @name or an address. A name is looked up as it is typed, people
 * already added as friends first, and turned into its address on Review: the
 * confirmation shows both, the address in full.
 *
 * @param {{name: string, address: string, passkey: false | {id: string}}} me
 * @param {import('../../src/types').Holding[]} all
 * @param {() => void} onSent
 */
function transfer(me, all, onSent) {
  const holdings = all.filter((h) => Number.isFinite(h.price) && h.price > 0 && BigInt(h.amount) > 0n);
  const err = el("p", { class: "ks-err", role: "alert" });
  /** Today's price per mint: the holding's, then the last minute's once that is in. */
  const prices = new Map(holdings.map((h) => [h.mint, h.price]));
  const worth = (h, units) => (Number(units) / 10 ** h.decimals) * prices.get(h.mint);
  /** What can go: all of it, but SOL keeps the account's rent and the fee. */
  const sendable = (h) => {
    const units = BigInt(h.amount);
    if (h.mint !== SOL_MINT) return units;
    return units > SOL_KEEP ? units - SOL_KEEP : 0n;
  };
  const optionText = (h) => `${h.symbol} — ${dollars(worth(h, BigInt(h.amount)))}`;
  const options = holdings.map((h, i) => el("option", { value: String(i), text: optionText(h) }));
  const pick = el("select", { id: "ks-t" }, ...options);
  const held = () => holdings[Number(pick.value)];

  const to = el("input", {
    id: "ks-to",
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "@name or address",
    autocapitalize: "off",
    autocorrect: "off",
    maxlength: "44",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "ks-people",
  });
  const people = el("ul", { id: "ks-people", class: "ks-pp", role: "listbox", "aria-label": "People", hidden: true });

  // —— the amount, in dollars, as big as it fits ——

  const amount = el("input", {
    id: "ks-am",
    class: "ks-big",
    inputmode: "decimal",
    enterkeyhint: "done",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "0",
    "aria-label": "Amount in dollars",
  });
  const figure = el("div", { class: "ks-amt" }, el("span", { class: "ks-cur", "aria-hidden": "true", text: "$" }), amount);
  /** A share of what can go, in percent; 100 is Max. */
  const SHARES = [10, 25, 50, 100];
  const pills = SHARES.map((pct) =>
    el("button", {
      type: "button",
      class: "ks-pill",
      text: pct === 100 ? "Max" : `${pct}%`,
      "aria-pressed": "false",
      onclick: () => share(pct),
    }),
  );
  const go = el("button", { type: "submit", class: "ios-btn", text: "Send" });
  /** Base units Max chose, kept exact until the amount is typed over: dollars back to units would round. */
  let exact = null;

  /** Dollars as typed, cleaned to a number with at most two places. */
  function tidy() {
    let t = amount.value.replace(/[^\d.]/g, "");
    const dot = t.indexOf(".");
    if (dot >= 0) t = `${t.slice(0, dot + 1)}${t.slice(dot + 1).replace(/\./g, "").slice(0, 2)}`;
    t = t.replace(/^0+(?=\d)/, "");
    if (t.startsWith(".")) t = `0${t}`;
    if (t.length > 12) t = t.slice(0, 12);
    if (t !== amount.value) amount.value = t;
  }

  /** Big while it is short, smaller as it grows, so it always fits the row. */
  function size() {
    const text = amount.value || amount.placeholder;
    const n = text.length;
    const px = n <= 4 ? 72 : n <= 6 ? 60 : n <= 8 ? 48 : n <= 10 ? 40 : 34;
    figure.style.fontSize = `${px}px`;
    // As wide as what it holds: the $ sits right against the number, both centred.
    amount.style.width = `${Math.max(1, n) * 0.62 + 0.1}em`;
  }

  /** The dollars typed, or null. */
  const typedDollars = () => {
    const v = Number(amount.value);
    return amount.value && Number.isFinite(v) && v > 0 ? v : null;
  };

  /** The base units the dollars come to, or null. Typing the whole balance, to the cent, is all of it. */
  function units() {
    const h = held();
    if (exact != null) return exact;
    const usd = typedDollars();
    if (usd == null) return null;
    const price = prices.get(h.mint);
    let u = BigInt(Math.round((usd / price) * 10 ** h.decimals));
    const top = sendable(h);
    if (u > top && Math.round(usd * 100) <= Math.round(worth(h, top) * 100)) u = top;
    return u;
  }

  /** That share of what can go, in exact base units; the figure shows it cut to the cent. */
  function share(pct) {
    const h = held();
    exact = (sendable(h) * BigInt(pct)) / 100n;
    amount.value = (Math.floor(worth(h, exact) * 100) / 100).toFixed(2);
    label();
    pills.forEach((pill, i) => pill.setAttribute("aria-pressed", String(SHARES[i] === pct)));
  }

  function label() {
    size();
    const addr = to.value.trim();
    const h = held();
    const u = units();
    go.textContent = u && (ADDRESS.test(addr) || HANDLE.test(addr)) ? "Review" : "Send";
    // An address reads in the address face; a name in the text's own.
    to.classList.toggle("ks-mono", !TYPING.test(addr) && addr.length > 16);
    if (!h) return;
    // More than there is: the figure goes red, and Review says by how much.
    figure.classList.toggle("over", u != null && u > sendable(h));
    if (exact == null) for (const pill of pills) pill.setAttribute("aria-pressed", "false");
  }

  amount.addEventListener("input", () => {
    exact = null;
    tidy();
    label();
  });
  amount.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      to.value.trim() ? form.requestSubmit() : to.focus();
    }
  });
  pick.addEventListener("change", () => {
    exact = null;
    freshen();
    label();
  });

  const paste = navigator.clipboard?.readText
    ? el("button", {
        type: "button",
        class: "ios-mini",
        text: "Paste",
        onclick: async () => {
          try {
            to.value = (await navigator.clipboard.readText()).trim();
            shut();
            label();
          } catch {
            err.textContent = "The browser did not allow pasting. Paste into the field instead.";
          }
        },
      })
    : null;

  // —— To: the people dropdown ——

  let wait = 0;
  let gen = 0;
  /** The text the dropdown's rows were found for. */
  let shown = "";
  let active = -1;

  function rows() {
    return /** @type {HTMLElement[]} */ ([...people.querySelectorAll("[role=option]")]);
  }

  function shut() {
    gen += 1;
    clearTimeout(wait);
    shown = "";
    active = -1;
    people.hidden = true;
    people.replaceChildren();
    to.setAttribute("aria-expanded", "false");
    to.removeAttribute("aria-activedescendant");
  }

  function highlight(i) {
    const list = rows();
    active = i;
    list.forEach((row, n) => row.setAttribute("aria-selected", String(n === i)));
    if (list[i]) {
      to.setAttribute("aria-activedescendant", list[i].id);
      list[i].scrollIntoView({ block: "nearest" });
    } else to.removeAttribute("aria-activedescendant");
  }

  function choose(name) {
    to.value = `@${name}`;
    shut();
    label();
    to.blur();
  }

  function fill(users, q) {
    shown = q;
    active = -1;
    // Under the To row, wherever the form has put it.
    const row = /** @type {HTMLElement} */ (to.parentElement);
    people.style.top = `${row.offsetTop + row.offsetHeight + 4}px`;
    people.replaceChildren(
      ...(users.length
        ? users.map((user, i) => {
            const li = el(
              "li",
              { id: `ks-p${i}`, class: "ks-p", role: "option", "aria-selected": "false" },
              face(user),
              el("span", { class: "ks-pn", text: `@${user.name}` }),
              user.friend ? el("span", { class: "ks-pf", text: "Friend" }) : null,
            );
            // Pressed, not clicked: a click lands after the field's blur has shut the list.
            li.addEventListener("pointerdown", (e) => {
              e.preventDefault();
              choose(user.name);
            });
            return li;
          })
        : [el("li", { class: "ks-p0", text: "No one by that name." })]),
    );
    people.hidden = false;
    to.setAttribute("aria-expanded", "true");
  }

  function look() {
    const typed = to.value.trim();
    const m = typed.match(TYPING);
    if (!m) return shut();
    const q = m[1].toLowerCase();
    if (q === shown) return;
    const mine = ++gen;
    fetch(`/api/social/users?q=${q}`, { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (mine !== gen || document.activeElement !== to) return;
        const users = [...(data.users ?? [])].sort((a, b) => Number(b.friend) - Number(a.friend));
        // Typed out in full already: nothing left to pick.
        if (users.length === 1 && users[0].name === q && typed.startsWith("@")) return shut();
        fill(users, q);
      })
      .catch(() => {
        if (mine === gen) shut();
      });
  }

  to.addEventListener("input", () => {
    clearTimeout(wait);
    label();
    if (!TYPING.test(to.value.trim())) return shut();
    wait = setTimeout(look, 150);
  });
  to.addEventListener("focus", () => {
    if (TYPING.test(to.value.trim())) look();
  });
  to.addEventListener("blur", shut);
  to.addEventListener("keydown", (e) => {
    const list = rows();
    if (people.hidden || !list.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      highlight((active + step + list.length + (active < 0 && step < 0 ? 1 : 0)) % list.length);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(list[active].querySelector(".ks-pn").textContent.slice(1));
    } else if (e.key === "Escape") {
      // The list, not the whole dialog.
      e.stopPropagation();
      shut();
    }
  });

  const form = el(
    "form",
    { class: "ks-f" },
    figure,
    el("div", { class: "ks-avl", role: "group", "aria-label": "Share of the balance" }, ...pills),
    el(
      "div",
      { class: "ios-gp" },
      el("div", { class: "ios-fr" }, el("label", { for: "ks-t", text: "Token" }), pick),
      el("div", { class: "ios-fr" }, el("label", { for: "ks-to", text: "To" }), to, paste),
    ),
    people,
    go,
  );

  /** The last minute's price for a token, once asked: an index price can be an hour old. */
  const asked = new Set();
  function freshen() {
    const h = held();
    if (!h || asked.has(h.mint)) return;
    asked.add(h.mint);
    void livePrice(h.mint).then((price) => {
      if (price == null) return;
      prices.set(h.mint, price);
      const i = holdings.indexOf(h);
      if (options[i]) options[i].textContent = optionText(h);
      label();
    });
  }

  injectStyles("ks-css", CSS);
  const { body, close, setTitle } = dialog("Send");

  /** The form again, as it was left: Back from the confirmation. */
  function back() {
    setTitle("Send");
    body.replaceChildren(form, err);
    amount.focus();
  }

  let looking = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (looking) return;
    err.textContent = "";
    shut();
    const h = held();
    const typed = to.value.trim();
    const u = units();
    if (u == null || u <= 0n) return void (err.textContent = "Enter an amount in dollars.");
    if (u > sendable(h)) return void (err.textContent = `You have ${dollars(Math.floor(worth(h, sendable(h)) * 100) / 100)} of ${h.symbol} to send.`);
    if (!ADDRESS.test(typed) && !HANDLE.test(typed)) return void (err.textContent = "Enter a @name or a Solana address.");
    looking = true;
    go.disabled = true;
    let who;
    try {
      who = await recipient(typed);
    } catch (cause) {
      err.textContent = cause instanceof Error ? cause.message : "Could not look that name up.";
      return;
    } finally {
      looking = false;
      go.disabled = false;
    }
    if (who.address === me.address) return void (err.textContent = "That is this wallet's own address.");
    if (!form.isConnected) return;
    // The whole address is spelled out on the next screen, never shortened: a
    // lookalike that matches only its first and last few characters is
    // exactly how a poisoned address works.
    confirmSend(body, {
      me,
      token: { mint: h.mint, symbol: h.symbol, decimals: h.decimals, price: prices.get(h.mint) },
      amount: { units: u, text: toDecimal(u, h.decimals) },
      to: who.name ? who : { address: who.address },
      setTitle,
      back,
      close,
      sent: onSent,
      inDollars: true,
    });
  });

  body.append(
    holdings.length ? form : el("p", { class: "ks-n", text: "This wallet holds nothing with a price to send yet." }),
    err,
  );
  if (!holdings.length) return;
  label();
  freshen();
  // No keyboard thrown up over a phone's sheet, as in the trade dialog.
  if (window.matchMedia("(min-width: 521px)").matches) amount.focus();
}

/** The mint's two ends, enough to tell a row of them apart, as History shows them. */
function short(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
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
 * One token: the amount, its mint, and its supply once the chain has said.
 * @param {{mint: string, amount: string, decimals: number}} held
 * @param {import('../../src/types').TokenAsset | null} asset null while it is read, or when it could not be
 * @param {boolean} signed a transaction's change, which says + as well as −
 */
function tokenCard(held, asset, signed) {
  const a = asset ?? { mint: held.mint };
  const out = held.amount.startsWith("-");
  const units = held.amount.replace(/^-/, "");
  const sign = out ? "−" : signed ? "+" : "";
  const whole = amount(units, held.decimals).title ?? "0";
  const qty = `${sign}${whole} ${a.symbol || (whole === "1" ? "token" : "tokens")}`;
  const supply = a.supply && a.decimals != null ? amount(a.supply, a.decimals).title : null;
  const rows = [
    ["Mint", el("span", { class: "ks-mono", text: held.mint })],
    ["Supply", supply],
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
 * Tokens the index does not carry: how much of each, its mint and its supply.
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
      text: many ? "We don't list these so they have no price here." : "We don't list this so it has no price here.",
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

// History rides along too: only someone who presses it needs it, and the
// wallet page's own bundle has no room for it in its first flight.
window.__keys = { open: phrase, receive, send: transfer, tokens, history: mountHistory };
