/**
 * Advertise — lazy-loaded by social.js on /social/ads, exposed as `window.__ads`.
 *
 * With paid ads, the page is their list. Without, or on /social/ads/new, it is
 * the editor: the ad on the left; on the right, the ad as search shows it (words
 * only) or as a timeline does (a post, with the banner), and how it is doing;
 * the price along the bottom. Checkout saves the ad and shows a Solana Pay
 * code; the server sees the transfer and starts the ad (src/social/adPay.ts),
 * and this page only asks whether it has.
 */
import { el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { dialog, injectStyles } from "../js/ui.js";
import { injectFormStyles } from "../swap/ui.js";
import AD_CSS from "../ad.css";
import CSS from "./ads.css";

/** Matches the limits in src/social/limits.ts. */
const MAX = { cta: 24, title: 60, body: 140, url: 200, keyword: 40, keywords: 20, bid: 100, dollars: 10_000 };
const DEVICES = [
  ["all", "Desktop & mobile"],
  ["mobile", "Mobile only"],
  ["desktop", "Desktop only"],
];
/** How often checkout asks whether the transfer has been seen. */
const POLL_MS = 3000;
/** Each copy of a banner: width, and the byte ceiling the server holds it to. */
const BANNER_SIZES = [
  [639, 14 * 1024],
  [1200, 48 * 1024],
];

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Base units as a decimal amount, without a float. */
function decimal(units, places) {
  const text = String(units).padStart(places + 1, "0");
  const frac = text.slice(-places).replace(/0+$/, "");
  return frac ? `${text.slice(0, -places)}.${frac}` : text.slice(0, -places);
}

function usd(cents) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** As the server keeps a keyword: lower case, letters and digits, one space between. */
function keywordOf(text) {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Left with something to spend at its bid. */
function running(ad) {
  return ad.keywords.some((k) => k.budget - k.spent >= ad.bid);
}

/** One figure over an ad's keywords: budget, spent, shown or social. */
function total(ad, key) {
  return ad.keywords.reduce((n, k) => n + k[key], 0);
}

function count(n) {
  return n.toLocaleString("en-US");
}

/**
 * The picture cropped to 3:1 from its middle, as the phone and the desktop
 * JPEG, each stepped down in quality and then size until it fits.
 * @param {File} file
 */
async function bannerOf(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(file);
  }
  try {
    const sw = Math.min(bmp.width, bmp.height * 3);
    if (sw < 300) throw new Error("Use a picture at least 300 pixels wide.");
    const sh = sw / 3;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not read that picture.");
    const out = [];
    for (const [edge, max] of BANNER_SIZES) {
      // A multiple of 3, so the copy is exactly 3:1.
      let w = 3 * Math.floor(Math.min(edge, sw) / 3);
      let quality = 0.84;
      for (let i = 0; ; i++) {
        if (i === 12) throw new Error("Could not fit that picture.");
        canvas.width = w;
        canvas.height = w / 3;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, w / 3);
        ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, w / 3);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= max) {
          out.push(blob);
          break;
        }
        if (quality > 0.5) quality = Math.round((quality - 0.1) * 100) / 100;
        else {
          w = 3 * Math.floor((w * 0.85) / 3);
          quality = 0.7;
        }
      }
    }
    return { small: out[0], full: out[1] };
  } finally {
    bmp.close();
  }
}

/** u16 length and the ad as JSON, then a new banner's two lengths and JPEGs, phone copy first. */
function pack(json, shot) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const head = new DataView(new ArrayBuffer(2));
  head.setUint16(0, text.length);
  const parts = [head, text];
  if (shot) {
    const lens = new DataView(new ArrayBuffer(8));
    lens.setUint32(0, shot.small.size);
    lens.setUint32(4, shot.full.size);
    parts.push(lens, shot.small, shot.full);
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

// —— a draft, kept in this browser until it is saved ——

/** By ad, or "new": the fields, the keywords and what each adds, the banner, and a pending ad's id. */
const draftKey = (key) => `ug.ad.${key}`;

function readDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(key)) || "null");
  } catch {
    return null;
  }
}

