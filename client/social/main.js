/**
 * Timeline, profile, a post.
 *
 * The document is static. This file asks who you are and fills the column.
 * Everything the timeline does not draw on its first paint is a bundle of its
 * own, fetched by the page that needs it and handed this file's helpers
 * (`kit`) so it carries no copies: the composer, the ticker cards, Friends,
 * Notifications, Edit profile, Messenger, Advertise, the rail, Pay, and the
 * Log in dialog.
 */
import { logOut } from "../js/acct.js";
import { $, el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { B64, clock } from "../js/memo.js";
import { noZoom } from "../js/device.js";
import { readName, writeName } from "../js/me.js";
import { mountPwa } from "../js/pwa.js";
import { UTCC, utccShort, utccText } from "../js/utcc.js";

const main = $("m");

/** @type {null | {name: string, address: string, bio: string, loc: string, avatarRev: number, passkey: false | {id: string}, wait: number, unseen: number}} */
let me = null;
/** Object URLs of photos in an open composer, freed when the page is redrawn. */
const drafts = [];

function ago(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function route() {
  const ad = location.pathname.match(/^\/social\/ads(?:\/(new|[A-Za-z0-9_-]{1,32}))?\/?$/);
  if (ad) return { page: "ads", id: ad[1] || "" };
  const m = location.pathname
    .replace(/\/+$/, "")
    .match(
      /^\/social(?:\/(saved|friends|notifications|edit|c|new)|\/p\/([A-Za-z0-9_-]{1,32})|\/u\/([a-z0-9_]{3,16})|\/c\/[a-z0-9_]{3,16})?$/,
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
  showBalance();
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
    notifications: "Notifications",
    ads: "Advertise",
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

/** The one login dialog, its own bundle (client/login) as on search; signed in, the page redraws. */
function openAuth(next, done = show) {
  load("lg", "__login").then((login) => login.open(next, done), () => {});
}

/**
 * A web address, an @name, or a $ticker (read as src/social/callouts.ts reads
 * one). The address is tried first, so a name or a ticker inside one stays
 * part of it.
 */
const LINK = /(https?:\/\/|www\.)[^\s<>"]+|(^|[^a-z0-9_])@([a-z0-9_]{3,16})|(?<![\w$])\$([a-z][a-z0-9]{1,11})(?!\w)/gi;

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

/** `coins` are a post's callouts: a ticker that got a card is blue, and opens its chart as the card does. */
function linkedText(text, coins) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match[4]) {
      const key = match[4].toUpperCase();
      // Posts from before tickers were kept name only their symbols.
      const coin = coins?.find((c) => (c.tickers || [c.symbol.toUpperCase()]).includes(key));
      if (!coin) continue;
      frag.append(text.slice(last, match.index), el("a", { class: "cashtag", href: `/wallet?t=${coin.mint}`, text: match[0] }));
      last = match.index + match[0].length;
      continue;
    }
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
    class: "pa pay",
    text: "Pay",
    onclick: async () => {
      button.disabled = true;
      try {
        (await load("py", "__pay")).open({
          to: { name: person.name, address: person.address },
          me,
          login: () => openAuth("login"),
          // Not yet confirmed when it returns, and /api/balances keeps an answer for 5 s.
          sent: () => setTimeout(() => showBalance(true), 6000),
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

/**
 * The profile card; nobody to show (signed out) hides it — Log in is in the header.
 *
 * Its actions are one row of tiles, like the wallet's: Pay, Add and Message on
 * someone else's, Pay and Edit profile on your own. Their marks are social.css
 * [data-ic]. Signed out, Add asks you to log in. Once added it says Friends and
 * does nothing more; Friends is where people come off.
 */
function renderSide(person) {
  if (!person) return useSide(false);
  useSide(true);
  const own = me?.name === person.name;
  const added = () => {
    add.disabled = true;
    add.textContent = "Friends";
  };
  const add = el("button", {
    type: "button",
    class: "pa",
    "data-ic": "add",
    text: "Add",
    onclick: () =>
      me
        ? send("/api/social/friends", { username: person.name }).then(added, () => (add.textContent = "Something went wrong."))
        : openAuth("login"),
  });
  if (person.friend) added();
  const bits = [
    photo(person.name, person.avatarRev),
    el(
      "div",
      { class: "name" },
      el("h2", { text: person.name }),
      person.loc ? el("span", { class: "muted", text: `[${person.loc}]` }) : null,
    ),
    person.bio ? el("p", { class: "ld", text: person.bio }) : null,
    el(
      "div",
      { class: "pacts" },
      payButton(person),
      own ? null : add,
      own
        ? el("a", { class: "pa", "data-ic": "edit", href: "/social/edit", text: "Edit profile" })
        : el("a", { class: "pa", "data-ic": "msg", href: `/social/c/${person.name}`, text: "Message" }),
    ),
  ];
  $("side").replaceChildren(...bits.filter(Boolean));
}

/**
 * A sponsored post, as the server picked it for this timeline: the title as
 * its caption, the banner, and a link row with the call to action. The whole
 * card is the ad's link, which the server only stores as https.
 */
function adPost(ad) {
  const link = el("span", { class: "sad-l" });
  link.innerHTML = icon("n-ln", 16);
  link.append(el("span", {}, el("b", { text: ad.cta }), ` · ${ad.host}`));
  return el(
    "a",
    { class: "post sad", href: /^https:\/\//.test(ad.url) ? ad.url : "#", target: "_blank", rel: "noopener sponsored" },
    el(
      "div",
      { class: "post-row" },
      face(ad.owner, ad.ownerRev),
      el(
        "div",
        { class: "post-main" },
        el("div", { class: "who-row" }, el("span", { class: "who", text: ad.owner }), el("span", { class: "via", text: "Sponsored" })),
        el("p", { text: ad.title }),
        ad.img
          ? el(
              "picture",
              { class: "sad-b" },
              el("source", { media: "(max-width: 900px)", srcset: ad.imgM }),
              el("img", { src: ad.img, alt: "", width: "1200", height: "400", decoding: "async" }),
            )
          : null,
        link,
      ),
    ),
  );
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
 * Save or re-post, then redraw only that post's buttons. An error borrows the
 * label for a moment and gives it back, so the button still says what it does.
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
      // Un-saving on a timeline of saved posts only takes the post off it.
      if (!post.saved && kind === "plus" && route().page === "timeline" && shown.saved) button.closest("article").remove();
      // Only the action row: swapping the whole card would rebuild its images,
      // which blink as they decode again.
      else button.closest(".acts").replaceWith(renderPost(post, inDetail).querySelector(".acts"));
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
 *
 * `src` is the file's address, or an element with none yet: Messenger's memos
 * are sealed, and a press plays the element before its file is opened. A play
 * with no file waits, and starts once the file is given.
 * @param {string | HTMLAudioElement} src
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
    // Only an element has play().
    audio = src.play ? src : new Audio(src);
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
    // Already playing, play() does nothing.
    a.play().catch(() => {});
    paint();
  });
  return el("div", { class: "memo", role: "group", "aria-label": "Voice memo" }, go, bars, time);
}

/** A post's memo. A re-post plays the original's file. */
function memo(post) {
  if (!post.audio) return null;
  return memoPlayer(`/social/v/${post.repost || post.id}`, post.audio, post.wave);
}

/**
 * The tickers the post calls out ($SOL), as cards under its pictures and memo:
 * their own bundle (client/coins), which fills this box. Its placeholders
 * hold each card's height until the prices come.
 */
function coins(post) {
  if (!post.coins?.length) return null;
  const box = el("div", { class: "coins" }, ...post.coins.map(() => el("i")));
  load("cc", "__coins").then((c) => c.fill(box, post.coins), () => box.remove());
  return box;
}

function renderPost(post, inDetail) {
  const body = el("p", {}, linkedText(post.text, post.coins));
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
        coins(post),
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

/**
 * The composer, its own bundle (client/compose). show() asks for it beside the
 * posts when it remembers someone signed in, so it is already here and the
 * page paints once; otherwise it takes this box's place when it comes.
 */
function composer() {
  if (!me) return null;
  const box = el("div");
  load("cp", "__compose").then((c) => box.isConnected && box.replaceWith(c.composer(kit)), () => {});
  return box;
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
  load("rl", "__rail").then((rail) => rail.mount(kit), () => {});
}
WIDE.addEventListener("change", () => document.body.classList.contains("tl") && railSide());

/** Whose $UTCC the tab column is showing, and the latest ask for it, so a late answer for someone else is dropped. */
let balanceOf = "";
let balanceRun = 0;

/**
 * The account's $UTCC, under the tabs. Wide screens only, as the rail is: on a
 * phone the tabs are the bottom bar, with no room under them, so it is not even
 * asked for there. A failed read keeps the last figure, or shows none.
 */
function showBalance(again = false) {
  const owner = me?.address || "";
  if (owner !== balanceOf) {
    balanceOf = owner;
    balanceRun++;
    $("bal").hidden = true;
  } else if (!again) return;
  if (!owner || !WIDE.matches) return;
  const run = ++balanceRun;
  send("/api/balances", { owner, mint: UTCC.mint }).then(
    (data) => run === balanceRun && data.token != null && paintBalance(BigInt(data.token)),
    () => {},
  );
}

function paintBalance(units) {
  const link = $("bal");
  const text = utccText(units);
  // The logo only now, so a phone, or anyone signed out, never fetches it.
  link.href = `/wallet?t=${UTCC.mint}`;
  $("balic").src = `/icon/${UTCC.mint}`;
  $("baln").textContent = text;
  $("bals").textContent = utccShort(units);
  link.title = `${text} ${UTCC.symbol}`;
  link.hidden = false;
}

WIDE.addEventListener("change", () => showBalance(true));
// Someone may have paid you while the page was in another tab.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && showBalance(true));

function renderTimeline(data) {
  const gen = feedGen;
  railSide();
  const feed = el("div", { class: "feed" });
  main.replaceChildren(...[composer(), filterBar(feed), feed].filter(Boolean));
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
  const cards = data.posts.map((post) => renderPost(post));
  // The first page's ad, after the second post.
  if (data.ad) cards.splice(2, 0, adPost(data.ad));
  feed.replaceChildren(
    ...cards,
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

/** Your profile as others see it: the card and the posts, nothing to edit. */
function renderProfile(data) {
  const user = data.user;
  renderSide(user);
  const posts = user.posts.length
    ? user.posts.map((p) => renderPost(p))
    : [el("p", { class: "muted", text: "No posts yet." })];
  main.replaceChildren(...posts);
}

/**
 * Advertise is its own bundle, for a wide screen: a phone has no tab for it
 * and loads none of it.
 */
async function renderAds(id) {
  useSide(false);
  if (!me) await pull("/api/social/me");
  if (!me) {
    main.replaceChildren(
      el("p", { class: "muted", text: "Log in to advertise." }),
      el("button", { type: "button", class: "go-pill", text: "Log in", onclick: () => openAuth("login") }),
    );
    return;
  }
  if (!WIDE.matches) return main.replaceChildren(el("p", { class: "muted", text: "Advertise from a computer." }));
  (await load("ad", "__ads")).mount({ ...kit, id });
}

/** Stops the open Messenger, which polls while it is on screen. */
let leaveChat = null;

/** Messenger is its own bundle. */
async function renderChat() {
  if (!me) await pull("/api/social/me");
  leaveChat = (await load("ch", "__chat")).mount(kit);
}

/**
 * This file's helpers, for the bundles it fetches: each takes what it needs,
 * so none carries a copy of what is already here.
 */
const kit = {
  main,
  side: $("side"),
  me: () => me,
  pull,
  send,
  show,
  openAuth,
  face,
  thumb,
  photo,
  ago,
  linkedText,
  LINK,
  trimUrl,
  webLink,
  memoPlayer,
  adPost,
  useSide,
  renderSide,
  load,
  drafts,
};

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
  document.body.classList.toggle("ads", here.page === "ads");
  document.body.classList.toggle("newpost", here.page === "new");
  main.replaceChildren(el("p", { class: "muted", text: "…" }));
  try {
    if (here.page === "timeline") {
      // Remembered as signed in, the composer comes beside the posts, so they paint together.
      const cp = readName() && load("cp", "__compose").catch(() => {});
      const data = await pull(`/api/social/timeline?${feedQuery()}`);
      await cp;
      renderTimeline(data);
    } else if (here.page === "friends") {
      const [data, friends] = await Promise.all([pull("/api/social/friends"), load("fr", "__friends")]);
      friends.mount(data, kit);
    } else if (here.page === "notifications") {
      const [data, notes] = await Promise.all([pull("/api/social/notes"), load("nt", "__notes")]);
      notes.mount(data, kit);
    } else if (here.page === "edit") await (await load("ed", "__edit")).mount(kit);
    else if (here.page === "profile")
      renderProfile(await pull(`/api/social/u/${here.name}`));
    else if (here.page === "post") await renderPostPage(here.id);
    else if (here.page === "new") {
      // The composer as a page of its own (client/compose), a phone's +.
      if (!me) await pull("/api/social/me");
      if (!me) throw new Error("Log in to post.");
      (await load("cp", "__compose")).openPage(kit);
    }
    else if (here.page === "chat") await renderChat();
    else if (here.page === "ads") await renderAds(here.id);
    else {
      renderSide(me);
      main.replaceChildren(el("p", { text: "Not found." }));
    }
  } catch (cause) {
    detail = null;
    if ((here.page === "friends" || here.page === "notifications") && me) useSide(false);
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

// The + opens /social/new in place (client/compose); Back, or Cancel, comes home to the timeline.
addEventListener("popstate", show);

/*
 * Pull to refresh, on the timeline: drawn down from the top, the posts load
 * again under a 2px bar along the top of the screen. The bar follows the pull,
 * creeps on while the timeline loads, fills when it has, and goes.
 */
const PULL = 80;
let pullFrom = -1;
let pulled = 0;
let refreshing = false;
/** @type {HTMLElement | null} */
let bar = null;

/** How the bar gets to its width: with the finger, creeping while the posts load, or quickly to the end. */
const EASE = { pull: "none", load: "width 6s cubic-bezier(0.1, 0.7, 0.2, 1)", done: "width 0.25s ease-out" };

function setBar(width, how) {
  if (!bar) document.body.append((bar = el("div", { class: "ptr" })));
  bar.style.transition = EASE[how];
  bar.style.opacity = "1";
  bar.style.width = `${width}%`;
}

function dropBar(delay) {
  const gone = bar;
  bar = null;
  setTimeout(() => {
    gone.style.transition = "opacity 0.3s";
    gone.style.opacity = "0";
    setTimeout(() => gone.remove(), 300);
  }, delay);
}

const atTop = () => (pageBox()?.scrollTop ?? scrollY) <= 0;

addEventListener(
  "touchstart",
  (e) => {
    pulled = 0;
    pullFrom = !refreshing && e.touches.length === 1 && route().page === "timeline" && atTop() ? e.touches[0].clientY : -1;
  },
  { passive: true },
);

addEventListener(
  "touchmove",
  (e) => {
    if (pullFrom < 0) return;
    pulled = e.touches[0].clientY - pullFrom;
    // Up to a third of the way while pulling; the rest is the load's.
    if (pulled > 8 && atTop()) setBar((Math.min(pulled, PULL) / PULL) * 33, "pull");
  },
  { passive: true },
);

addEventListener("touchend", async () => {
  if (pullFrom < 0) return;
  pullFrom = -1;
  if (!bar) return;
  if (pulled < PULL) return dropBar(0);
  refreshing = true;
  // Read before the bar moves, so the creep starts from where the pull left it.
  void bar.offsetWidth;
  setBar(90, "load");
  try {
    const data = await pull(`/api/social/timeline?${feedQuery()}`);
    if (route().page === "timeline") {
      stopMore();
      renderTimeline(data);
    }
  } catch {
    // Offline or failed: client/offline says so; the posts on screen stay.
  }
  setBar(100, "done");
  dropBar(250);
  refreshing = false;
});

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
// Signed out, My Profile is still there; it asks you to log in. So do Friends,
// Messenger, Notifications and Advertise, which have nothing to show anyone
// signed out, and go on to their page once you have.
$("me").addEventListener("click", (e) => {
  if (me || readName()) return;
  e.preventDefault();
  openAuth("login");
});
for (const tab of document.querySelectorAll('#tb [data-nav="friends"], #tb [data-nav="chat"], #tb [data-nav="notifications"], #tb [data-nav="ads"]')) {
  tab.addEventListener("click", (e) => {
    if (me || readName()) return;
    e.preventDefault();
    openAuth("login", () => location.assign(/** @type {HTMLAnchorElement} */ (tab).href));
  });
}
$("out").addEventListener("click", async () => {
  try {
    await logOut();
    applyMe(null);
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
