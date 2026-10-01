/**
 * Timeline, profile, friends.
 *
 * The document is static. This file asks who you are and fills the column.
 * Pictures are scaled here, before they are uploaded: the server only checks
 * the result, and the aspect ratio is kept by scaling both sides together.
 */
import { $, el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { noZoom } from "../js/device.js";
import { open as openLogin } from "../js/login.js";
import { readName, writeName } from "../js/me.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";
import { mountPwa } from "../js/pwa.js";

const main = $("m");
/** Matches MAX_POST in src/social/limits.ts. */
const MAX_POST = 256;
/** A voice memo's shape is spelled in base64url, one character (0–63) per bar. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Insecure pages (a phone on the LAN over http) have no microphone, so no button either. */
const CAN_RECORD = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

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
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const titles = {
    timeline: "Timeline",
    edit: "Edit profile",
    friends: "Friends",
    post: "Post",
    chat: "Messenger",
  };
  document.title = `${titles[page] || name || "Social"} | Social`;
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
 * `under` makes it a profile photo. It paints the owner's background
 * (client/avatar) where the picture is transparent, which is white otherwise;
 * and wider than tall is refused before any draw, so every copy keeps the
 * shape the profile shows. Each copy starts at its edge and steps quality
 * down, then size, until it fits.
 * @param {File} file
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} [under]
 * @returns {Promise<Blob[]>}
 */
