/**
 * Timeline, profile, friends.
 *
 * The document is static. This file asks who you are and fills the column.
 * Pictures are scaled here, before they are uploaded: the server only checks
 * the result, and the aspect ratio is kept by scaling both sides together.
 */
import { $, el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { LOGIN } from "../js/acct.js";
import { noZoom } from "../js/device.js";
import { open as openLogin } from "../js/login.js";
import { readName, writeName } from "../js/me.js";
import { dismissible } from "../js/sheet.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";
import { mountPwa } from "../js/pwa.js";
import { connect, settled, signAndSend } from "../js/wallet.js";
import { toBase58 } from "../swap/jup.js";

const main = $("m");
/** Matches MAX_POST in src/social/limits.ts. */
const MAX_POST = 256;

/** @type {null | {name: string, address: string, bio: string, loc: string, avatarRev: number, passkey: boolean, wait: number, unseen: number}} */
let me = null;
/** Object URLs of photos in an open composer, freed when the page is redrawn. */
const drafts = [];
/** A link sent over by a search result's Comment button, for the next composer. */
let handed = new URLSearchParams(location.search).get("text") || "";

function ago(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function waitLabel(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return `You can post again in ${min} min.`;
}

function route() {
  const m = location.pathname
    .replace(/\/+$/, "")
    .match(
      /^\/social(?:\/(saved|friends|edit|c)|\/p\/([A-Za-z0-9_-]{1,32})|\/u\/([a-z0-9_]{3,16})|\/c\/[a-z0-9_]{3,16})?$/,
    );
  if (!m) return { page: "missing" };
  if (m[1] === "c" || location.pathname.startsWith("/social/c/")) return { page: "chat" };
  if (m[2]) return { page: "post", id: m[2] };
  if (m[3]) return { page: "profile", name: m[3] };
  return { page: m[1] || "timeline" };
}

function applyMe(next) {
  me = next;
  const link = $("me");
  const badge = $("badge");
  const search = document.querySelector("#ac .ac-b");
  // My Profile always shows, so the tab bar never reflows once the session is known.
  $("out").hidden = $("aw").hidden = !me;
  $("in").hidden = !!me;
  // Logged out, the side panel (with Log in) is the left column, as in Messenger.
  document.body.classList.toggle("out", !me);
  if (search) search.hidden = !!me;
  const unread = $("mbadge");
  badge.hidden = !(me?.unseen > 0);
  unread.hidden = !(me?.unread > 0);
  link.href = me ? `/social/u/${me.name}` : "/social";
  if (!me) return;
  badge.textContent = me.unseen;
  unread.textContent = me.unread;
}

function markNav() {
  const { page, name } = route();
  // "profile" is the My Profile tab, so another person's page must not light it.
  const key =
    page === "edit"
      ? "profile"
      : page !== "profile"
        ? page
        : me && name === me.name
          ? page
          : "";
  for (const a of document.querySelectorAll("#tb [data-nav]")) {
    const on = a.dataset.nav === key;
    a.classList.toggle("on", on);
    // Phones have no Saved tab: it is a switch inside Timeline, which stays lit.
    a.classList.toggle("up", key === "saved" && a.dataset.nav === "timeline");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const titles = {
    timeline: "Timeline",
    saved: "Saved",
    edit: "Edit profile",
    friends: "Friends",
    post: "Post",
    chat: "Messenger",
  };
  document.title = `${titles[page] || name || "Social"} — Social`;
}

/**
 * JSON in, JSON out. A 401 means the session is gone, so the header forgets
 * who you are. A wrong password while signed in is a 403 and changes nothing.
 */
async function pull(path, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  const body = opts.body;
  if (body instanceof Blob) headers["Content-Type"] = body.type || "image/jpeg";
  else if (body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method: opts.method || "GET", headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    applyMe(null);
    writeName("");
  } else if (data.me !== undefined) {
    applyMe(data.me);
    writeName(data.me?.name);
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

/** POST a JSON object. */
function send(path, obj) {
  return pull(path, { method: "POST", body: JSON.stringify(obj || {}) });
}

/** The one login dialog (client/js/login.js); signed in, the page redraws. */
function openAuth(next) {
  openLogin(next, show);
}

/**
 * One picture, several JPEGs of it, one per `[edge, byWidth, maxBytes, quality]`.
 *
 * `portrait` is the profile photo's rule: wider than tall is refused before
 * any draw, so every copy keeps the shape the profile shows. Each copy starts
 * at its edge and steps quality down, then size, until it fits.
 * @param {File} file
 * @returns {Promise<Blob[]>}
 */
async function shrink(file, sizes, portrait) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(file);
  }
  try {
    if (portrait && bmp.width > bmp.height) throw new Error("Use a square or portrait photo.");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not read that photo.");
    const out = [];
    next: for (let [edge, byWidth, maxBytes, quality] of sizes) {
      // The timeline face caps width, not the long side, so a portrait stays tall.
      const scale = Math.min(1, edge / (byWidth ? bmp.width : Math.max(bmp.width, bmp.height)));
      let w = Math.max(1, Math.round(bmp.width * scale));
      let h = Math.max(1, Math.round(bmp.height * scale));
      for (let i = 0; i < 12; i++) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= maxBytes) {
          out.push(blob);
          continue next;
        }
        if (quality > 0.45) quality = Math.round((quality - 0.1) * 100) / 100;
        else {
          w = Math.max(1, Math.round(w * 0.8));
          h = Math.max(1, Math.round(h * 0.8));
          quality = 0.6;
        }
      }
      throw new Error("Could not fit that photo.");
    }
    return out;
  } finally {
    bmp.close();
  }
}

/** Two big-endian u32 lengths, the header in front of each pair of JPEGs. */
function lens(a, b) {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, a.size);
  view.setUint32(4, b.size);
  return view;
}

