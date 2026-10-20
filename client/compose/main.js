/**
 * The timeline's composer: the text, up to four photos, a voice memo, Post.
 *
 * Its own bundle, so Social's first load carries none of it: signed out there
 * is no composer at all. social.js asks for it beside the timeline's posts
 * when it remembers someone signed in, so the page still paints once, with
 * the composer on it. Handed social.js's helpers so it carries no copies.
 */
import { el } from "../js/dom.js";
import { B64, clock } from "../js/memo.js";
import { bin, lens, shrink } from "../js/shrink.js";

/** Matches MAX_POST in src/social/limits.ts. */
const MAX_POST = 256;
/** Insecure pages (a phone on the LAN over http) have no microphone, so no button either. */
const CAN_RECORD = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** `$` and a ticker, read exactly as src/social/callouts.ts reads one. */
const TICKER = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{1,11})(?!\w)/g;
/** What /api/callouts takes; a draft's first three cards come long before. */
const MAX_TICKERS = 20;
/** Typing pauses this long before the draft's tickers are looked up. */
const SETTLE_MS = 200;

/** A link sent over by a search result's Comment button, for the next composer. */
let handed = new URLSearchParams(location.search).get("text") || "";

function waitLabel(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return `You can post again in ${min} min.`;
}

/** The phone's new-post button (social.css .fab). */
const PLUS =
  '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" ' +
  'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** A sprite symbol from social.html, as a button's whole face. */
function icon(id, size) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
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

/**
 * @param {{
 *   me: () => {name: string, avatarRev: number, nextPost?: number, wait: number},
 *   pull: (path: string, opts?: object) => Promise<any>,
 *   show: () => void,
 *   thumb: (name: string, rev: number) => HTMLElement | null,
 *   memoPlayer: (src: string, ms: number, wave: string) => HTMLElement,
 *   load: (attr: string, global: string) => Promise<any>,
 *   drafts: string[],
 *   LINK: RegExp, trimUrl: (raw: string) => string, webLink: (url: string) => HTMLElement | null,
 * }} kit `drafts` takes the composer's object URLs, which social.js frees on the next redraw
 */
/** The draft so far, kept for the tab, so Cancel, or the + on another page, loses nothing. */
const DRAFT = "ug.draft";
function keepDraft(text) {
  try {
    if (text) sessionStorage.setItem(DRAFT, text);
    else sessionStorage.removeItem(DRAFT);
  } catch {
    // No storage: a draft lasts as long as its page, as it always did.
  }
}
function keptDraft() {
  try {
    return sessionStorage.getItem(DRAFT) || "";
  } catch {
    return "";
  }
}

/** A phone: the composer is a page of its own (/social/new) behind a + on the timeline. */
const PHONE = matchMedia("(max-width: 900px)");

