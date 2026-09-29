/**
 * The install panel: a strip along the bottom of a phone's screen that opens
 * into the steps for adding UtopianGO to the home screen, written for the
 * browser it is open in.
 *
 * Fetched by client/js/pwa.js a moment after load, and only on a phone or
 * tablet that is neither running the installed app nor has closed this panel
 * before. Closing it, or installing, is remembered for good.
 *
 * A <dialog> for the site's shared close button and sheet shape, but opened
 * without show(): that would move focus into it, and an offer nobody asked for
 * has no business taking the caret out of the search field. The expanding is
 * a <details>, so it needs no script and a keyboard already knows how.
 *
 * Every browser that can offer its own install prompt (Chrome, Edge, Samsung
 * Internet and the rest of Chromium on Android) gets an Install button as
 * well, which asks for it directly. The menu steps stay under it for the
 * browsers that never fire one, and for when it has been used up.
 */
import { ios as onIos } from "../js/device.js";
import { el } from "../js/dom.js";
import { settle } from "../js/pwa.js";
import { dismissible } from "../js/sheet.js";
import { injectStyles } from "../js/ui.js";

const CSS = `
dialog.pw{inset:auto 0 0;z-index:25;width:min(420px,calc(100% - 32px));max-height:calc(100% - 96px);
 margin:0 auto 16px;padding:0;overflow:auto;overscroll-behavior:contain;border:1px solid var(--b);
 border-radius:16px;background:var(--pn);color:var(--t);font:14px/1.45 var(--ff);
 box-shadow:0 8px 32px rgba(0,0,0,.18);animation:pw-up .3s ease-out}
@keyframes pw-up{from{opacity:0;transform:translateY(24px)}}
.pw summary{display:flex;align-items:center;gap:12px;padding:12px 56px 12px 12px;list-style:none;
 cursor:pointer;-webkit-tap-highlight-color:transparent}
.pw summary::-webkit-details-marker{display:none}
.pw summary:focus-visible{outline:2px solid var(--a);outline-offset:-2px;border-radius:16px}
.pw-ic{flex:none;border-radius:10px;box-shadow:0 0 0 1px var(--b)}
.pw-tx{display:flex;flex-direction:column;flex:1;min-width:0}
.pw-tx b{font-weight:600}
.pw-tx span{color:var(--f);font-size:13px}
.pw-ch{flex:none;color:var(--f);transition:transform .2s}
.pw [open] .pw-ch{transform:rotate(180deg)}
.pw .dlg-x{top:17px}
.pw-b{padding:0 16px 16px}
.pw-go,.pw-cp{display:block;width:100%;padding:10px 12px;border:0;border-radius:999px;
 font:600 14px/1 var(--ff);cursor:pointer}
.pw-go{margin:0 0 14px;background:var(--buy);color:var(--buy-ink)}
.pw-cp{margin:12px 0 0;background:rgba(127,127,127,.16);color:var(--t)}
.pw-h{margin:0 0 6px;font-weight:600}
.pw-s{margin:0;padding-left:22px}
.pw-s li{margin:0 0 6px;padding-left:2px}
.pw-s b{font-weight:600}
.pw-i{display:inline-grid;place-items:center;width:24px;height:22px;border-radius:6px;
 background:rgba(127,127,127,.16);vertical-align:middle}
.pw-i svg{display:block}
.pw-n{margin:8px 0 0;font-size:13px;color:var(--f)}
body.chat dialog.pw{display:none}
@media (prefers-reduced-motion:reduce){dialog.pw{animation:none}.pw-ch{transition:none}}
@media (max-width:620px){dialog.pw{width:100%;margin:0;border-width:1px 0 0;
 border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom)}}
@media (max-width:900px){body.soc dialog.pw{bottom:calc(57px + env(safe-area-inset-bottom));padding-bottom:0}}
`;