async function shrink(file, sizes, under) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(file);
  }
  try {
    if (under && bmp.width > bmp.height) throw new Error("Use a square or portrait photo.");
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
        under?.(ctx, w, h);
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

/**
 * u16 text length, the text, a photo count, then each phone and desktop JPEG.
 * A memo goes last: u32 bytes, u32 milliseconds, its shape, the recording.
 */
function packPost(text, shots, memo) {
  const encoded = new TextEncoder().encode(text);
  const head = new Uint8Array(3 + encoded.length);
  new DataView(head.buffer).setUint16(0, encoded.length);
  head.set(encoded, 2);
  head[2 + encoded.length] = shots.length;
  const parts = [head, ...shots.flatMap((s) => [lens(s.small, s.full), s.small, s.full])];
  if (memo) {
    const tail = new Uint8Array(8 + memo.wave.length);
    const view = new DataView(tail.buffer);
    view.setUint32(0, memo.blob.size);
    view.setUint32(4, memo.ms);
    tail.set(new TextEncoder().encode(memo.wave), 8);
    parts.push(tail, memo.blob);
  }
  return bin(parts);
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

/**
 * Pay this person, or on your own profile, get paid. The dialog is its own
 * bundle (client/pay), fetched on the first press.
 */
function payButton(person) {
  if (!person.address) return null;
  const button = el("button", {
    type: "button",
    class: "pay",
    text: "Pay",
    onclick: async () => {
      button.disabled = true;
      try {
        (await load("py", "__pay")).open({
          to: { name: person.name, address: person.address },
          me,
          login: () => openAuth("login"),
        });
      } catch {
        button.textContent = "Could not open Pay";
      } finally {
        button.disabled = false;
      }
    },
  });
  return button;
}

/** Show or hide the profile card. */
function useSide(show) {
  $("sd").hidden = !show;
  $("mn").classList.toggle("solo", !show);
}

/** The profile card; nobody to show (signed out) hides it — Log in is in the header. */
function renderSide(person) {
  if (!person) return useSide(false);
  useSide(true);
  const side = $("side");
  const bits = [
    photo(person.name, person.avatarRev),
    el(
      "div",
      { class: "name" },
      el("h2", { text: person.name }),
      person.loc ? el("span", { class: "muted", text: `[${person.loc}]` }) : null,
    ),
    person.bio ? el("p", { class: "ld", text: person.bio }) : null,
    payButton(person),
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
      // Un-saving on a timeline of saved posts only takes the post off it.
      if (!post.saved && kind === "plus" && route().page === "timeline" && shown.saved) card.remove();
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

/** m:ss */
function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A sprite symbol from social.html, as a button's whole face. */
function icon(id, size) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

/** The memo playing now. Starting another pauses it, and so does leaving the page. */
let playing = null;

/**
 * A voice memo: play, the recording's shape, and how long it is.
 *
 * Nothing is fetched until play is pressed, so a timeline of memos costs
 * only their bars. The length drawn is the one posted, not the file's: a
 * browser's own recording often does not say how long it is, and Chrome
 * reports Infinity for one until it has played to the end.
 */
function memoPlayer(src, ms, wave) {
  const go = el("button", { type: "button", class: "memo-go", "aria-label": "Play voice memo" });
  go.innerHTML = icon("mp", 18);
  const bars = el("div", { class: "wave" });
  for (const ch of wave) {
    const bar = el("i");
    bar.style.height = `${12 + Math.round((Math.max(0, B64.indexOf(ch)) / 63) * 88)}%`;
    bars.append(bar);
  }
  const time = el("span", { class: "memo-t", text: clock(ms) });
  const total = ms / 1000;
  let audio = null;
  let frame = 0;
  let lit = -1;

  function paint() {
    const at = audio ? audio.currentTime : 0;
    const n = Math.min(wave.length, Math.round((at / total) * wave.length));
    if (n !== lit) {
      lit = n;
      [...bars.children].forEach((bar, i) => bar.classList.toggle("on", i < n));
    }
    // The length until it starts; after that, how far in it is.
    time.textContent = clock(at > 0 ? at * 1000 : ms);
  }

  function loop() {
    paint();
    frame = requestAnimationFrame(loop);
  }

  function player() {
    if (audio) return audio;
    audio = new Audio(src);
    audio.addEventListener("play", () => {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      go.innerHTML = icon("mz", 18);
      go.setAttribute("aria-label", "Pause voice memo");
      cancelAnimationFrame(frame);
      loop();
    });
    audio.addEventListener("pause", () => {
      cancelAnimationFrame(frame);
      go.innerHTML = icon("mp", 18);
      go.setAttribute("aria-label", "Play voice memo");
      paint();
    });
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      paint();
    });
    audio.addEventListener("error", () => {
      go.disabled = true;
      time.textContent = "Can’t play";
    });
    return audio;
  }

  go.addEventListener("click", () => {
    const a = player();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  });
  // A tap on the bars jumps there, and plays from there.
  bars.addEventListener("click", (event) => {
    const box = bars.getBoundingClientRect();
    const a = player();
    a.currentTime = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * total;
    if (a.paused) a.play().catch(() => {});
    paint();
  });
  return el("div", { class: "memo", role: "group", "aria-label": "Voice memo" }, go, bars, time);
}

/** A post's memo. A re-post plays the original's file. */
function memo(post) {
  if (!post.audio) return null;
  return memoPlayer(`/social/v/${post.repost || post.id}`, post.audio, post.wave);
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
        memo(post),
        postActions(post, inDetail, comments),
      ),
    ),
  );
  if (!inDetail) {
    // The rest of the card opens the post too. Handing the click to the link,
    // modifier keys and all, keeps Cmd-click opening a new tab.
    block.addEventListener("click", (event) => {
      if (!event.target.closest("a, button, form, input, .gallery, .memo")) comments.dispatchEvent(new MouseEvent("click", event));
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
  railSide();
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
  add.innerHTML = icon("pi", 22);
  const mic = el("button", { type: "button", class: "tool", "aria-label": "Record a voice memo", hidden: !CAN_RECORD });
  mic.innerHTML = icon("au", 22);
  /** The recorded memo, until it is posted or removed: {blob, ms, wave, url}. */
  let voice = null;
  const voiceRow = el("div", { class: "voice", hidden: true });
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
    return !busy && Date.now() >= until && (area.value.trim().length > 0 || shots.length > 0 || !!voice);
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

  /** One memo a post: while there is one, the microphone waits and × takes it off. */
  function paintVoice() {
    mic.disabled = !!voice;
    voiceRow.hidden = !voice;
    if (!voice) return voiceRow.replaceChildren();
    const remove = el("button", { type: "button", class: "memo-x", "aria-label": "Remove voice memo", text: "×" });
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(voice.url);
      voice = null;
      paintVoice();
      sync();
    });
    voiceRow.replaceChildren(memoPlayer(voice.url, voice.ms, voice.wave), remove);
  }

  mic.addEventListener("click", async () => {
    note.hidden = true;
    mic.disabled = true;
    try {
      const rec = await load("rc", "__rec");
      const got = await rec.record({ clock, B64 });
      if (got) {
        const url = URL.createObjectURL(got.blob);
        drafts.push(url);
        voice = { ...got, url };
      }
    } catch {
      note.hidden = false;
      note.textContent = "Could not open the recorder.";
    }
    paintVoice();
    sync();
  });

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
    voiceRow,
    el("div", { class: "compose-bar" }, add, file, mic, count, button),
    note,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ready()) return;
    note.hidden = true;
    button.disabled = true;
    add.disabled = mic.disabled = true;
    try {
      const text = area.value.trim();
      const body = shots.length || voice ? packPost(text, shots, voice) : JSON.stringify({ text });
      await pull("/api/social/post", { method: "POST", body });
      show();
    } catch (cause) {
      note.hidden = false;
      note.textContent = cause.message;
      sync();
      add.disabled = false;
      mic.disabled = !!voice;
    }
  });
  return form;
}