/** The Blob holds the parts by reference, so no JPEG is copied to pack it. */
function bin(parts) {
  return new Blob(parts, { type: "application/octet-stream" });
}

/** u16 text length, the text, a photo count, then each phone and desktop JPEG. */
function packPost(text, shots) {
  const encoded = new TextEncoder().encode(text);
  const head = new Uint8Array(3 + encoded.length);
  new DataView(head.buffer).setUint16(0, encoded.length);
  head.set(encoded, 2);
  head[2 + encoded.length] = shots.length;
  return bin([head, ...shots.flatMap((s) => [lens(s.small, s.full), s.small, s.full])]);
}

/** A web address, or an @name. The address is tried first, so a name inside one stays part of it. */
const LINK = /(https?:\/\/|www\.)[^\s<>"]+|(^|[^a-z0-9_])@([a-z0-9_]{3,16})/gi;

/** Drops the punctuation a sentence puts after an address, and a ")" that closes the sentence's bracket rather than the address's. */
function trimUrl(raw) {
  let url = raw;
  for (;;) {
    const end = url.at(-1);
    if (/[.,;:!?'\]]/.test(end) || (end === ")" && url.split(")").length > url.split("(").length)) url = url.slice(0, -1);
    else return url;
  }
}

/** An anchor for an address typed into a post, or null when it does not parse. */
function webLink(url) {
  const href = /^www\./i.test(url) ? `https://${url}` : url;
  try {
    new URL(href);
  } catch {
    return null;
  }
  const bare = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return el("a", {
    href,
    target: "_blank",
    rel: "noopener nofollow ugc",
    title: href,
    text: bare.length > 40 ? `${bare.slice(0, 39)}…` : bare,
  });
}

function linkedText(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match[1]) {
      const url = trimUrl(match[0]);
      const link = webLink(url);
      if (!link) continue;
      frag.append(text.slice(last, match.index), link);
      last = match.index + url.length;
      continue;
    }
    const start = match.index + match[2].length;
    frag.append(text.slice(last, start));
    const name = match[3].toLowerCase();
    frag.append(el("a", { href: `/social/u/${name}`, text: `@${name}` }));
    last = start + match[0].length - match[2].length;
  }
  frag.append(text.slice(last));
  return frag;
}

/**
 * 200px wide, height from the file. No picture until one has been uploaded.
 * The height attribute only reserves a square until the file says otherwise.
 */
function photo(name, rev) {
  if (!rev) return null;
  return el("img", { class: "pfp", src: `/social/a/${name}?v=${rev}`, alt: "", width: "200", height: "200" });
}

/** Who the open pay dialog is for. */
let paying = { address: "", name: "" };
/** The code last asked for. A slower draw of an older amount must not win. */
let want = "";

/** A Solana Pay request. A wallet that scans it can send the amount. */
function payUri(address, name, amount) {
  const params = new URLSearchParams();
  if (amount) params.set("amount", amount);
  if (name) params.set("label", name);
  const query = params.toString();
  return query ? `solana:${address}?${query}` : `solana:${address}`;
}

function solAmount(text) {
  const value = text.trim();
  if (!/^\d{1,7}(\.\d{1,9})?$/.test(value) || Number(value) <= 0) return "";
  return value;
}

/** Copy the address, then show a code a wallet can pay. */
function walletButton(address, name) {
  if (!address) return null;
  return el("button", { type: "button", class: "qr", text: "Pay via QR code", onclick: () => openWallet(address, name || "") });
}

/** The encoder is the buy dialog's, fetched only when someone asks for a code. */
async function drawPayCode() {
  const code = $("qc");
  const payload = (want = payUri(paying.address, paying.name, solAmount($("pamt").value)));
  let svg;
  try {
    svg = (await load("qr", "__qr")).svg(payload);
  } catch {
    svg = "";
  }
  if (payload !== want) return;
  if (svg) code.innerHTML = svg;
  else code.replaceChildren(el("p", { class: "err", text: "Could not draw the code." }));
}

async function openWallet(address, name) {
  paying = { address, name };
  const copied = $("qk");
  const own = me?.address === address;
  const pay = $("py");
  copied.hidden = $("pok").hidden = true;
  $("pe").textContent = $("pamt").value = "";
  pay.hidden = own;
  pay.disabled = false;
  $("phint").textContent = own ? "Show this code to get paid." : "Your wallet signs this payment.";
  $("qt").textContent = own ? "Your wallet" : `Pay ${name}`;
  $("qc").replaceChildren(el("p", { class: "muted", text: "…" }));
  $("qa").textContent = address;
  $("qd").showModal();
  try {
    await navigator.clipboard.writeText(address);
    copied.hidden = false;
  } catch {
    copied.hidden = true;
  }
  await drawPayCode();
}

/** Hide the profile card. Login stays in the sidebar when nobody is signed in. */
function useSide(show) {
  $("sd").hidden = !show;
  $("mn").classList.toggle("solo", !show);
}

/** The feed pages: no card when signed in, the Log in prompt when not. */
function sideOff() {
  if (me) useSide(false);
  else renderSide(null);
}

function renderSide(person) {
  useSide(true);
  const side = $("side");
  if (!person) {
    side.replaceChildren(
      el("p", { class: "ld", text: "Log in to post, add friends, and keep a profile." }),
      el("button", { type: "button", class: "ac-go", text: LOGIN, onclick: () => openAuth("login") }),
    );
    return;
  }
  const bits = [
    photo(person.name, person.avatarRev),
    el(
      "div",
      { class: "name" },
      el("h2", { text: person.name }),
      person.loc ? el("span", { class: "muted", text: `[${person.loc}]` }) : null,
    ),
    person.bio ? el("p", { class: "ld", text: person.bio }) : null,
    walletButton(person.address, person.name),
    !me
      ? null
      : me.name === person.name
        ? el("a", { class: "dm", href: "/social/edit", text: "Edit profile" })
        : el("a", {
            class: "dm",
            href: `/social/c/${person.name}`,
            text: "Message",
          }),
  ];
  side.replaceChildren(...bits.filter(Boolean));
}

/** The post open on /social/p/:id. Null on every other page. */
let detail = null;

function commentList(comments) {
  const list = el("ul", { class: "comments" });
  for (const comment of comments || []) {
    list.append(
      el(
        "li",
        { class: "comment" },
        thumb(comment.by, comment.avatarRev),
        el(
          "div",
          { class: "comment-main" },
          el("a", { href: `/social/u/${comment.by}`, text: comment.by, class: "who" }),
          " ",
          linkedText(comment.text),
        ),
      ),
    );
  }
  return list;
}

function commentForm(post) {
  if (!me) return null;
  const input = el("input", { maxlength: "160", placeholder: "Comment", "aria-label": "Comment" });
  const button = el("button", { type: "submit", text: "Reply" });
  const err = el("p", { class: "err" });
  const form = el("form", { class: "cmt" }, input, button);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    button.disabled = true;
    try {
      const result = await send("/api/social/comment", { post: post.id, text: input.value });
      if (detail && detail.post.id === post.id) {
        detail.comments.push(result.comment);
        detail.post.comments += 1;
        paintDetail();
      } else show();
    } catch (cause) {
      err.textContent = cause.message;
      button.disabled = false;
    }
  });
  return el("div", { class: "reply" }, form, err);
}