function writeDraft(key, value) {
  try {
    if (value) localStorage.setItem(draftKey(key), JSON.stringify(value));
    else localStorage.removeItem(draftKey(key));
  } catch {
    // No storage, or it is full: the draft lasts as long as the page.
  }
}

/** A picked banner's JPEGs as data URLs, so a draft keeps them; under 90 KB together. */
function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function blobOf(url) {
  const bytes = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type: "image/jpeg" });
}

// —— the list: your campaigns, and every checkout's receipt ——

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function when(at) {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What an order asks for: SOL first, as checkout offers it. */
function asked(order) {
  const usdc = `${decimal(order.usdc, 6)} USDC`;
  return order.lamports ? `${decimal(order.lamports, 9)} SOL or ${usdc}` : usdc;
}

function short(text) {
  return text ? `${text.slice(0, 4)}…${text.slice(-4)}` : "—";
}

/**
 * @param {HTMLElement} main
 * @param {"campaigns" | "receipts"} tab
 * @param {HTMLElement} content
 */
function frame(main, tab, content) {
  const add = el("a", { class: "av-new", href: "/social/ads/new" });
  // The sprite's wand, from social.html: static markup.
  add.innerHTML = '<svg aria-hidden="true"><use href="#n-ad"/></svg>New ad';
  const tabs = el(
    "nav",
    { class: "av-tabs", "aria-label": "Advertise" },
    ...[
      ["campaigns", "Campaigns", "/social/ads"],
      ["receipts", "Receipts", "/social/ads/receipts"],
    ].map(([key, text, href]) =>
      el("a", { href, text, class: key === tab ? "on" : null, "aria-current": key === tab ? "page" : null }),
    ),
  );
  main.replaceChildren(el("div", { class: "av-l" }, el("div", { class: "av-lh" }, tabs, add), content));
}

function table(heads, numeric, rows, empty) {
  if (!rows.length) return el("p", { class: "av-none", text: empty });
  return el(
    "table",
    { class: "av-t" },
    el("thead", {}, el("tr", {}, ...heads.map((text, i) => el("th", { class: numeric.includes(i) ? "num" : null, text })))),
    el("tbody", {}, ...rows),
  );
}

function campaigns(main, ads) {
  const rows = ads.map((ad) => {
    const live = running(ad);
    const href = `/social/ads/${ad.id}`;
    const shown = total(ad, "shown");
    const social = total(ad, "social");
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        el(
          "a",
          { class: "av-ad", href },
          ad.banner
            ? el("img", { class: "av-th", src: `/social/b/${ad.id}?v=${ad.banner}&m=1`, alt: "" })
            : el("i", { class: "av-th" }),
          el(
            "span",
            {},
            el("b", { text: ad.title }),
            el("small", { text: `${ad.memo} · ${hostOf(ad.url)} · ${ad.keywords.map((k) => k.keyword).join(", ")}` }),
          ),
        ),
      ),
      el("td", {}, el("span", { class: live ? "av-on" : "av-done", text: live ? "Running" : "Out of budget" })),
      el("td", { class: "num", text: `${ad.bid}¢` }),
      el("td", { class: "num", text: count(shown - social) }),
      el("td", { class: "num", text: count(social) }),
      el("td", { class: "num", text: `${usd(total(ad, "spent"))} of ${usd(total(ad, "budget"))}` }),
      el("td", {}, el("a", { href, text: live ? "Edit" : "Add budget" })),
    );
  });
  frame(
    main,
    "campaigns",
    table(["Ad", "Status", "Bid", "Search", "Social", "Spent", ""], [2, 3, 4, 5], rows, "No campaign is paid for yet. Its receipt is under Receipts."),
  );
}

const STATUS = { open: ["Waiting for payment", "av-wait"], paid: ["Paid", "av-on"], expired: ["Expired", "av-done"] };

function txLink(signature) {
  return signature && SIGNATURE.test(signature)
    ? el("a", { href: `https://solscan.io/tx/${signature}`, target: "_blank", rel: "noopener", text: short(signature) })
    : el("span", { class: "av-done", text: "—" });
}