/** A 16px glyph on the 24-unit grid the site's other icons use. */
function svg(body, filled = false) {
  const paint = filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg width="16" height="16" viewBox="0 0 24 24" ${paint}>${body}</svg>`;
}

/** The buttons the steps point at, drawn the way the browsers draw them. */
const ICONS = {
  Share: svg('<path d="M12 3v12M8 7l4-4 4 4M9 10H6v11h12V10h-3"/>'),
  More: svg('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>', true),
  Menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  "More options": svg('<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>', true),
};

/**
 * One of the buttons above, labelled with its name, so a screen reader hears
 * "Tap More" where the eye sees the dots.
 * @param {keyof typeof ICONS} name
 */
function ico(name) {
  const node = el("span", { class: "pw-i", role: "img", "aria-label": name });
  node.innerHTML = ICONS[name];
  return node;
}

/** What a step says to tap, as the browser labels it. */
const b = (text) => el("b", { text });

/** Apps that open links in a browser of their own, which cannot install anything. */
const IN_APP = [
  [/Instagram/, "Instagram"],
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/musical_ly|BytedanceWebview|TikTok/, "TikTok"],
  [/LinkedInApp/, "LinkedIn"],
  [/Snapchat/, "Snapchat"],
];

const IOS_NOTE = ["Not in the list? Open this page in Safari and add it from there."];

/**
 * @typedef {object} Guide
 * @property {string} head the line over the steps
 * @property {(Node | string)[][]} steps
 * @property {(Node | string)[]} [note]
 * @property {boolean} [copy] offer to copy the link, for taking it to another browser
 */

/**
 * The steps for the browser this is open in, read off the user agent — the
 * only place a page can learn which browser's menus it is describing.
 * @returns {Guide}
 */
function guide() {
  const ua = navigator.userAgent;
  const ios = onIos();

  // An in-app browser first: whatever engine it runs, it has no install. On
  // iOS every real browser still says Safari/ in its user agent, and the web
  // views apps embed do not.
  const app = IN_APP.find(([re]) => re.test(ua))?.[1];
  if (app || / wv\)/.test(ua) || (ios && !/Safari\//.test(ua))) {
    const real = ios ? "Safari" : "Chrome";
    return {
      head: `${app || "This app"} opens links in a browser that can't install apps. Open this page in ${real} first:`,
      steps: [
        ["Tap ", ico(ios ? "More" : "More options"), " in a top corner."],
        ["Tap ", b("Open in browser"), " or ", b(`Open in ${real}`), "."],
        ["Follow the steps there."],
      ],
      copy: true,
    };
  }

  if (ios) {
    const shared = [
      ["Scroll down and tap ", b("Add to Home Screen"), "."],
      ["Tap ", b("Add"), ". If you see ", b("Open as Web App"), ", leave it on."],
    ];
    if (/CriOS/.test(ua)) {
      return { head: "In Chrome:", steps: [["Tap ", ico("Share"), " in the address bar."], ...shared], note: IOS_NOTE };
    }
    if (/FxiOS/.test(ua)) {
      return { head: "In Firefox:", steps: [["Tap ", ico("Menu"), ", then ", b("Share"), "."], ...shared], note: IOS_NOTE };
    }
    if (/EdgiOS/.test(ua)) {
      return { head: "In Edge:", steps: [["Tap ", ico("More"), ", then ", b("Share"), "."], ...shared], note: IOS_NOTE };
    }
    if (/OPiOS|OPT\/|GSA\/|DuckDuckGo|Ddg\//.test(ua)) {
      return { head: "In your browser:", steps: [["Open the ", ico("Share"), " menu."], ...shared], note: IOS_NOTE };
    }
    // Safari. Since iOS 26 its compact toolbar keeps Share behind the ⋯
    // button; earlier versions, and its other two tab layouts, show it outright.
    return {
      head: "In Safari:",
      steps: [["Tap ", ico("More"), " next to the address bar, then ", b("Share"), "."], ...shared],
      note: ["No ", ico("More"), " button? Tap ", ico("Share"), " in the toolbar instead."],
    };
  }

  if (/SamsungBrowser/.test(ua)) {
    return {
      head: "In Samsung Internet:",
      steps: [
        ["Tap ", ico("Menu"), " at the bottom right."],
        ["Tap ", b("Add page to"), ", then ", b("Home screen"), "."],
        ["Tap ", b("Add"), "."],
      ],
    };
  }
  if (/EdgA\//.test(ua)) {
    return {
      head: "In Edge:",
      steps: [["Tap ", ico("More"), " at the bottom."], ["Tap ", b("Add to phone"), "."], ["Tap ", b("Install"), "."]],
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      head: "In Firefox:",
      steps: [
        ["Tap ", ico("More options"), " next to the address bar."],
        ["Tap ", b("Install"), " or ", b("Add to Home screen"), "."],
        ["Tap ", b("Add"), "."],
      ],
    };
  }
  // Chrome, and Brave, which sends Chrome's user agent word for word and
  // keeps the same menu.
  if (/Chrome\//.test(ua) && !/OPR\/|YaBrowser|UCBrowser|MiuiBrowser|DuckDuckGo|HuaweiBrowser/.test(ua)) {
    return {
      head: navigator.brave ? "In Brave:" : "In Chrome:",
      steps: [
        ["Tap ", ico("More options"), " next to the address bar."],
        ["Tap ", b("Add to Home screen"), " or ", b("Install app"), "."],
        ["Tap ", b("Install"), "."],
      ],
    };
  }
  return {
    head: "In your browser:",
    steps: [
      ["Open the menu, usually ", ico("More options"), " or ", ico("Menu"), "."],
      ["Tap ", b("Install"), " or ", b("Add to Home screen"), "."],
    ],
    note: ["Not there? Open this page in Chrome and install it from there."],
  };
}