/**
 * Save or re-post, then redraw only that post. An error borrows the label for
 * a moment and gives it back, so the button still says what it does.
 */
function react(kind, post, inDetail, label, props) {
  const button = el("button", { type: "button", class: "act", text: label, ...props });
  button.addEventListener("click", async () => {
    if (!me) return openAuth("login");
    button.disabled = true;
    try {
      const data = await send(`/api/social/${kind}`, { post: post.id });
      if (kind === "plus") post.saved = data.saved;
      else post.reposted = true;
      const card = button.closest("article");
      // Un-saving on the Saved page takes the post off that list.
      if (!post.saved && kind === "plus" && route().page === "saved") card.remove();
      else card.replaceWith(renderPost(post, inDetail));
    } catch (cause) {
      button.textContent = cause.message;
      setTimeout(() => {
        button.textContent = label;
        button.disabled = false;
      }, 3000);
    }
  });
  return button;
}

function postActions(post, inDetail, comments) {
  const plus = react("plus", post, inDetail, post.saved ? "−" : "+", {
    class: post.saved ? "act plus saved" : "act plus",
    "aria-label": post.saved ? "Remove from saved" : "Save",
  });
  // A re-post already points at an original. Another re-post would chain a copy.
  const repost = post.repost
    ? null
    : react("repost", post, inDetail, post.reposted ? "reposted" : "re-post", { disabled: post.reposted });
  return el("div", { class: "acts" }, plus, comments, repost);
}

/** Timeline face: the small file, 40px wide, a square until the file loads. */
function face(name, rev) {
  if (!rev) return null;
  return el("img", { class: "mini", src: `/social/t/${name}?v=${rev}`, alt: "", width: "40", height: "40" });
}

function thumb(name, rev) {
  const img = face(name, rev);
  if (!img) return null;
  return el("a", { href: `/social/u/${name}`, class: "mini-link" }, img);
}

/** Pictures in a row. A re-post shows the original's files. */
function gallery(post) {
  const n = post.photos || 0;
  if (!n) return null;
  const id = post.repost || post.id;
  const row = el("div", { class: "gallery", role: "group", "aria-label": "Photos" });
  for (let i = 0; i < n; i++) {
    row.append(
      el(
        "picture",
        {},
        el("source", { media: "(max-width: 900px)", srcset: `/social/i/${id}/${i}?m=1` }),
        el("img", { src: `/social/i/${id}/${i}`, alt: "Photo", loading: "lazy", decoding: "async" }),
      ),
    );
  }
  row.addEventListener("click", (event) => event.stopPropagation());
  return row;
}