/** One checkout, every fact kept about it: what it asked for, and the transfer that paid it. */
function checkoutFacts(r) {
  const [label, tone] = STATUS[r.status];
  const facts = [
    ["Order", r.id],
    ["Made", when(r.at)],
    ["Reference", r.reference],
    ["Paid to", r.to || "—"],
    ["Asked", asked(r)],
    ...(r.signature
      ? [
          ["Received", r.fund === "sol" ? `${decimal(r.received, 9)} SOL` : `${decimal(r.received, 6)} USDC`],
          ["From", r.payer || "—"],
          ["Matched by", r.matched || "—"],
          ["Transaction", r.signature],
          ["Paid", when(r.paidAt)],
        ]
      : []),
  ];
  return el(
    "div",
    { class: "av-co" },
    el("div", { class: "av-coh" }, el("b", { text: usd(r.cents) }), el("span", { class: tone, text: label })),
    el("dl", {}, ...facts.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
  );
}

/**
 * One row per campaign, by its memo: what has been paid for it, whether a
 * checkout is waiting, and the latest transfer. Details lists every checkout
 * it has had, paid or not, so a payment can always be traced. A waiting one
 * can show its code again.
 */
function receipts(main, list, pull) {
  const campaigns = new Map();
  for (const r of list) campaigns.set(r.memo, [...(campaigns.get(r.memo) || []), r]);
  const rows = [...campaigns.values()].flatMap((checkouts) => {
    const [newest] = checkouts;
    const paid = checkouts.filter((r) => r.status === "paid");
    const waiting = checkouts.find((r) => r.status === "open");
    const [label, tone] = STATUS[waiting ? "open" : paid.length ? "paid" : "expired"];
    const latest = Math.max(...checkouts.map((r) => Math.max(r.at, r.paidAt || 0)));
    const total = paid.reduce((n, r) => n + r.cents, 0);
    const sub = [
      paid.length ? `${paid.length} ${paid.length === 1 ? "payment" : "payments"}` : "",
      waiting ? `${usd(waiting.cents)} waiting` : paid.length ? "" : asked(newest),
    ].filter(Boolean).join(" · ");
    const more = el(
      "tr",
      { class: "av-more", hidden: true },
      el("td", { colspan: "6" }, el("div", { class: "av-cos" }, ...checkouts.map(checkoutFacts))),
    );
    const toggle = el("button", {
      type: "button",
      class: "av-link",
      text: checkouts.length > 1 ? `Details (${checkouts.length})` : "Details",
      "aria-expanded": "false",
      onclick: () => {
        more.hidden = !more.hidden;
        toggle.setAttribute("aria-expanded", String(!more.hidden));
      },
    });
    const row = el(
      "tr",
      {},
      el("td", { class: "av-when", text: when(latest) }),
      el("td", {}, el("span", { class: "av-ad" }, el("span", {}, el("b", { text: newest.title }), el("small", { text: newest.memo })))),
      el("td", { class: "num" }, el("b", { text: usd(paid.length ? total : newest.cents) }), el("small", { class: "av-sub", text: sub })),
      el("td", {}, el("span", { class: tone, text: label })),
      el("td", {}, txLink(paid[0]?.signature)),
      el(
        "td",
        {},
        el(
          "span",
          { class: "av-acts" },
          waiting ? el("button", { type: "button", class: "av-2nd", text: "Show code", onclick: () => pay(waiting, pull, false) }) : null,
          toggle,
        ),
      ),
    );
    return [row, more];
  });
  frame(main, "receipts", table(["Latest", "Campaign", "Paid", "Status", "Transaction", ""], [2], rows, "No checkouts yet."));
}

// —— the editor ——

/** A segmented control: [key, label] options, the current one pressed. */
function segment(box, options, current, choose) {
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

/** One figure under the preview. */
function stat(value, label) {
  return el("div", { class: "av-st" }, el("b", { text: value }), el("span", { text: label }));
}

/**
 * @param {{
 *   main: HTMLElement,
 *   ad: any,
 *   payable: boolean,
 *   back: boolean,
 *   pull: (path: string, opts?: object) => Promise<any>,
 *   adPost: (ad: object) => HTMLElement,
 *   me: () => null | { name: string, avatarRev: number },
 * }} ctx `ad` is a paid ad to edit, or null for a new one; `back`, whether there is a list
 */
function editor({ main, ad, payable, back, pull, adPost, me }) {
  injectFormStyles();
  const fresh = !ad;
  const draft = {
    cta: ad?.cta || "",
    url: ad?.url || "",
    title: ad?.title || "",
    body: ad?.body || "",
    devices: ad?.devices || "all",
    bid: ad?.bid || 1,
    keywords: (ad?.keywords || []).map((k) => ({ ...k, add: 0 })),
    /** What the preview shows, and a new banner to upload with the next save. */
    banner: ad?.banner ? `/social/b/${ad.id}?v=${ad.banner}` : "",
    shot: null,
  };
  /** A new ad saved at checkout but not paid yet: checking out again updates it, under the same memo. */
  let pending = null;
  /** The picked banner as data URLs, for the draft. */
  let shotData = null;
  const key = ad?.id || "new";
  const snapshot = () =>
    JSON.stringify([draft.cta, draft.url, draft.title, draft.body, draft.devices, draft.bid, draft.banner, draft.keywords.map((k) => [k.keyword, k.add])]);
  const unchanged = snapshot();
  const kept = readDraft(key);
  if (kept) {
    for (const field of ["cta", "url", "title", "body", "devices", "bid"]) if (kept[field] != null) draft[field] = kept[field];
    // The server's money for the keywords it has; a keyword with budget left stays even if the draft dropped it.
    const known = new Map(draft.keywords.map((k) => [k.keyword, k]));
    draft.keywords = (kept.keywords || []).map((k) => ({
      ...(known.get(k.keyword) || { keyword: k.keyword, budget: 0, spent: 0, shown: 0, social: 0 }),
      add: k.add,
    }));
    for (const k of known.values()) {
      if (k.budget > k.spent && !draft.keywords.some((d) => d.keyword === k.keyword)) draft.keywords.push(k);
    }
    pending = kept.pending || null;
    if (kept.shot) {
      shotData = kept.shot;
      draft.shot = { small: blobOf(kept.shot.small), full: blobOf(kept.shot.full) };
      draft.banner = URL.createObjectURL(draft.shot.full);
    } else if (typeof kept.banner === "string" && !kept.banner.startsWith("blob:")) draft.banner = kept.banner;
  }
  let saving = 0;
  /** Into this browser, a moment after the last change; away again once it matches what is saved. */
  function keep() {
    clearTimeout(saving);
    saving = setTimeout(() => {
      if (snapshot() === unchanged && !pending) return writeDraft(key, null);
      writeDraft(key, {
        cta: draft.cta,
        url: draft.url,
        title: draft.title,
        body: draft.body,
        devices: draft.devices,
        bid: draft.bid,
        keywords: draft.keywords.map((k) => ({ keyword: k.keyword, add: k.add })),
        banner: draft.banner,
        shot: draft.shot ? shotData : null,
        pending,
      });
    }, 300);
  }
  let surface = "search";
  let view = draft.devices === "mobile" ? "mobile" : "desktop";

  // —— the form ——

  const line = (key, label, attrs, hint) => {
    const id = `av-${key}`;
    const input = el(attrs.rows ? "textarea" : "input", { id, class: "av-in", required: true, maxlength: String(MAX[key]), ...attrs });
    input.value = draft[key];
    input.addEventListener("input", () => {
      draft[key] = input.value;
      paint();
    });
    return el(
      "div",
      { class: "av-fd" },
      el("label", { class: "av-lb", for: id, text: label }),
      input,
      hint ? el("p", { class: "av-hint", text: hint }) : null,
    );
  };

  const link = line("url", "Link", { type: "url", placeholder: "https://example.com", inputmode: "url", spellcheck: "false" });
  const urlInput = /** @type {HTMLInputElement} */ (link.querySelector("input"));
  // Typed without a scheme, it is meant as https.
  urlInput.addEventListener("change", () => {
    const value = urlInput.value.trim();
    if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) urlInput.value = draft.url = `https://${value}`;
    paint();
  });

  const kwList = el("ul", { class: "av-kws" });
  const kwInput = el("input", {
    class: "av-in",
    maxlength: String(MAX.keyword),
    placeholder: "Add a keyword",
    "aria-label": "Add a keyword",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const kwAdd = el("button", { type: "button", class: "av-2nd", text: "Add", onclick: addKeyword });
  kwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      addKeyword();
    }
  });

  function addKeyword() {
    // A pasted list adds each, split at commas.
    for (const part of kwInput.value.split(",")) {
      const keyword = keywordOf(part).slice(0, MAX.keyword).trim();
      if (!keyword || draft.keywords.some((k) => k.keyword === keyword)) continue;
      if (draft.keywords.length >= MAX.keywords) return say(`Up to ${MAX.keywords} keywords.`, true);
      draft.keywords.push({ keyword, budget: 0, spent: 0, shown: 0, social: 0, add: 100 });
    }
    kwInput.value = "";
    paintKeywords();
    paint();
  }

  function paintKeywords() {
    kwList.replaceChildren(
      ...draft.keywords.map((k) => {
        const paid = k.budget > 0;
        const left = k.budget - k.spent;
        const money = el("input", {
          class: "av-in",
          type: "number",
          inputmode: "numeric",
          min: paid ? "0" : "1",
          max: String(MAX.dollars),
          step: "1",
          required: !paid,
          placeholder: "0",
          "aria-label": paid ? `Add to ${k.keyword}, in dollars` : `Budget for ${k.keyword}, in dollars`,
        });
        money.value = k.add ? String(k.add / 100) : "";
        money.addEventListener("input", () => {
          k.add = Math.max(0, Math.round(Number(money.value) || 0)) * 100;
          paint();
        });
        let name;
        if (paid) name = el("b", { text: k.keyword });
        else {
          name = el("input", { class: "av-in", maxlength: String(MAX.keyword), "aria-label": "Keyword", required: true });
          name.value = k.keyword;
          name.addEventListener("input", () => {
            k.keyword = name.value;
            paint();
          });
          name.addEventListener("change", () => {
            name.value = k.keyword = keywordOf(name.value);
            paint();
          });
        }
        const remove = el("button", {
          type: "button",
          class: "av-x",
          text: "×",
          "aria-label": `Remove ${k.keyword}`,
          onclick: () => {
            draft.keywords.splice(draft.keywords.indexOf(k), 1);
            paintKeywords();
            paint();
          },
        });
        return el(
          "li",
          { class: "av-kw" },
          name,
          el("span", { class: "av-usd", "data-p": paid ? "+$" : "$" }, money),
          // Paid budget is never withdrawn, so a keyword with some left stays.
          left > 0 ? el("span") : remove,
          paid
            ? el("small", {
                text: `${usd(left)} left of ${usd(k.budget)} · ${count(k.shown - k.social)} on search · ${count(k.social)} on social`,
              })
            : null,
        );
      }),
    );
  }

  const bid = el("input", {
    id: "av-bid",
    class: "av-in av-bid",
    type: "number",
    inputmode: "numeric",
    min: "1",
    max: String(MAX.bid),
    step: "1",
    required: true,
  });
  bid.value = String(draft.bid);
  bid.addEventListener("input", () => {
    draft.bid = Math.max(1, Math.round(Number(bid.value) || 1));
    paint();
  });

  const file = el("input", { type: "file", accept: "image/*" });
  const pick = el("label", { class: "av-2nd av-file" }, el("span"), file);
  const drop = el("button", {
    type: "button",
    class: "av-2nd",
    text: "Remove",
    onclick: () => {
      draft.banner = "";
      draft.shot = null;
      paint();
    },
  });
  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    say("");
    try {
      const shot = await bannerOf(picked);
      shotData = { small: await dataUrl(shot.small), full: await dataUrl(shot.full) };
      if (draft.banner.startsWith("blob:")) URL.revokeObjectURL(draft.banner);
      draft.shot = shot;
      draft.banner = URL.createObjectURL(shot.full);
      // A new banner is seen where it is shown.
      surface = "social";
      paint();
    } catch (cause) {
      say(cause.message, true);
    }
  });

  const seg = el("div", { class: "swx-seg av-seg", role: "group", "aria-label": "Runs on" });

  const form = el(
    "form",
    { class: "av-f", novalidate: true },
    back ? el("a", { class: "av-back", href: "/social/ads", text: "Your ads" }) : null,
    el("h2", { text: fresh ? "New ad" : "Edit ad" }),
    kept
      ? el(
          "p",
          { class: "av-hint" },
          "Your unsaved changes are back. ",
          el("button", {
            type: "button",
            class: "av-link",
            text: "Discard them",
            onclick: () => {
              clearTimeout(saving);
              writeDraft(key, null);
              location.reload();
            },
          }),
        )
      : null,
    ad ? el("p", { class: "av-hint", text: `Campaign ${ad.memo}. Every payment for it carries this memo.` }) : null,
    line("cta", "Call to action", { placeholder: "Learn more" }, "The button on search, and the link on social."),
    link,
    line("title", "Title", { placeholder: "What you offer, in a few words" }, "The headline on search, and the caption on social."),
    line("body", "Description", { rows: "3", placeholder: "A sentence or two about it." }, "On search only."),
    el(
      "div",
      { class: "av-fd" },
      el("span", { class: "av-lb", text: "Keywords" }),
      kwList,
      el("div", { class: "av-add" }, kwInput, kwAdd),
      el("p", {
        class: "av-hint",
        text: "The ad shows on searches that contain every word of a keyword, and in the timeline of someone whose latest post does. Each keyword has a budget of its own, from $1.",
      }),
    ),
    el(
      "div",
      { class: "av-fd" },
      el("label", { class: "av-lb", for: "av-bid", text: "Bid per impression" }),
      el("div", { class: "av-row" }, bid, el("span", { text: "¢" })),
      el("p", { class: "av-hint", text: "1¢ an impression to start. A higher bid shows first, for as long as its budget lasts." }),
    ),
    el(
      "div",
      { class: "av-fd" },
      el("span", { class: "av-lb", text: "Banner" }),
      el("div", { class: "av-row" }, pick, drop),
      el("p", { class: "av-hint", text: "Optional, and on social only, under the caption. Cropped to 3:1 from the middle." }),
    ),
    el("div", { class: "av-fd" }, el("span", { class: "av-lb", text: "Runs on" }), seg),
  );
  form.addEventListener("submit", (e) => e.preventDefault());

  // —— the preview: the ad as search draws it, or as a timeline does ——

  const site = el("span");
  const title = el("h3");
  const body = el("span", { class: "ad-d" });
  const cta = el("span", { class: "ad-c" });
  const card = el("div", { class: "ad" }, el("span", { class: "ad-s" }, el("b", { text: "Sponsored" }), site), title, body, cta);
  const postBox = el("div", { class: "av-post" });
  /** The banner and host the drawn post was built with; a change rebuilds it, words are patched in. */
  let built = "";
  let post = null;

  /** The ad alone, centred, at a computer's width or a phone's. */
  const stage = el("div");
  const off = el("p", { class: "av-off", hidden: true });
  const surfaces = el("div", { class: "swx-seg", role: "group", "aria-label": "Where" });
  const views = el("div", { class: "swx-seg", role: "group", "aria-label": "Preview on" });
  const stats = el("div", { class: "av-sts" });
  const preview = el(
    "section",
    { class: "av-p", "aria-label": "Preview" },
    el("div", { class: "av-pt" }, surfaces, views),
    stage,
    off,
    stats,
  );

  // —— the price ——

  const due = el("b");
  const detail = el("span");
  const msg = el("p", { class: "av-msg", role: "alert" });
  const go = el("button", { type: "button", class: "av-go", onclick: checkout });
  const bar = el("div", { class: "av-bar" }, el("div", { class: "av-sum" }, due, detail), msg, go);

  function say(text, err) {
    msg.textContent = text;
    msg.className = `av-msg${err ? " err" : ""}`;
  }

  function placeholder(node, value, empty) {
    node.textContent = value || empty;
    node.classList.toggle("av-empty", !value);
  }

  function paintSocial() {
    const host = hostOf(draft.url) || "example.com";
    const key = `${draft.banner}\n${host}`;
    const who = me() || { name: "you", avatarRev: 0 };
    if (key !== built) {
      built = key;
      post = adPost({ owner: who.name, ownerRev: who.avatarRev, title: "", cta: "", url: "", host, img: draft.banner, imgM: draft.banner });
      // A preview, not a link.
      post.removeAttribute("href");
      postBox.replaceChildren(post);
    }
    placeholder(post.querySelector(".post-main > p"), draft.title, "What you offer, in a few words");
    placeholder(post.querySelector(".sad-l b"), draft.cta, "Learn more");
  }

  function paintStats(cents) {
    if (ad) {
      const shown = total(ad, "shown");
      const social = total(ad, "social");
      const spent = total(ad, "spent");
      stats.replaceChildren(
        stat(count(shown - social), "on search"),
        stat(count(social), "on social"),
        stat(usd(spent), "spent"),
        stat(usd(total(ad, "budget") - spent), "left"),
      );
      return;
    }
    const reach = draft.keywords.reduce((n, k) => n + Math.floor(k.add / draft.bid), 0);
    stats.replaceChildren(
      stat(usd(cents), "budget"),
      stat(`${draft.bid}¢`, "an impression"),
      stat(count(reach), "impressions"),
    );
  }

  function paint() {
    segment(seg, DEVICES, draft.devices, (key) => {
      draft.devices = key;
      // Show it where it runs.
      if (key !== "all") view = key;
      paint();
    });
    segment(
      surfaces,
      [
        ["search", "Search"],
        ["social", "Social"],
      ],
      surface,
      (key) => {
        surface = key;
        paint();
      },
    );
    segment(
      views,
      [
        ["desktop", "Desktop"],
        ["mobile", "Mobile"],
      ],
      view,
      (key) => {
        view = key;
        paint();
      },
    );
    pick.firstChild.textContent = draft.banner ? "Replace banner" : "Upload banner";
    drop.hidden = !draft.banner;

    site.textContent = ` · ${hostOf(draft.url) || "example.com"}`;
    placeholder(title, draft.title, "What you offer, in a few words");
    placeholder(body, draft.body, "A sentence or two about it.");
    placeholder(cta, draft.cta, "Learn more");
    paintSocial();
    const mobile = view === "mobile";
    const runs = draft.devices === "all" || draft.devices === view;
    stage.className = `av-stage${mobile ? " av-m" : ""}${runs ? "" : " off"}`;
    stage.replaceChildren(surface === "social" ? postBox : card);
    off.hidden = runs;
    off.textContent = `This ad does not run on ${mobile ? "phones" : "computers"}.`;

    const cents = draft.keywords.reduce((n, k) => n + k.add, 0);
    const n = draft.keywords.filter((k) => k.add).length;
    due.textContent = usd(cents);
    detail.textContent = cents
      ? `${n} ${n === 1 ? "keyword" : "keywords"} · about ${count(Math.floor(cents / draft.bid))} impressions at ${draft.bid}¢`
      : fresh
        ? "Add a keyword to see the price."
        : "Nothing to pay";
    go.textContent = fresh ? "Checkout" : cents ? `Save and pay ${usd(cents)}` : "Save";
    go.disabled = fresh && !draft.keywords.length;
    if (cents && !payable && !msg.textContent) say("Payments are not set up on this server yet.", true);
    paintStats(cents);
    keep();
  }

  async function checkout() {
    say("");
    if (!form.reportValidity()) return;
    if (!draft.keywords.length) return say("Add a keyword.", true);
    go.disabled = true;
    const was = go.textContent;
    go.textContent = "Saving…";
    try {
      const id = ad?.id || pending;
      const json = {
        cta: draft.cta,
        url: draft.url,
        title: draft.title,
        body: draft.body,
        devices: draft.devices,
        bid: draft.bid,
        banner: !!draft.banner,
        keywords: draft.keywords.map((k) => ({ keyword: k.keyword, add: k.add })),
      };
      const data = await pull(id ? `/api/social/ads/${id}` : "/api/social/ads", { method: "POST", body: pack(json, draft.shot) });
      if (fresh) pending = data.ad.id;
      // Uploaded: the next save keeps it, and a draft names it by its address.
      draft.shot = null;
      shotData = null;
      if (data.ad.banner) draft.banner = `/social/b/${data.ad.id}?v=${data.ad.banner}`;
      keep();
      if (data.order) {
        pay(data.order, pull, fresh, () => {
          clearTimeout(saving);
          writeDraft(key, null);
        });
      } else {
        clearTimeout(saving);
        writeDraft(key, null);
        location.assign("/social/ads");
      }
    } catch (cause) {
      say(cause.message, true);
    } finally {
      go.disabled = false;
      go.textContent = was;
    }
  }

  paintKeywords();
  paint();
  main.replaceChildren(el("div", { class: "av" }, form, preview, bar));
}