function composer(kit, page = false) {
  const { me: who, pull, show, thumb, memoPlayer, load, drafts, LINK, trimUrl, webLink } = kit;
  const me = who();
  // A deadline rather than a count, so the button wakes when the wait is over.
  // nextPost is a time, right however old the answer it came in; wait was a
  // count from that answer, wrong once it was kept and shown again.
  const until = me.nextPost ?? Date.now() + me.wait;
  const wait = Math.max(0, until - Date.now());
  let busy = 0;
  const area = el("textarea", {
    maxlength: String(MAX_POST),
    rows: "1",
    placeholder: "What’s happening?",
    "aria-label": "What’s happening?",
  });
  // The draft's words again, under the field, with each ticker that has a card in blue (social.css .draft).
  const shade = el("div", { class: "draft-b", "aria-hidden": "true" });
  // The cards the post will carry, drawn as it will draw them: client/coins, fetched at the first `$`.
  const cards = el("div", { class: "coins", hidden: true });
  /** The mint each ticker in the draft went to, by its upper case, as of the last answer. */
  let named = {};
  /** The tickers last asked about, so a keystroke that changes none asks nothing. */
  let asked = "";
  let settle = 0;
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
  const note = el("span", { class: "wait", hidden: wait <= 0, text: waitLabel(wait) });
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

  function paintShade() {
    const text = area.value;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(TICKER)) {
      // Own keys only: the answer is parsed JSON, and a ticker is whatever was typed.
      if (!Object.prototype.hasOwnProperty.call(named, match[1].toUpperCase())) continue;
      frag.append(text.slice(last, match.index), el("span", { text: match[0] }));
      last = match.index + match[0].length;
    }
    frag.append(text.slice(last));
    shade.replaceChildren(frag);
  }

  /** The draft's tickers resolved as posting will resolve them: the cards under it, and which ones turn blue. */
  function lookUp() {
    const tickers = [...area.value.matchAll(TICKER)].map((match) => match[1]).slice(0, MAX_TICKERS);
    const key = tickers.join(",");
    if (key === asked) return;
    asked = key;
    if (!tickers.length) {
      named = {};
      cards.replaceChildren();
      cards.hidden = true;
      return paintShade();
    }
    load("cc", "__coins")
      .then((coins) =>
        coins.ask(tickers).then((data) => {
          // A later draft has asked since; its answer is the one to draw.
          if (asked !== key) return;
          named = data.named;
          cards.replaceChildren(...data.tokens.map((token) => coins.card(token, token, true)));
          cards.hidden = !data.tokens.length;
          paintShade();
        }),
      )
      .catch(() => {
        // Ask again on the next keystroke.
        if (asked === key) asked = "";
      });
  }

  if (handed) {
    keepDraft(handed.slice(0, MAX_POST));
    handed = "";
    history.replaceState(history.state, "", location.pathname);
    // On a phone the composer is its own page: the draft is waiting there.
    if (PHONE.matches && !page) location.replace("/social/new");
  }
  const kept = keptDraft();
  if (kept) {
    area.value = kept;
    setTimeout(() => {
      area.dispatchEvent(new Event("input"));
      if (page) area.focus();
    });
  }

  if (wait > 0) {
    setTimeout(() => {
      note.hidden = true;
      sync();
    }, wait);
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
    keepDraft(area.value);
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
    tally();
    sync();
    paintLinks();
    paintShade();
    clearTimeout(settle);
    settle = setTimeout(lookUp, SETTLE_MS);
  });
  area.addEventListener("keydown", (e) => {
    // Enter while an IME is composing picks a candidate; it is not a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (ready()) form.requestSubmit();
    }
  });
  /*
   * On a phone the composer is a page of its own, /social/new: a round + over
   * the timeline opens it, Cancel goes back. Opened in the tap itself rather
   * than by loading the page, since a phone raises its keyboard only for a
   * focus the tap asked for. Wider screens show neither, and the form sits
   * above the posts as it always has.
   */
  const fab = el("a", { class: "fab", href: "/social/new", "aria-label": "New post" });
  fab.innerHTML = PLUS;
  fab.addEventListener("click", (e) => {
    e.preventDefault();
    history.pushState({ ugNew: 1 }, "", "/social/new");
    openPage(kit).querySelector("textarea").focus();
  });
  const cancel = el("a", { class: "compose-x", href: "/social", text: "Cancel" });
  // Back where the + was, when that is where this came from.
  const leave = (e) => {
    if (!history.state?.ugNew) return location.replace("/social");
    e?.preventDefault();
    history.back();
  };
  cancel.addEventListener("click", leave);
  const form = el(
    "form",
    { class: page ? "composer page" : "composer", "aria-label": "New post" },
    fab,
    cancel,
    el("div", { class: "compose-top" }, thumb(me.name, me.avatarRev), el("div", { class: "draft" }, shade, area)),
    links,
    strip,
    voiceRow,
    // After the photos and the memo, where the post will put them.
    cards,
    el("div", { class: "compose-bar" }, add, file, mic, count, button),
    note,
  );
  if (page) form.addEventListener("keydown", (e) => e.key === "Escape" && leave(e));
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
      keepDraft("");
      // From its own page, back to the timeline, which shows the post.
      if (page) leave();
      else show();
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

/** /social/new: the composer as the page, with nothing under it. */
function openPage(kit) {
  document.body.classList.add("newpost");
  const form = composer(kit, true);
  kit.main.replaceChildren(form);
  scrollTo(0, 0);
  return form;
}

window.__compose = { composer, openPage };