function renderPost(post, inDetail) {
  const body = el("p", {}, linkedText(post.text));
  if (!post.text) body.hidden = true;
  const comments = el("a", { class: "act", href: `/social/p/${post.id}`, text: `comment (${post.comments || 0})` });
  const block = el(
    "article",
    { class: "post", id: `p-${post.id}` },
    el(
      "div",
      { class: "post-row" },
      thumb(post.repostBy || post.by, post.repostBy ? post.originalRev : post.avatarRev),
      el(
        "div",
        { class: "post-main" },
        el(
          "div",
          { class: "who-row" },
          el("a", {
            class: "who",
            href: `/social/u/${post.repostBy || post.by}`,
            text: post.repostBy || post.by,
          }),
          post.repostBy
            ? el(
                "span",
                { class: "via" },
                " (re-posted by ",
                el("a", { href: `/social/u/${post.by}`, text: post.by }),
                ")",
              )
            : null,
          el("time", { text: ago(post.at), datetime: new Date(post.at).toISOString() }),
        ),
        body,
        gallery(post),
        postActions(post, inDetail, comments),
      ),
    ),
  );
  if (!inDetail) {
    // The rest of the card opens the post too. Handing the click to the link,
    // modifier keys and all, keeps Cmd-click opening a new tab.
    block.addEventListener("click", (event) => {
      if (!event.target.closest("a, button, form, input, .gallery")) comments.dispatchEvent(new MouseEvent("click", event));
    });
  }
  return block;
}

function paintDetail() {
  const post = detail.post;
  const back = el("a", { class: "back", href: "/social", text: "Back" });
  back.addEventListener("click", (event) => {
    const ref = document.referrer;
    if (ref.startsWith(location.origin) && history.length > 1) {
      event.preventDefault();
      history.back();
    }
  });
  const views = el("p", {
    class: "views",
    text: post.views === 1 ? "1 view" : `${post.views} views`,
  });
  main.replaceChildren(
    ...[
      el("div", { class: "detail-bar" }, back, views),
      renderPost(post, true),
      commentForm(post),
      commentList(detail.comments),
    ].filter(Boolean),
  );
}

async function renderPostPage(id) {
  detail = await send("/api/social/open", { post: id });
  sideOff();
  paintDetail();
}

function composer() {
  if (!me) return null;
  // A deadline rather than a count, so the button wakes when the wait is over.
  const until = Date.now() + me.wait;
  let busy = 0;
  const area = el("textarea", {
    maxlength: String(MAX_POST),
    rows: "1",
    placeholder: "What’s happening?",
    "aria-label": "What’s happening?",
  });
  const shots = [];
  // A textarea holds no anchors, so the addresses in it are drawn under it, as the post will draw them.
  const links = el("div", { class: "compose-links", hidden: true });
  const strip = el("div", { class: "shots", hidden: true });
  const file = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const add = el("button", { type: "button", class: "tool", "aria-label": "Add photos" });
  // The drawing is a <symbol> in social.html, so the bundle carries only a reference.
  add.innerHTML = '<svg width="22" height="22" aria-hidden="true"><use href="#pi"/></svg>';
  const button = el("button", { type: "submit", class: "post-go", text: "Post", disabled: true });
  const note = el("span", { class: "wait", hidden: me.wait <= 0, text: waitLabel(me.wait) });
  const count = el("span", { class: "count", "aria-live": "polite" });

  function tally() {
    const used = area.value.length;
    count.textContent = `${used}/${MAX_POST}`;
    count.classList.toggle("low", MAX_POST - used < 25);
  }
  tally();

  function ready() {
    return !busy && Date.now() >= until && (area.value.trim().length > 0 || shots.length > 0);
  }

  function sync() {
    button.disabled = !ready();
  }

  function paintLinks() {
    const found = [...area.value.matchAll(LINK)]
      .filter((match) => match[1])
      .map((match) => webLink(trimUrl(match[0])))
      .filter(Boolean);
    links.replaceChildren(...found);
    links.hidden = !found.length;
  }

  if (handed) {
    area.value = handed.slice(0, MAX_POST);
    handed = "";
    history.replaceState(history.state, "", location.pathname);
    setTimeout(() => {
      area.focus();
      area.dispatchEvent(new Event("input"));
    });
  }

  if (me.wait > 0) {
    setTimeout(() => {
      note.hidden = true;
      sync();
    }, me.wait);
  }

  function paintShots() {
    strip.replaceChildren(
      ...shots.map((shot, i) => {
        const remove = el("button", { type: "button", "aria-label": "Remove photo", text: "×" });
        remove.addEventListener("click", () => {
          URL.revokeObjectURL(shot.url);
          shots.splice(i, 1);
          paintShots();
          sync();
        });
        return el("figure", {}, el("img", { src: shot.url, alt: "" }), remove);
      }),
    );
    strip.hidden = shots.length === 0;
  }

  add.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const picked = [...(file.files || [])];
    file.value = "";
    if (!picked.length) return;
    note.hidden = true;
    const room = 4 - shots.length;
    if (!room || picked.length > room) {
      note.hidden = false;
      note.textContent = "Four photos at most.";
    }
    // Post waits for the pictures: sent mid-compression, they would be missing.
    busy++;
    sync();
    for (const item of picked.slice(0, Math.max(0, room))) {
      try {
        const [small, full] = await shrink(item, [
          [480, 0, 14 * 1024, 0.72],
          [960, 0, 48 * 1024, 0.82],
        ]);
        const url = URL.createObjectURL(full);
        drafts.push(url);
        shots.push({ url, full, small });
      } catch (cause) {
        note.hidden = false;
        note.textContent = cause.message;
      }
    }
    busy--;
    paintShots();
    sync();
  });
  area.addEventListener("input", () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
    tally();
    sync();
    paintLinks();
  });
  area.addEventListener("keydown", (e) => {
    // Enter while an IME is composing picks a candidate; it is not a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (ready()) form.requestSubmit();
    }
  });
  const form = el(
    "form",
    { class: "composer" },
    el("div", { class: "compose-top" }, thumb(me.name, me.avatarRev), area),
    links,
    strip,
    el("div", { class: "compose-bar" }, add, file, count, button),
    note,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ready()) return;
    note.hidden = true;
    button.disabled = true;
    add.disabled = true;
    try {
      const text = area.value.trim();
      const body = shots.length ? packPost(text, shots) : JSON.stringify({ text });
      await pull("/api/social/post", { method: "POST", body });
      show();
    } catch (cause) {
      note.hidden = false;
      note.textContent = cause.message;
      sync();
      add.disabled = false;
    }
  });
  return form;
}