// —— checkout ——

/**
 * The Solana Pay code, in SOL or USDC, until the server has seen the transfer
 * or the dialog is closed. SOL first: every wallet holds some, and a wallet
 * asked for a token it does not hold refuses the request. `paid` runs once it
 * is paid.
 */
async function pay(order, pull, fresh, paid) {
  injectFormStyles();
  let open = true;
  let fund = order.urls.sol ? "sol" : "usdc";
  const { body, close, setTitle } = dialog(`Pay ${usd(order.cents)}`, () => {
    open = false;
  });
  const funds = el("div", { class: "swx-seg av-funds", role: "group", "aria-label": "Pay in" });
  const sum = el("div", { class: "swx-note" });
  const holder = el("div", { class: "swx-qr", role: "img", "aria-label": "Solana Pay QR code" });
  const status = el("div", { class: "swx-note", role: "status", text: "Waiting for the payment…" });
  body.replaceChildren(
    order.urls.sol ? funds : null,
    sum,
    holder,
    el("div", { class: "av-memo" }, el("span", { text: "Memo" }), el("code", { text: order.memo })),
    el("p", {
      class: "av-fine",
      text: "Pay exactly this amount: its last digits tell this payment apart, even when a wallet leaves out the memo. Budget that is paid for stays with the ad: it can be edited, not withdrawn. This checkout is kept under Receipts.",
    }),
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
      const state = await pull(`/api/social/ads/order/${order.id}`);
      if (state.paid) return done();
      if (!state.open) {
        status.textContent = "This code has expired. Close it and check out again.";
        status.className = "swx-note err";
        return;
      }
    } catch {
      // A missed answer; the next one tells.
    }
  }

  function done() {
    paid?.();
    setTitle("Paid");
    const disc = el("div", { class: "swx-check", role: "img", "aria-label": "Paid" });
    disc.innerHTML = CHECK_SVG;
    const finish = el("button", {
      class: "swx-go",
      type: "button",
      text: "Done",
      onclick: () => {
        close();
        location.assign("/social/ads");
      },
    });
    body.replaceChildren(
      el(
        "div",
        { class: "swx-done" },
        disc,
        el("div", { class: "swx-done-t", text: fresh ? "Your ad is live" : "Budget added" }),
        el("div", { class: "swx-done-s", text: "It shows on search and in timelines for its keywords while its budget lasts." }),
      ),
      finish,
    );
    finish.focus();
  }
}

/**
 * @param {{
 *   main: HTMLElement,
 *   id: string,
 *   pull: (path: string, opts?: object) => Promise<any>,
 *   adPost: (ad: object) => HTMLElement,
 *   me: () => null | { name: string, avatarRev: number },
 * }} ctx `id` is "new", "receipts", an ad's id, or "" for the list. `adPost` is the timeline's own drawing of an ad.
 */
async function mount({ main, id, pull, adPost, me }) {
  injectStyles("ad-css", AD_CSS);
  injectStyles("ads-css", CSS);
  if (id === "receipts") return receipts(main, (await pull("/api/social/ads/receipts")).receipts, pull);
  if (id && id !== "new") {
    const data = await pull(`/api/social/ads/${id}`);
    return editor({ main, ad: data.ad, payable: data.payable, back: true, pull, adPost, me });
  }
  const data = await pull("/api/social/ads");
  const listed = data.ads.length > 0 || data.receipts > 0;
  // Nothing to list yet: straight to a first ad.
  if (id || !listed) return editor({ main, ad: null, payable: data.payable, back: listed, pull, adPost, me });
  campaigns(main, data.ads);
}

window.__ads = { mount };