/** @type {HTMLDialogElement | null} */
let dialog = null;
/** @type {HTMLElement} */
let body;
/** @type {Guide} */
let how;
/** The browser's deferred install prompt. It can be asked once, then it is spent. */
let prompt = null;

async function install() {
  const asked = prompt;
  prompt = null;
  paint();
  asked.prompt();
  const { outcome } = await asked.userChoice;
  if (outcome === "accepted") dialog?.close();
}

function copyLink() {
  const button = el("button", { type: "button", class: "pw-cp", text: "Copy link" });
  button.addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(location.href)
      .then(() => (button.textContent = "Copied"))
      .catch(() => {});
  });
  return button;
}

function paint() {
  body.replaceChildren(
    prompt ? el("button", { type: "button", class: "pw-go", text: "Install", onclick: install }) : "",
    el("p", { class: "pw-h", text: prompt ? "Or from the browser menu:" : how.head }),
    el("ol", { class: "pw-s" }, ...how.steps.map((parts) => el("li", null, ...parts))),
    how.note ? el("p", { class: "pw-n" }, ...how.note) : "",
    how.copy ? copyLink() : "",
  );
}

function build() {
  how = guide();
  body = el("div", { class: "pw-b" });
  const chevron = el("span", { class: "pw-ch", "aria-hidden": "true" });
  chevron.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  dialog = el(
    "dialog",
    { class: "pw", "aria-labelledby": "pw-t" },
    el(
      "details",
      null,
      el(
        "summary",
        null,
        el("img", { class: "pw-ic", src: "/apple-touch-icon.png", alt: "", width: 40, height: 40 }),
        el(
          "span",
          { class: "pw-tx" },
          el("b", { id: "pw-t", text: "Install UtopianGO" }),
          el("span", { text: "Add it to your home screen" }),
        ),
        chevron,
      ),
      body,
    ),
  );
  // Before this sheet goes in, so these rules land after the shared ones and
  // win the ties with them.
  dismissible(dialog);
  injectStyles("pw-css", CSS);
  dialog.addEventListener("close", () => {
    settle();
    dialog?.remove();
    dialog = null;
  });
  paint();
  document.body.append(dialog);
  dialog.setAttribute("open", "");
}

// However it got installed — the Install button, or the browser's own menu
// while this was showing — the panel has nothing left to offer.
addEventListener("appinstalled", () => dialog?.close());

window.ugInstall = {
  /** @param {Event | null} deferred */
  open(deferred) {
    prompt = deferred;
    if (!dialog) build();
  },
  /** A prompt that arrived after the panel did. */
  offer(deferred) {
    prompt = deferred;
    if (dialog) paint();
  },
};