let feedGen = 0;
let feedNext = null;
let feedBusy = false;
let moreObserver = null;

function stopMore() {
  feedGen += 1;
  feedNext = null;
  feedBusy = false;
  if (moreObserver) moreObserver.disconnect();
  moreObserver = null;
}

function armMore(gen) {
  if (moreObserver) moreObserver.disconnect();
  moreObserver = null;
  const sentinel = main.querySelector(".more");
  if (!feedNext || !sentinel) return;
  moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore(gen);
  }, { root: main, rootMargin: "600px" });
  moreObserver.observe(sentinel);
}

/**
 * The next page of the timeline. A failure keeps the cursor and the observer,
 * so scrolling back to the end tries again.
 */
async function loadMore(gen) {
  if (gen !== feedGen || feedBusy || !feedNext) return;
  feedBusy = true;
  const sentinel = main.querySelector(".more");
  try {
    const data = await pull(
      `/api/social/timeline?before=${feedNext.at}&id=${encodeURIComponent(feedNext.id)}`,
    );
    if (gen !== feedGen) return;
    sentinel.replaceChildren();
    const seen = new Set([...main.querySelectorAll("article.post")].map((node) => node.id));
    for (const post of data.posts) if (!seen.has(`p-${post.id}`)) sentinel.before(renderPost(post));
    feedNext = data.next || null;
    if (!feedNext) sentinel.remove();
    armMore(gen);
  } catch (cause) {
    if (gen === feedGen) sentinel.replaceChildren(el("p", { class: "err", text: cause.message }));
  } finally {
    if (gen === feedGen) feedBusy = false;
  }
}

/** Timeline or Saved, for phones, where the bottom bar has room for only one of them. */
function feedSwitch(on) {
  const tab = (href, text, key) =>
    el(
      "a",
      key === on
        ? { href, text, class: "on", "aria-current": "page" }
        : { href, text },
    );
  return el(
    "nav",
    { class: "feeds", "aria-label": "Timeline" },
    tab("/social", "Timeline", "timeline"),
    tab("/social/saved", "Saved", "saved"),
  );
}

function renderTimeline(data) {
  const gen = feedGen;
  sideOff();
  const kids = [feedSwitch("timeline")];
  if (data.notes?.length) {
    const list = el("ul", { class: "notes" });
    for (const note of data.notes) {
      list.append(
        el(
          "li",
          {},
          el("a", {
            href: `/social/p/${note.post}`,
            text:
              note.kind === "repost"
                ? `${note.from} re-posted your post`
                : `${note.from} commented on your post`,
          }),
          el("time", { text: ago(note.at) }),
        ),
      );
    }
    kids.push(list);
    send("/api/social/notes/seen")
      .then(() => {
        $("badge").hidden = true;
      })
      .catch(() => {});
  }
  kids.push(composer());
  if (!data.posts.length) kids.push(el("p", { class: "muted", text: "No posts yet." }));
  for (const post of data.posts) kids.push(renderPost(post));
  feedNext = data.next || null;
  if (feedNext) kids.push(el("div", { class: "more" }));
  main.replaceChildren(...kids.filter(Boolean));
  armMore(gen);
}

function renderSaved(data) {
  sideOff();
  main.replaceChildren(
    ...[
      feedSwitch("saved"),
      composer(),
      data.posts.length ? null : el("p", { class: "muted", text: "Nothing saved." }),
      ...data.posts.map((post) => renderPost(post)),
    ].filter(Boolean),
  );
}