/**
 * The timeline's filters, in order: [key, label, icon], then the label and
 * icon while on, where those change. The first two are the signed-in
 * person's own, so signed out they show as off and ask to log in.
 */
const FILTERS = [
  ["friends", "All", "n-tl", "Friends", "n-fr"],
  ["saved", "Saved", "n-sv"],
  ["images", "Images", "pi"],
  ["audio", "Audio", "au"],
];
/** Remembered on this device. The server filters, so every page scrolled to is already filtered. */
const shown = { friends: false, saved: false, images: true, audio: true };
try {
  Object.assign(shown, JSON.parse(localStorage.getItem("ug.feed")));
} catch {
  // Nothing kept, or no storage: the whole timeline.
}

/** Signed out, the server ignores friends and saved, so the stored choice can go as it is. */
function feedQuery() {
  return FILTERS.map(([key]) => `${key}=${+shown[key]}`).join("&");
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
      `/api/social/timeline?before=${feedNext.at}&id=${encodeURIComponent(feedNext.id)}&${feedQuery()}`,
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

/** Wide screens only. A phone has no side columns, so it loads neither the rail nor its data. */
const WIDE = matchMedia("(min-width: 901px)");

/**
 * The right column of the timeline, and of a post opened from it, so the post
 * stays in the column it was read in: the rail, a bundle of its own that asks
 * for its own data (client/rail).
 */
function railSide() {
  useSide(false);
  if (!WIDE.matches) return;
  useSide(true);
  $("side").replaceChildren();
  load("rl", "__rail").then((rail) => rail.mount({ side: $("side"), pull, send, face, openAuth, me: () => me }), () => {});
}
WIDE.addEventListener("change", () => document.body.classList.contains("tl") && railSide());

function renderTimeline(data) {
  const gen = feedGen;
  railSide();
  const kids = [];
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
  const feed = el("div", { class: "feed" });
  kids.push(composer(), filterBar(feed), feed);
  main.replaceChildren(...kids.filter(Boolean));
  paintFeed(feed, data, gen);
}

/**
 * The posts, then the marker that fetches the next page; or why there are
 * none. A newer filter's answer wins.
 */
function paintFeed(feed, data, gen, error) {
  if (gen !== feedGen) return;
  feedNext = data.next || null;
  feed.removeAttribute("aria-busy");
  feed.replaceChildren(
    ...data.posts.map((post) => renderPost(post)),
    ...[
      !data.posts.length && el("p", error ? { class: "err", text: error } : { class: "muted", text: "No posts here." }),
      feedNext && el("div", { class: "more" }),
    ].filter(Boolean),
  );
  armMore(gen);
}

/** Toggles under the composer. A press asks again and redraws only the posts, so a draft above keeps. */
function filterBar(feed) {
  return el(
    "div",
    { class: "flt", role: "group", "aria-label": "Show" },
    ...FILTERS.map(([key, text, id, onText, onId], i) => {
      const button = el("button", { type: "button" });
      const paint = () => {
        const on = shown[key] && (!!me || i > 1);
        button.setAttribute("aria-pressed", on);
        button.innerHTML = icon((on && onId) || id, 16);
        button.append((on && onText) || text);
      };
      paint();
      button.addEventListener("click", async () => {
        if (i < 2 && !me) return openAuth("login");
        shown[key] = !shown[key];
        paint();
        try {
          localStorage.setItem("ug.feed", JSON.stringify(shown));
        } catch {
          // No storage: the choice lasts as long as the page.
        }
        stopMore();
        playing?.pause();
        const gen = feedGen;
        feed.setAttribute("aria-busy", "true");
        try {
          paintFeed(feed, await pull(`/api/social/timeline?${feedQuery()}`), gen);
        } catch (cause) {
          if (gen === feedGen) paintFeed(feed, { posts: [] }, gen, cause.message);
        }
      });
      return button;
    }),
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
        (await load("av", "__avatar")).under(me.name),
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
  playing?.pause();
  playing = null;
  for (const url of drafts.splice(0)) URL.revokeObjectURL(url);
  if (here.page !== "post") detail = null;
  document.body.classList.toggle("profile", here.page === "profile");
  document.body.classList.toggle("tl", here.page === "timeline" || here.page === "post");
  main.replaceChildren(el("p", { class: "muted", text: "…" }));
  try {
    if (here.page === "timeline")
      renderTimeline(await pull(`/api/social/timeline?${feedQuery()}`));
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

/*
 * The feed is the page's one scroll box, so a wheel anywhere on the page moves
 * it: over the header, the tabs, the rail, the footer, or the margins past
 * them, not only over the column. The document does not scroll, so without
 * this those wheels would go nowhere.
 *
 * The browser keeps a wheel over the feed itself, over anything laid on top of
 * the page (a sheet, a dialog), and over a box that can still scroll that way
 * on its own, such as a long rail. A gesture is decided where it starts and
 * keeps that owner, momentum included, as the browser's own scrolling does.
 */
const SCROLLS = /auto|scroll/;
/** #m, or on a phone-width profile #mn, which holds the card and the posts together. Messenger has none. */
const pageBox = () => [main, $("mn")].find((box) => SCROLLS.test(getComputedStyle(box).overflowY));

function wheelIsNative(e) {
  const t = e.target;
  if (!(t instanceof Element) || main.contains(t)) return true;
  if (t !== document.body && t !== document.documentElement && !t.closest("#chrome, #mn, #ft")) return true;
  for (let n = t; n && n !== document.body; n = n.parentElement) {
    if (!SCROLLS.test(getComputedStyle(n).overflowY)) continue;
    if (e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}

let wheelAt = -Infinity;
let wheelNative = true;
addEventListener(
  "wheel",
  (e) => {
    // A pinch on a trackpad is a ctrl-wheel: that zooms, it does not scroll.
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (e.timeStamp - wheelAt > 150) wheelNative = wheelIsNative(e);
    wheelAt = e.timeStamp;
    const box = pageBox();
    if (wheelNative || e.defaultPrevented || !box || box.contains(/** @type {Node} */ (e.target))) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? box.clientHeight : 1;
    box.scrollBy(0, e.deltaY * unit);
  },
  { passive: true },
);

$("in").addEventListener("click", () => openAuth("login"));
// Until the server answers, the remembered name points My Profile at the right page.
if (readName()) $("me").href = `/social/u/${readName()}`;
// Signed out, My Profile is still there; it asks you to log in. So do Friends
// and Messenger, which have nothing to show anyone signed out, and go on to
// their page once you have.
$("me").addEventListener("click", (e) => {
  if (me || readName()) return;
  e.preventDefault();
  openAuth("login");
});
for (const tab of document.querySelectorAll('#tb [data-nav="friends"], #tb [data-nav="chat"]')) {
  tab.addEventListener("click", (e) => {
    if (me || readName()) return;
    e.preventDefault();
    openLogin("login", () => location.assign(/** @type {HTMLAnchorElement} */ (tab).href));
  });
}
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

// Saved was a page before it was a filter. An old link lands on the timeline with Saved on.
if (route().page === "saved") {
  shown.saved = true;
  history.replaceState(null, "", "/social");
}
applyMe(null);
show();
noZoom();
mountPwa();
