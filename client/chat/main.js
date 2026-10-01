/**
 * Messenger: chats on the left, one conversation on the right.
 *
 * End to end. This device makes an ECDH P-256 key, seals its private half
 * under a key the passkey derives (WebAuthn PRF), and hands the server only
 * the sealed box and the public half. Two people's keys agree on a
 * conversation key through HKDF, and every message and photo is AES-GCM under
 * it before it leaves the page. The direction, sender to recipient, is the
 * additional data, so the server cannot pass one person's message off as the
 * other's.
 *
 * Once opened, the private key is kept in IndexedDB as a non-extractable
 * CryptoKey. The page can use it and cannot read it out, so the passkey is
 * asked for once per device, not on every visit. Logging out deletes the
 * store (social.js), which is why its name is spelled there too.
 *
 * Loaded by social.js on /social/c. It shares that bundle's helpers through
 * `ctx` rather than carrying copies of them.
 */
import { el } from "../js/dom.js";
import { b64u, needPasskey, u8, why } from "../js/passkey.js";

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const GCM = { name: "AES-GCM", length: 256 };
const SALT = te.encode("utopian-go messenger v1");
const STORE = "ug-chat";
const POLL_MS = 5000;
const MAX_CHAT = 500;

function random(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** HKDF-SHA256 from raw bytes to an AES-GCM key. */
async function hkdf(bytes, info) {
  const base = await subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    base,
    GCM,
    false,
    ["encrypt", "decrypt"],
  );
}

function seal(key, iv, bytes, aad) {
  return subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes);
}

function unseal(key, iv, bytes, aad) {
  return subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes);
}

/** One IndexedDB request, with the database opened and closed around it. */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(STORE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("k");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const t = db.transaction("k", mode);
      const req = fn(t.objectStore("k"));
      t.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      t.onerror = t.onabort = () => {
        db.close();
        reject(t.error);
      };
    };
  });
}

async function cachedKey(name) {
  try {
    return (await idb("readonly", (s) => s.get(name))) || null;
  } catch {
    return null;
  }
}

async function cacheKey(name, key) {
  try {
    await idb("readwrite", (s) => s.put(key, name));
  } catch {
    // Private windows may refuse storage. The key still works until the page closes.
  }
}

/**
 * The passkey, asked for its PRF output. The challenge is the server's when
 * the assertion is also the proof that publishes a key, and a local one when
 * it only opens a box already stored.
 */
async function prf(challenge, id) {
  needPasskey();
  // No allowCredentials. Firefox on macOS, asked for PRF from one named
  // credential, offers only a security key and never the Mac's passkey sheet;
  // asked for any passkey on this site, it shows the sheet and returns PRF.
  // The id is checked below instead, and the server checks the assertion.
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: u8(challenge),
      rpId: location.hostname,
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: SALT } } },
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  if (b64u(cred.rawId) !== b64u(u8(id))) {
    throw new Error("That is a different passkey. Pick the one this account uses.");
  }
  const out = cred.getClientExtensionResults().prf?.results?.first;
  if (!out) {
    throw new Error(
      "This passkey can't encrypt messages. Replace it from your profile using a browser or password manager that supports passkey encryption.",
    );
  }
  const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
  return {
    wrap: await hkdf(out, "ug chat wrap"),
    proof: {
      challenge,
      clientData: b64u(response.clientDataJSON),
      authenticatorData: b64u(response.authenticatorData),
      signature: b64u(response.signature),
    },
  };
}

/**
 * @param {{
 *   main: HTMLElement, side: HTMLElement,
 *   me: () => any, pull: (path: string, opts?: any) => Promise<any>, send: (path: string, obj?: any) => Promise<any>,
 *   shrink: (file: File, sizes: any[]) => Promise<Blob[]>, face: (name: string, rev: number) => HTMLElement | null,
 *   ago: (at: number) => string, linkedText: (text: string) => Node, useSide: (on: boolean) => void,
 *   renderSide: (person: any) => void, addPasskey: (password: string) => Promise<void>,
 * }} ctx
 * @returns {() => void} stops polling and frees what the page made
 */