/** Search, then the people already added. No profile card on this page. */
function renderFriends(data) {
  useSide(false);
  const input = el("input", {
    type: "search",
    maxlength: "16",
    placeholder: "Find a person",
    "aria-label": "Find a person",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "people",
    autocapitalize: "off",
    autocomplete: "off",
    spellcheck: "false",
  });
  const hits = el("ul", { id: "people", class: "hits", role: "listbox", hidden: true });
  const err = el("p", { class: "err" });
  const list = el("div", { class: "friends" });
  let wait = 0;
  let gen = 0;
  let busy = false;
  let shown = "";

  function row(friend) {
    return el(
      "article",
      { class: "friend" },
      thumb(friend.name, friend.avatarRev),
      el(
        "div",
        { class: "friend-main" },
        el("a", {
          class: "who",
          href: `/social/u/${friend.name}`,
          text: friend.name,
        }),
        friend.loc ? el("div", { class: "muted", text: friend.loc }) : null,
        friend.bio ? el("div", { text: friend.bio }) : null,
      ),
      el("button", {
        type: "button",
        class: "ghost",
        text: "Remove",
        onclick: () => remove(friend.name),
      }),
    );
  }

  /** A to Z like a contact book, one heading per letter. Digits and _ go last, under #. */
  function paint(friends) {
    if (!friends.length)
      return list.replaceChildren(
        el("p", { class: "muted", text: "No friends yet." }),
      );
    const letter = (name) =>
      /^[a-z]/.test(name) ? name[0].toUpperCase() : "#";
    const sorted = [...friends].sort((a, b) => {
      const la = letter(a.name);
      const lb = letter(b.name);
      if (la !== lb) return la === "#" ? 1 : lb === "#" ? -1 : la < lb ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const groups = [];
    for (const friend of sorted) {
      const key = letter(friend.name);
      if (groups.at(-1)?.key !== key) groups.push({ key, rows: [] });
      groups.at(-1).rows.push(row(friend));
    }
    list.replaceChildren(
      ...groups.map((group) =>
        el(
          "section",
          { class: "abc", "aria-label": group.key },
          el("h3", { class: "abc-h", text: group.key }),
          ...group.rows,
        ),
      ),
    );
  }

  function remove(name) {
    pull(`/api/social/friends/${name}`, { method: "DELETE" })
      .then((fresh) => {
        err.textContent = "";
        paint(fresh.friends);
      })
      .catch((cause) => {
        err.textContent = cause.message;
      });
  }

  function shut() {
    shown = "";
    hits.replaceChildren();
    hits.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function fill(nodes, q) {
    shown = q;
    hits.replaceChildren(...nodes);
    hits.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function look() {
    const q = input.value.trim().toLowerCase();
    const mine = ++gen;
    err.textContent = "";
    if (!q) return shut();
    if (me && q === me.name) return fill([el("li", { class: "empty", text: "You can't add yourself." })], q);
    if (!/^[a-z0-9_]{1,16}$/.test(q)) return shut();
    pull(`/api/social/users?q=${q}`)
      .then((found) => {
        if (mine !== gen || input.value.trim().toLowerCase() !== q) return;
        const users = found.users;
        if (!users.length) return fill([el("li", { class: "empty", text: "No one by that name." })], q);
        fill(
          users.map((user) => {
            const row = el(
              "button",
              { type: "button", class: "hit", disabled: user.friend },
              face(user.name, user.avatarRev),
              el("span", { class: "who", text: user.name }),
              user.loc ? el("span", { class: "muted", text: user.loc }) : null,
              el("span", { class: "tag", text: user.friend ? "Friends" : "Add" }),
            );
            if (!user.friend) row.addEventListener("click", () => add(user.name));
            return el("li", {}, row);
          }),
          q,
        );
      })
      .catch((cause) => {
        if (mine !== gen) return;
        err.textContent = cause.message;
        shut();
      });
  }

  function add(name) {
    if (busy) return;
    busy = true;
    err.textContent = "";
    gen += 1;
    send("/api/social/friends", { username: name })
      .then((fresh) => {
        input.value = "";
        shut();
        paint(fresh.friends);
        input.focus();
      })
      .catch((cause) => {
        err.textContent = cause.message;
      })
      .finally(() => {
        busy = false;
      });
  }

  function picks() {
    if (shown !== input.value.trim().toLowerCase()) return [];
    return [...hits.querySelectorAll("button.hit:not(:disabled)")];
  }

  input.addEventListener("input", () => {
    clearTimeout(wait);
    wait = setTimeout(look, 150);
  });
  input.addEventListener("keydown", (e) => {
    const rows = picks();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const on = rows.findIndex((row) => row.classList.contains("on"));
      const step = e.key === "ArrowDown" ? 1 : -1;
      let next = on + step;
      if (next < 0) next = rows.length - 1;
      if (next >= rows.length) next = 0;
      for (const row of rows) row.classList.remove("on");
      rows[next].classList.add("on");
      return;
    }
    if (e.key === "Escape") return shut();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = input.value.trim().toLowerCase();
    if (me && q === me.name) return;
    const pick = rows.find((row) => row.classList.contains("on")) || (rows.length === 1 ? rows[0] : null);
    if (pick) pick.click();
    else if (/^[a-z0-9_]{3,16}$/.test(q)) add(q);
  });
  hits.addEventListener("mousedown", (e) => e.preventDefault());
  paint(data.friends);
  main.replaceChildren(el("div", { class: "find" }, input, hits), err, list);
  input.focus();
}

/** A password box in front of one action. The password is checked by the server. */
function passForm(id, hint, label, run, box) {
  const input = el("input", { id, type: "password", autocomplete: "current-password", required: true });
  const err = el("p", { class: "err" });
  const form = el(
    "form",
    { class: "tools" },
    el("p", { class: "hint", text: hint }),
    el("label", { for: id }, "Password"),
    input,
    el("button", { type: "submit", text: label }),
    err,
    box,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      await run(input.value);
      input.value = "";
    } catch (cause) {
      err.textContent = why(cause);
    }
  });
  return form;
}

/** Register this device's passkey. The server asks for the password first. */
async function addPasskey(password) {
  needPasskey();
  const opt = await send("/api/social/passkey/options", { password });
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: u8(opt.challenge),
      rp: { name: "utopian-go", id: location.hostname },
      user: { id: u8(opt.uid), name: me.name, displayName: me.name },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "required",
        requireResidentKey: true,
      },
      timeout: 60_000,
      attestation: "none",
      // No `prf` here. Asking for it at creation made Firefox on macOS offer
      // only a security key, never the Mac's own passkey sheet. Messenger asks
      // for PRF when it signs in with the passkey (chat/main.js).
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  const response = /** @type {AuthenticatorAttestationResponse} */ (cred.response);
  await send("/api/social/passkey", {
    id: cred.id,
    challenge: opt.challenge,
    clientData: b64u(response.clientDataJSON),
    attestation: b64u(response.attestationObject),
  });
}