export function mount(ctx) {
  const { main, side } = ctx;
  const name = ctx.me()?.name || "";
  /** This device's opened key: {v, priv}. */
  let mine = null;
  /** GET /ck: the passkey on the account, and the newest key's sealed box. */
  let status = { cred: null, key: null };
  /** Public keys by person and version, and which version is current. */
  const peers = new Map();
  const pairs = new Map();
  /** Loaded sidebar rows by person, and the cursor to the next page. */
  const chats = new Map();
  let listNext = null;
  let listBusy = false;
  let since = 0;
  /** The open conversation. */
  let peer = "";
  let gen = 0;
  let older = null;
  let newest = null;
  let box = null;
  const urls = [];
  let timer = 0;
  let stopped = false;
  const observers = [];

  document.body.classList.add("chat");

  function peerOf(who) {
    let p = peers.get(who);
    if (!p) peers.set(who, (p = { keys: new Map(), cur: 0, avatarRev: 0 }));
    return p;
  }

  /** The conversation key between this device's key and one of theirs. */
  function pairKey(who, theirV) {
    const pub = peers.get(who)?.keys.get(theirV);
    if (!mine || !pub) return null;
    const id = `${who}.${theirV}.${mine.v}`;
    if (!pairs.has(id)) {
      const both = [`${name}.${mine.v}`, `${who}.${theirV}`].sort().join(" ");
      pairs.set(
        id,
        subtle
          .importKey("raw", u8(pub), ECDH, false, [])
          .then((theirs) => subtle.deriveBits({ name: "ECDH", public: theirs }, mine.priv, 256))
          .then((bits) => hkdf(bits, `ug chat ${both}`)),
      );
    }
    return pairs.get(id);
  }

  /** Which of the two keys a message was sealed between, seen from here. */
  function ends(who, m) {
    const out = m.from !== who;
    return { myV: out ? m.kf : m.kt, theirV: out ? m.kt : m.kf, dir: out ? `${name}>${who}` : `${who}>${name}` };
  }

  /**
   * Sets `m.text`: the words, or null when this device holds no key that
   * opens it. A message sealed to a key this account has since replaced
   * stays closed; that is the cost of the key never leaving a device.
   */
  async function open(who, m) {
    if (m.text !== undefined && m.text !== null) return;
    const { myV, theirV, dir } = ends(who, m);
    const key = myV === mine?.v ? pairKey(who, theirV) : null;
    m.text = null;
    if (!key) return;
    try {
      m.text = td.decode(await unseal(await key, u8(m.iv), u8(m.ct), dir));
    } catch {
      m.text = null;
    }
  }

  function lockState() {
    if (!status.cred) return "nopasskey";
    if (!status.key) return "off";
    if (!mine) return status.key.cred === status.cred ? "locked" : "moved";
    return "ready";
  }

  /** Sealed box → key, with the passkey that sealed it. */
  async function unlock() {
    const { wrap } = await prf(b64u(random(32)), status.cred);
    let pkcs8;
    try {
      pkcs8 = await unseal(wrap, u8(status.key.iv), u8(status.key.ct), name);
    } catch {
      throw new Error("That passkey doesn't open these messages.");
    }
    const priv = await subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
    mine = { v: status.key.v, priv };
    await cacheKey(name, mine);
  }

  /** A new key, sealed under the passkey. The same assertion proves it to the server. */
  async function turnOn() {
    const opt = await ctx.send("/api/social/ck/options");
    const { wrap, proof } = await prf(opt.challenge, opt.id);
    const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
    const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
    const iv = random(12);
    const ct = await seal(wrap, iv, pkcs8, name);
    const pub = await subtle.exportKey("raw", pair.publicKey);
    const { v } = await ctx.send("/api/social/ck", { ...proof, pub: b64u(pub), iv: b64u(iv), ct: b64u(ct) });
    mine = { v, priv: await subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]) };
    pairs.clear();
    await cacheKey(name, mine);
    status = await ctx.pull("/api/social/ck");
  }

  async function loadStatus() {
    status = await ctx.pull("/api/social/ck");
    const held = await cachedKey(name);
    mine = held && status.key && held.v === status.key.v ? held : null;
    pairs.clear();
  }

  // Sidebar.

  const find = el("input", {
    type: "search",
    maxlength: "17",
    placeholder: "Message @handle",
    "aria-label": "Message @handle",
    autocapitalize: "off",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "go",
  });
  const hits = el("ul", { class: "hits", hidden: true });
  const list = el("ul", { class: "chats" });
  const listErr = el("p", { class: "err list-err" });
  let findWait = 0;
  let findGen = 0;

  function query() {
    return find.value.trim().toLowerCase().replace(/^@/, "");
  }

  function preview(c) {
    if (c.unread > 0 && c.with !== peer) {
      return el("b", { class: "fresh", text: c.unread === 1 ? "1 new message" : `${c.unread} new messages` });
    }
    const m = c.last;
    const own = m.from === name ? "You: " : "";
    const text = m.text ? m.text : m.text === null ? (mine ? "Can't be opened on this device" : "Encrypted message") : "";
    return el("span", { class: "prev", text: own + (text || (m.photos ? "Photo" : "…")) });
  }

  function row(c) {
    const link = el(
      "a",
      { class: c.with === peer ? "crow on" : "crow", href: `/social/c/${c.with}` },
      ctx.face(c.with, c.avatarRev),
      el(
        "span",
        { class: "crow-main" },
        el("span", { class: "crow-top" }, el("b", { text: c.with }), el("time", { text: ctx.ago(c.at) })),
        preview(c),
      ),
    );
    if (c.with === peer) link.setAttribute("aria-current", "page");
    link.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault();
      go(c.with);
    });
    return el("li", {}, link);
  }

  function paintList() {
    const q = query();
    const sorted = [...chats.values()].sort((a, b) => b.at - a.at || (a.with < b.with ? 1 : -1));
    const shown = sorted.filter((c) => !q || c.with.startsWith(q));
    const kids = shown.map(row);
    if (!sorted.length && !listNext) kids.push(el("li", { class: "muted empty", text: "No chats yet. Type a handle above to start one." }));
    else if (q && !shown.length && !listNext) kids.push(el("li", { class: "muted empty", text: "No chat with that name yet." }));
    if (listNext) kids.push(el("li", { class: "more" }));
    list.replaceChildren(...kids);
    armList();
  }

  function learn(c) {
    const p = peerOf(c.with);
    p.avatarRev = c.avatarRev;
    const theirV = ends(c.with, c.last).theirV;
    if (c.pub) p.keys.set(theirV, c.pub);
    since = Math.max(since, c.at);
    const held = chats.get(c.with);
    // A preview already opened stays open; the poll hands back the same ciphertext.
    if (held && held.last.id === c.last.id) c.last.text = held.last.text;
    chats.set(c.with, c);
  }

  async function take(rows) {
    for (const c of rows) learn(c);
    await Promise.all(rows.map((c) => open(c.with, c.last)));
  }

  function armList() {
    const sentinel = list.querySelector(".more");
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) moreChats();
    }, { root: side, rootMargin: "400px" });
    io.observe(sentinel);
    observers.push(io);
  }

  async function moreChats() {
    if (listBusy || !listNext || stopped) return;
    listBusy = true;
    try {
      const data = await ctx.pull(`/api/social/c?before=${listNext.at}&peer=${listNext.peer}`);
      await take(data.chats);
      listNext = data.next || null;
      listErr.textContent = "";
      paintList();
    } catch (cause) {
      listErr.textContent = cause.message;
    } finally {
      listBusy = false;
    }
  }

  function lookUp() {
    const q = query();
    const ticket = ++findGen;
    if (!/^[a-z0-9_]{1,16}$/.test(q)) {
      hits.hidden = true;
      return;
    }
    ctx
      .pull(`/api/social/users?q=${q}`)
      .then((found) => {
        if (ticket !== findGen) return;
        const fresh = found.users.filter((u) => !chats.has(u.name));
        hits.replaceChildren(
          ...fresh.map((u) => {
            const hit = el(
              "button",
              { type: "button", class: "hit" },
              ctx.face(u.name, u.avatarRev),
              el("span", { class: "who", text: u.name }),
              el("span", { class: "tag", text: "Chat" }),
            );
            hit.addEventListener("click", () => go(u.name));
            return el("li", {}, hit);
          }),
        );
        hits.hidden = !fresh.length;
      })
      .catch(() => {
        hits.hidden = true;
      });
  }

  find.addEventListener("input", () => {
    paintList();
    clearTimeout(findWait);
    findWait = setTimeout(lookUp, 150);
  });
  find.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      find.value = "";
      hits.hidden = true;
      paintList();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = query();
    const first = list.querySelector(".crow") || hits.querySelector(".hit");
    if (/^[a-z0-9_]{3,16}$/.test(q) && q !== name) go(q);
    else if (first) first.click();
  });
  hits.addEventListener("mousedown", (e) => e.preventDefault());

  // Conversation.

  /**
   * Set once a passkey is added here. Turning Messenger on is a second passkey
   * prompt, and browsers want a fresh tap for it, so it is a second button.
   */
  let added = false;

  /** The password, then the same enrolment the profile runs. */
  function passkeyForm(err) {
    const input = el("input", { id: "mpk", type: "password", autocomplete: "current-password", required: true });
    const form = el(
      "form",
      { class: "tools" },
      el("label", { for: "mpk" }, "Password"),
      input,
      el("button", { type: "submit", text: "Add passkey" }),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      err.textContent = "";
      try {
        await ctx.addPasskey(input.value);
        input.value = "";
        added = true;
        await loadStatus();
        openThread(peer);
      } catch (cause) {
        err.textContent = why(cause);
        button.disabled = false;
      }
    });
    setTimeout(() => input.focus(), 0);
    return form;
  }

  function lockPanel() {
    const state = lockState();
    const err = el("p", { class: "err" });
    const copy = {
      nopasskey: "Messages are end-to-end encrypted with a passkey. Enter your password to add one to this account.",
      off: added
        ? "Passkey added. Turn on Messenger to make your encryption key; your passkey asks once more."
        : "Messages are end-to-end encrypted with your passkey. Only you and the person you write to can read them.",
      locked: "Unlock your messages on this device with your passkey.",
      moved: "Your passkey changed since Messenger was turned on. A new key starts fresh. Messages sealed to the old one stay unreadable here.",
    }[state];
    const label = { off: "Turn on Messenger", locked: "Unlock messages", moved: "Start a new key" }[state];
    const kids = [el("h2", { text: "Messenger" }), el("p", { text: copy })];
    if (state === "nopasskey") kids.push(passkeyForm(err));
    else {
      const button = el("button", { type: "button", class: "go-pill", text: label });
      button.addEventListener("click", async () => {
        button.disabled = true;
        err.textContent = "";
        try {
          if (state === "locked") await unlock();
          else await turnOn();
          await Promise.all([...chats.values()].map((c) => ((c.last.text = undefined), open(c.with, c.last))));
          paintList();
          openThread(peer);
        } catch (cause) {
          err.textContent = why(cause);
          button.disabled = false;
        }
      });
      kids.push(button);
    }
    kids.push(err);
    return el("div", { class: "lock" }, ...kids);
  }

  function head(who) {
    const back = el("a", { class: "back chat-back", href: "/social/c", text: "Chats" });
    back.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault();
      go("");
    });
    return el(
      "div",
      { class: "chat-head" },
      back,
      ctx.face(who, peerOf(who).avatarRev),
      el("a", { class: "who", href: `/social/u/${who}`, text: who }),
      el("span", { class: "muted", text: "End-to-end encrypted" }),
    );
  }

  /** Photos are fetched sealed and opened here. The <img> holds its height from CSS, so nothing moves. */
  function pics(who, m) {
    if (!m.photos) return null;
    const row = el("div", { class: "pics" });
    for (let i = 0; i < m.photos; i++) {
      const img = el("img", { alt: "Photo", decoding: "async" });
      row.append(img);
      if (m.urls?.[i]) {
        img.src = m.urls[i];
        continue;
      }
      const { myV, theirV, dir } = ends(who, m);
      const key = myV === mine?.v ? pairKey(who, theirV) : null;
      if (!key) {
        img.alt = "Photo can't be opened on this device";
        continue;
      }
      fetch(`/api/social/cp/${m.id}/${i}`)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error())))
        .then(async (buf) => {
          const bytes = new Uint8Array(buf);
          const plain = await unseal(await key, bytes.subarray(0, 12), bytes.subarray(12), `${dir} ${m.iv} ${i}`);
          const url = URL.createObjectURL(new Blob([plain], { type: "image/jpeg" }));
          urls.push(url);
          img.src = url;
        })
        .catch(() => {
          img.alt = "Photo could not be opened";
          img.classList.add("gone");
        });
    }
    return row;
  }

  function bubble(who, m) {
    const own = m.from === name;
    const text =
      m.text === null
        ? el("p", { class: "closed", text: "Sealed to a key this device doesn't have." })
        : m.text
          ? el("p", {}, ctx.linkedText(m.text))
          : null;
    return el(
      "div",
      { class: own ? "msg mine" : "msg", id: `m-${m.id}` },
      pics(who, m),
      text,
      el("time", { text: ctx.ago(m.at), datetime: new Date(m.at).toISOString(), title: new Date(m.at).toLocaleString() }),
    );
  }

  function nearBottom() {
    return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  function toBottom() {
    if (box) box.scrollTop = box.scrollHeight;
  }

  function armOlder(g) {
    const sentinel = box?.querySelector(".more");
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadOlder(g, io);
    }, { root: box, rootMargin: "300px" });
    io.observe(sentinel);
    observers.push(io);
  }

  /** The page above. The scroll position is held against the content that was already there. */
  async function loadOlder(g, io) {
    if (!older || g !== gen) return;
    const cursor = older;
    older = null;
    io.disconnect();
    const sentinel = box.querySelector(".more");
    try {
      const data = await ctx.pull(`/api/social/c/${peer}?before=${cursor.at}&id=${encodeURIComponent(cursor.id)}`);
      if (g !== gen) return;
      await Promise.all(data.messages.map((m) => open(peer, m)));
      if (g !== gen) return;
      const height = box.scrollHeight;
      const top = box.scrollTop;
      sentinel.after(...data.messages.map((m) => bubble(peer, m)));
      older = data.next || null;
      if (!older) sentinel.remove();
      box.scrollTop = top + (box.scrollHeight - height);
      armOlder(g);
    } catch (cause) {
      if (g !== gen) return;
      older = cursor;
      sentinel.replaceChildren(el("p", { class: "err", text: cause.message }));
    }
  }

  /** Newer messages in the open conversation, from the poll. Reading them marks them read. */
  async function loadNewer(g) {
    if (g !== gen || !box) return;
    const from = newest || { at: 0, id: "0" };
    const data = await ctx.pull(`/api/social/c/${peer}?after=${from.at}&id=${encodeURIComponent(from.id)}`);
    if (g !== gen || !data.messages.length) return;
    await Promise.all(data.messages.map((m) => open(peer, m)));
    if (g !== gen) return;
    append(data.messages);
  }

  function append(messages) {
    const stick = nearBottom();
    box.querySelector(".hello")?.remove();
    for (const m of messages) {
      if (box.querySelector(`#m-${CSS.escape(m.id)}`)) continue;
      box.append(bubble(peer, m));
      newest = { at: m.at, id: m.id };
    }
    if (stick) toBottom();
  }

  function composer(who) {
    const shots = [];
    let busy = 0;
    const area = el("textarea", {
      maxlength: String(MAX_CHAT),
      rows: "1",
      placeholder: `Message ${who}`,
      "aria-label": `Message ${who}`,
      enterkeyhint: "send",
    });
    const strip = el("div", { class: "shots", hidden: true });
    const file = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
    const add = el("button", { type: "button", class: "tool", "aria-label": "Add photos" });
    add.innerHTML = '<svg width="22" height="22" aria-hidden="true"><use href="#pi"/></svg>';
    const button = el("button", { type: "submit", class: "post-go", text: "Send", disabled: true });
    const note = el("span", { class: "wait", hidden: true });
    const ready = () => !busy && (area.value.trim().length > 0 || shots.length > 0);
    const sync = () => {
      button.disabled = !ready();
    };

    function paintShots() {
      strip.replaceChildren(
        ...shots.map((shot, i) => {
          const remove = el("button", { type: "button", "aria-label": "Remove photo", text: "×" });
          remove.addEventListener("click", () => {
            shots.splice(i, 1);
            paintShots();
            sync();
          });
          return el("figure", {}, el("img", { src: shot.url, alt: "" }), remove);
        }),
      );
      strip.hidden = !shots.length;
    }

    add.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const picked = [...(file.files || [])];
      file.value = "";
      if (!picked.length) return;
      note.hidden = true;
      const room = 4 - shots.length;
      if (picked.length > room) {
        note.hidden = false;
        note.textContent = "Four photos at most.";
      }
      busy++;
      sync();
      for (const item of picked.slice(0, Math.max(0, room))) {
        try {
          const [full] = await ctx.shrink(item, [[960, 0, 48 * 1024, 0.82]]);
          const url = URL.createObjectURL(full);
          urls.push(url);
          shots.push({ url, full });
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
      area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
      sync();
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (ready()) form.requestSubmit();
      }
    });
    const form = el(
      "form",
      { class: "composer chat-compose" },
      strip,
      el("div", { class: "compose-bar" }, add, file, area, button),
      note,
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ready()) return;
      busy++;
      sync();
      note.hidden = true;
      const text = area.value.trim();
      try {
        const m = await deliver(who, text, shots);
        m.text = text;
        m.urls = shots.map((s) => s.url);
        area.value = "";
        area.style.height = "auto";
        shots.length = 0;
        paintShots();
        const p = peerOf(who);
        learn({ with: who, avatarRev: p.avatarRev, at: m.at, unread: 0, pub: p.keys.get(p.cur) || null, last: m });
        paintList();
        append([m]);
        toBottom();
      } catch (cause) {
        note.hidden = false;
        note.textContent = cause.message;
        if (!mine) openThread(peer);
      } finally {
        busy--;
        sync();
      }
    });
    setTimeout(() => area.focus(), 0);
    return form;
  }

  /**
   * Header JSON, then the sealed photos. A 409 means a key moved on one side:
   * the other person's is fetched again and the message is sealed once more.
   */
  async function deliver(who, text, shots, again = false) {
    const p = peerOf(who);
    const key = pairKey(who, p.cur);
    if (!key) throw new Error(`${who} hasn't turned on Messenger yet.`);
    const k = await key;
    const dir = `${name}>${who}`;
    const iv = random(12);
    const ivText = b64u(iv);
    const ct = await seal(k, iv, te.encode(text), dir);
    const photos = await Promise.all(
      shots.map(async (shot, i) => {
        const piv = random(12);
        return new Blob([piv, await seal(k, piv, await shot.full.arrayBuffer(), `${dir} ${ivText} ${i}`)]);
      }),
    );
    const head = te.encode(JSON.stringify({ kf: mine.v, kt: p.cur, iv: ivText, ct: b64u(ct) }));
    const top = new Uint8Array(3 + head.length);
    new DataView(top.buffer).setUint16(0, head.length);
    top.set(head, 2);
    top[2 + head.length] = photos.length;
    const parts = [top];
    for (const photo of photos) {
      const len = new DataView(new ArrayBuffer(4));
      len.setUint32(0, photo.size);
      parts.push(len, photo);
    }
    const res = await fetch(`/api/social/c/${who}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
      body: new Blob(parts),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.stale && !again) {
      await loadStatus();
      if (!mine) throw new Error("Your Messenger key changed on another device. Unlock it here to keep writing.");
      const fresh = await ctx.pull(`/api/social/c/${who}`);
      know(fresh.peer);
      return deliver(who, text, shots, true);
    }
    if (!res.ok) throw new Error(data.error || "The message was not sent.");
    return data.message;
  }

  function know(info) {
    if (!info) return;
    const p = peerOf(info.name);
    p.avatarRev = info.avatarRev;
    for (const k of info.keys) p.keys.set(k.v, k.pub);
    p.cur = info.keys.length ? info.keys[info.keys.length - 1].v : 0;
  }

  function idle() {
    main.replaceChildren(
      lockState() === "ready"
        ? el("div", { class: "lock" }, el("p", { class: "muted", text: "Pick a chat, or type a handle to start one." }))
        : lockPanel(),
    );
  }

  async function openThread(who) {
    const g = ++gen;
    for (const io of observers.splice(0)) io.disconnect();
    peer = who;
    older = newest = box = null;
    document.body.classList.toggle("open", !!who);
    document.title = `${who || "Messenger"} | Social`;
    paintList();
    armList();
    if (!who) return idle();
    if (lockState() !== "ready") {
      main.replaceChildren(head(who), lockPanel());
      return;
    }
    main.replaceChildren(head(who), el("p", { class: "muted pad", text: "…" }));
    let data;
    try {
      data = await ctx.pull(`/api/social/c/${who}`);
    } catch (cause) {
      if (g === gen) main.replaceChildren(head(who), el("p", { class: "err pad", text: cause.message }));
      return;
    }
    if (g !== gen) return;
    know(data.peer);
    const c = chats.get(who);
    if (c && c.unread) {
      c.unread = 0;
      paintList();
    }
    await Promise.all(data.messages.map((m) => open(who, m)));
    if (g !== gen) return;
    box = el("div", { class: "msgs", role: "log", "aria-live": "polite" });
    older = data.next || null;
    if (older) box.append(el("div", { class: "more" }));
    if (!data.messages.length) box.append(el("p", { class: "muted pad hello", text: "No messages yet. Say hello." }));
    for (const m of data.messages) {
      box.append(bubble(who, m));
      newest = { at: m.at, id: m.id };
    }
    const foot = peerOf(who).cur
      ? composer(who)
      : el("p", { class: "muted chat-off", text: `${who} hasn't turned on Messenger yet. They need a passkey to receive encrypted messages.` });
    main.replaceChildren(head(who), box, foot);
    toBottom();
    armOlder(g);
  }

  function go(who) {
    if (who === peer) return;
    find.value = "";
    hits.hidden = true;
    history.pushState(null, "", who ? `/social/c/${who}` : "/social/c");
    openThread(who);
  }

  function fromPath() {
    const m = location.pathname.match(/^\/social\/c\/([a-z0-9_]{3,16})\/?$/);
    return m && m[1] !== name ? m[1] : "";
  }

  const onPop = () => {
    if (location.pathname.startsWith("/social/c")) openThread(fromPath());
  };

  /** Every conversation that moved since the newest one seen; the open one also pulls its new messages. */
  async function poll() {
    if (stopped) return;
    if (document.visibilityState === "visible") {
      try {
        const data = await ctx.pull(`/api/social/c?after=${since}`);
        const moved = data.chats.filter((c) => {
          const held = chats.get(c.with);
          return !held || held.last.id !== c.last.id || held.unread !== c.unread;
        });
        if (moved.length) {
          await take(moved);
          const here = moved.find((c) => c.with === peer);
          if (here && box && here.last.id !== newest?.id) {
            await loadNewer(gen);
            here.unread = 0;
          }
          paintList();
        }
      } catch {
        // The next tick tries again. A 401 has already signed the page out.
      }
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }

  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    clearTimeout(timer);
    poll();
  };

  async function start() {
    side.replaceChildren(
      el("div", { class: "find" }, find, hits),
      listErr,
      list,
    );
    ctx.useSide(true);
    main.replaceChildren(el("p", { class: "muted pad", text: "…" }));
    try {
      const [first] = await Promise.all([ctx.pull("/api/social/c"), loadStatus()]);
      await take(first.chats);
      listNext = first.next || null;
    } catch (cause) {
      if (!ctx.me()) {
        ctx.renderSide(null);
        main.replaceChildren(el("p", { class: "muted pad", text: "Log in to use Messenger." }));
        return;
      }
      main.replaceChildren(el("p", { class: "err pad", text: cause.message }));
      return;
    }
    if (stopped) return;
    await openThread(fromPath());
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(poll, POLL_MS);
  }

  if (!name) {
    ctx.renderSide(null);
    main.replaceChildren(el("p", { class: "muted pad", text: "Log in to use Messenger." }));
  } else start();

  return () => {
    stopped = true;
    gen++;
    clearTimeout(timer);
    clearTimeout(findWait);
    for (const io of observers.splice(0)) io.disconnect();
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("visibilitychange", onVisible);
    document.body.classList.remove("chat", "open");
  };
}

window.__chat = { mount };