/** Your profile as others see it: the card and the posts, nothing to edit. */
function renderProfile(data) {
  const user = data.user;
  renderSide(user);
  const posts = user.posts.length
    ? user.posts.map((p) => renderPost(p))
    : [el("p", { class: "muted", text: "No posts yet." })];
  main.replaceChildren(...posts);
}

/** Edit profile: only the settings, no card and no posts. */
async function renderEdit() {
  if (!me) await pull("/api/social/me");
  if (!me) {
    renderSide(null);
    main.replaceChildren(
      el("p", { class: "muted", text: "Log in to edit your profile." }),
    );
    return;
  }
  useSide(false);
  const bioInput = el("textarea", {
    id: "bio",
    maxlength: "160",
    text: me.bio,
  });
  const locInput = el("input", { id: "loc", maxlength: "40", value: me.loc });
  const saveErr = el("p", { class: "err" });
  const save = el(
    "form",
    { class: "tools" },
    el("label", { for: "bio" }, "Bio"),
    bioInput,
    el("p", { class: "hint", text: "Up to 160 characters." }),
    el("label", { for: "loc" }, "Location"),
    locInput,
    el("p", {
      class: "hint",
      text: "Up to 40 characters. Leave blank to clear.",
    }),
    el("button", { type: "submit", text: "Save" }),
    saveErr,
  );
  save.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveErr.textContent = "";
    try {
      await send("/api/social/profile", {
        bio: bioInput.value,
        loc: locInput.value,
      });
      show();
    } catch (cause) {
      saveErr.textContent = cause.message;
    }
  });

  const photoErr = el("p", { class: "err" });
  const file = el("input", { type: "file", accept: "image/*", id: "pic" });
  file.addEventListener("change", async () => {
    const picked = file.files && file.files[0];
    photoErr.textContent = "";
    if (!picked) return;
    try {
      // The profile copy stays within 14KB at the uploaded shape. The
      // timeline copy is at most 80px wide and 2KB: enough to see a face
      // beside a post, not enough to make a feed of them slow.
      const [full, tiny] = await shrink(
        picked,
        [
          [480, 0, 14 * 1024, 0.86],
          [80, 1, 2 * 1024, 0.7],
        ],
        1,
      );
      const result = await pull("/api/social/avatar", {
        method: "POST",
        body: bin([lens(tiny, full), tiny, full]),
      });
      me.avatarRev = result.avatarRev;
      show();
    } catch (cause) {
      photoErr.textContent = cause.message;
    }
    file.value = "";
  });

  const phraseBox = el("div", {});
  /**
   * The words leave the page on Hide, after two minutes, or as soon as the
   * tab is put away, whichever comes first: a phrase left on an unattended
   * screen is a wallet left open.
   */
  let phraseTimer = 0;
  const hidePhrase = () => {
    clearTimeout(phraseTimer);
    document.removeEventListener("visibilitychange", onPhraseAway);
    phraseBox.replaceChildren();
  };
  const onPhraseAway = () => {
    if (document.hidden || !phraseBox.isConnected) hidePhrase();
  };
  const phraseForm = passForm(
    "phrase",
    "Enter your password to see your recovery phrase.",
    "Show phrase",
    async (password) => {
      const result = await send("/api/social/phrase", { password });
      phraseBox.replaceChildren(
        el("p", { class: "phrase", text: result.phrase }),
        el("p", {
          class: "hint",
          text: "Write this down. It recovers this account and wallet if you forget your password. It hides itself after two minutes.",
        }),
        el("button", {
          type: "button",
          class: "ghost",
          text: "Hide",
          onclick: hidePhrase,
        }),
      );
      clearTimeout(phraseTimer);
      phraseTimer = window.setTimeout(hidePhrase, 120_000);
      document.addEventListener("visibilitychange", onPhraseAway);
    },
    phraseBox,
  );

  main.replaceChildren(
    el(
      "div",
      { class: "detail-bar" },
      el("a", { class: "back", href: `/social/u/${me.name}`, text: "Back" }),
    ),
    el("h2", { class: "ed-h", text: "Edit profile" }),
    el(
      "section",
      { class: "sec" },
      el("h3", { text: "General" }),
      face(me.name, me.avatarRev),
      el("p", {
        class: "hint",
        text: "Square or portrait. The profile keeps that shape at 200px. The timeline uses a smaller copy.",
      }),
      el(
        "label",
        { class: "file", for: "pic" },
        me.avatarRev ? "Change photo" : "Add photo",
        file,
      ),
      photoErr,
      save,
      passForm(
        "pkp",
        me.passkey
          ? "A passkey is on this account. Enter your password to replace it."
          : "Add a passkey to sign in without a password. Enter your password first.",
        me.passkey ? "Replace passkey" : "Add passkey",
        async (password) => {
          await addPasskey(password);
          show();
        },
      ),
    ),
    el("section", { class: "sec" }, el("h3", { text: "Wallet" }), phraseForm),
  );
}

/** Stops the open Messenger, which polls while it is on screen. */
let leaveChat = null;

/** Messenger is its own bundle, handed this one's helpers so it carries no copies. */
async function renderChat() {
  if (!me) await pull("/api/social/me");
  const chat = await load("ch", "__chat");
  leaveChat = chat.mount({
    main,
    side: $("side"),
    me: () => me,
    pull,
    send,
    shrink,
    face,
    ago,
    linkedText,
    useSide,
    renderSide,
    addPasskey,
  });
}

async function show() {
  const here = route();
  if (leaveChat) leaveChat();
  leaveChat = null;
  stopMore();
  for (const url of drafts.splice(0)) URL.revokeObjectURL(url);
  if (here.page !== "post") detail = null;
  document.body.classList.toggle("profile", here.page === "profile");
  main.replaceChildren(el("p", { class: "muted", text: "…" }));
  try {
    if (here.page === "timeline")
      renderTimeline(await pull("/api/social/timeline"));
    else if (here.page === "saved")
      renderSaved(await pull("/api/social/saved"));
    else if (here.page === "friends")
      renderFriends(await pull("/api/social/friends"));
    else if (here.page === "edit") await renderEdit();
    else if (here.page === "profile")
      renderProfile(await pull(`/api/social/u/${here.name}`));
    else if (here.page === "post") await renderPostPage(here.id);
    else if (here.page === "chat") await renderChat();
    else {
      renderSide(me);
      main.replaceChildren(el("p", { text: "Not found." }));
    }
  } catch (cause) {
    detail = null;
    if (here.page === "friends" && me) useSide(false);
    else renderSide(me);
    main.replaceChildren(el("p", { class: "err", text: cause.message }));
  }
  // After the load, not before: whether My Profile is lit depends on who `me` turned out to be.
  markNav();
}

/*
 * The header's Back (phones only) is whatever back link the page drew: a post's
 * Back, an open chat's Chats. It shows while there is one to press.
 */
new MutationObserver(() => {
  document.body.classList.toggle("deep", !!main.querySelector(".back"));
}).observe(main, { childList: true, subtree: true });
$("bk").addEventListener("click", () => main.querySelector(".back")?.click());

$("in").addEventListener("click", () => openAuth("login"));
// Until the server answers, the remembered name points My Profile at the right page.
if (readName()) $("me").href = `/social/u/${readName()}`;
// Signed out, My Profile is still there; it asks you to log in.
$("me").addEventListener("click", (e) => {
  if (me || readName()) return;
  e.preventDefault();
  openAuth("login");
});
dismissible(/** @type {HTMLDialogElement} */ ($("qd")));
$("out").addEventListener("click", async () => {
  try {
    await send("/api/social/logout");
    // Messenger's opened key (client/chat) is this device's, not the next person's.
    try {
      indexedDB.deleteDatabase("ug-chat");
    } catch {
      // Storage is off, so nothing was kept.
    }
    applyMe(null);
    writeName("");
    show();
  } catch (cause) {
    main.replaceChildren(el("p", { class: "err", text: cause.message }));
  }
});
$("pamt").addEventListener("input", () => {
  if (!paying.address || !$("qd").open) return;
  $("py").disabled = false;
  drawPayCode();
});
$("pf").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = $("pe");
  const ok = $("pok");
  const amount = $("pamt");
  const button = $("py");
  err.textContent = "";
  ok.hidden = true;
  const sol = solAmount(amount.value);
  if (!sol) {
    err.textContent = "Enter an amount of SOL.";
    return;
  }
  // The amount is locked while the wallet decides, so what it signs is what is on screen.
  button.disabled = amount.disabled = true;
  try {
    // A wallet's in-app browser may register a moment after load; settled waits for it.
    const [wallet] = await settled(1000);
    if (!wallet) throw new Error("No wallet found. Scan the code with a wallet app.");
    const account = await connect(wallet);
    const prepared = await send("/api/social/pay", { to: paying.address, from: account.address, sol });
    const signature = await signAndSend(wallet, account, u8(prepared.transaction));
    ok.hidden = false;
    ok.textContent = "Sent";
    ok.append(el("a", {
      href: `https://solscan.io/tx/${toBase58(signature)}`,
      text: "View",
      target: "_blank",
      rel: "noopener",
    }));
    // Pay stays off until a new amount is typed: pressing it again would send twice.
    amount.value = "";
    drawPayCode();
  } catch (cause) {
    err.textContent = cause.message || "The payment was not sent.";
    button.disabled = false;
  } finally {
    amount.disabled = false;
  }
});

applyMe(null);
show();
noZoom();
mountPwa();
