/**
 * The parts of a page that depend on who is asking, rendered into the
 * document so they paint with it instead of after the script.
 *
 * The session cookie is readable here (readSession, no database), so the
 * header's account buttons come out right on the first paint: Wallet or Log
 * in, and Log out. Each is the exact markup the page's script draws
 * (client/js/acct.js mountAccount, social's applyMe), so taking over moves
 * nothing. A profile's card comes out with its actions the same way, from the
 * row its script would fetch (client/social/main.js renderSide).
 */
import type { User } from "./social/db";
import { badgeSrc } from "./social/shop";

export type Page = "index" | "wallet" | "social";

/** Text and attribute values, escaped. */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SOCIAL = '<a class="ac-soc" href="/social" aria-label="Get Social"><span class="ac-soc-t">Get Social</span></a>';
const LOG_IN = '<a class="ac-w ac-in" href="/login">Log in</a>';

/** The header's #ac, as mountAccount paints it (index, wallet) or applyMe leaves it (social). */
export function accountNav(page: Page, signed: boolean): string {
  let inner: string;
  if (page === "social") {
    const hide = (hidden: boolean) => (hidden ? " hidden" : "");
    inner =
      `<a class="ac-w" href="/wallet" id="aw"${hide(!signed)}>Wallet</a> ` +
      `<a class="ac-w ac-in" href="/login" id="in"${hide(signed)}>Log in</a> ` +
      `<button type="button" class="ac-sw" id="out"${hide(!signed)}>Accounts</button>`;
  } else if (!signed) inner = page === "index" ? LOG_IN : LOG_IN + SOCIAL;
  else if (page === "wallet") inner = `${SOCIAL}<button type="button" class="ac-sw">Accounts</button>`;
  else inner = `<a class="ac-w" href="/wallet">Wallet</a>${SOCIAL}`;
  return `<nav id="ac" aria-label="Account">${inner}</nav>`;
}

/**
 * What else a page leaves out for someone signed out: the wallet's account
 * line and its whole portfolio, which only a Social account has
 * (client/wallet/main.js paintKeys, refresh). Shipped hidden, so the script
 * hiding them moves nothing.
 */
const SIGNED_OUT: Partial<Record<Page, string[]>> = {
  wallet: ['<div class="wl-ph wl-sk" id="wl-ph" aria-hidden="true">', '<section class="wl-pf" id="wl-pf" aria-label="Portfolio">'],
};

/**
 * And what it shows them instead, shipped hidden for everyone else: the
 * wallet's sign-in prompt, in the portfolio's place.
 */
const SIGNED_OUT_ONLY: Partial<Record<Page, string[]>> = {
  wallet: ['<section class="wl-in" id="wl-in" aria-labelledby="wl-in-h" hidden>'],
};

/** A built page as someone signed in, or signed out, first sees it. Throws if the build moved what it renders into. */
export function renderPage(page: Page, html: string, signed: boolean): string {
  if (!ACCOUNT_NAV.test(html)) throw new Error("no #ac to render into");
  let out = html.replace(ACCOUNT_NAV, () => accountNav(page, signed));
  for (const tag of SIGNED_OUT[page] ?? []) {
    if (!out.includes(tag)) throw new Error(`no ${tag}`);
    if (!signed) out = out.replace(tag, () => tag.replace(/>$/, " hidden>"));
  }
  for (const tag of SIGNED_OUT_ONLY[page] ?? []) {
    if (!out.includes(tag)) throw new Error(`no ${tag}`);
    if (!signed) out = out.replace(tag, () => tag.replace(/ hidden>$/, ">"));
  }
  return out;
}

/** The empty or default #ac a built page ships, whatever its contents. */
export const ACCOUNT_NAV = /<nav id="ac" aria-label="Account">[\s\S]*?<\/nav>/;

/**
 * Where the login page goes on to, from its ?next=: a page on this site
 * other than the login page itself, or home. Printable ASCII after a single
 * slash, so never `//host` or `/\host`, which a browser takes for another
 * site. client/auth/main.js onwardPath goes by the same rule.
 */
export function nextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512 || !/^\/(?!\/)[!-[\]-~]*$/.test(raw)) return "/";
  return /^\/(login|register)(?:[/?#]|$)/.test(raw) ? "/" : raw;
}

/**
 * /login or /register, going on to `to` once someone is in. client/js/acct.js
 * authPath writes the same. `add` is Add Account in the account picker: the
 * page shown to someone already signed in, who would otherwise go straight on.
 */
export function authPath(page: "/login" | "/register", to: string, add = false): string {
  const q: string[] = [];
  if (to !== "/") q.push(`next=${encodeURIComponent(to).replace(/%2F/gi, "/")}`);
  if (add) q.push("add=1");
  return q.length ? `${page}?${q.join("&")}` : page;
}

/** The home page's Wallet, Social and Games rows (client/index.html). */
export const HOME_NAV = /<nav id="hm-nv"[^>]*>[\s\S]*?<\/nav>/;

/**
 * The home page's rows as someone signed in, or signed out, first sees them:
 * signed out, Social goes by the login page and on to its own from there.
 * The wallet and Games are anyone's, so they go straight there.
 */
export function homeNav(html: string, signed: boolean): string {
  if (signed) return html;
  return html.replace(HOME_NAV, (nav) => nav.replace(/ href="(\/social)"/g, (_m, to: string) => ` href="${authPath("/login", to)}"`));
}

/** The page a ?next= goes on to, as the login page names it; nothing, for anywhere else. */
function destination(to: string): string {
  const page = to.match(/^\/(wallet|social)(?:[/?#]|$)/)?.[1];
  return page === "wallet" ? "Wallet" : page === "social" ? "Social" : "";
}

/**
 * The login page (client/auth.html) as /login or /register first paints it:
 * in that mode and titled for it, naming where it goes on to, and with Log
 * in and Create account linking to each other with the same ?next=. Throws
 * if the build moved anything it renders into.
 */
export function renderAuth(html: string, mode: "login" | "register", to: string, add = false): string {
  const where = destination(to);
  // The section it goes on to, so the page wears that section's colour (client/base.css, :root[data-sec]).
  const sec = where.toLowerCase();
  const swaps: [string, string][] = [
    ['<html lang="en">', sec ? `<html lang="en" data-sec="${sec}">` : '<html lang="en">'],
    ['<body class="au" data-m="login">', `<body class="au" data-m="${mode}">`],
    ["<title>Log in</title>", `<title>${mode === "register" ? "Create account" : "Log in"}</title>`],
    ['<p class="au-to" id="au-to"></p>', `<p class="au-to" id="au-to">${where && `to continue to ${where}`}</p>`],
    ['href="/register" id="au-tr"', `href="${esc(authPath("/register", to, add))}" id="au-tr"`],
    ['href="/login" id="au-tl"', `href="${esc(authPath("/login", to, add))}" id="au-tl"`],
  ];
  let out = html;
  for (const [from, into] of swaps) {
    if (!out.includes(from)) throw new Error(`no ${from}`);
    out = out.replace(from, () => into);
  }
  return out;
}

/** A profile's card: picture, name, place, bio, and its row of action tiles. */
export function profileCard(
  user: Pick<User, "name" | "address" | "bio" | "loc" | "avatarRev" | "badge">,
  own: boolean,
  friend: boolean,
): string {
  const name = esc(user.name);
  const pay = !user.address
    ? ""
    : own
      ? '<button type="button" class="pa" data-ic="swap">Swap</button>'
      : '<button type="button" class="pa pay">Pay</button>';
  const add = own
    ? ""
    : friend
      ? '<button type="button" class="pa" data-ic="add" disabled>Friends</button>'
      : '<button type="button" class="pa" data-ic="add">Add</button>';
  const last = own
    ? '<a class="pa" data-ic="edit" href="/social/edit">Edit profile</a>'
    : `<a class="pa" data-ic="msg" href="/social/c/${name}">Message</a>`;
  // The badge after the name. The status on the picture's foot is renderSide's: it lies over the
  // picture, so it moves nothing when it comes, and its rules ride in social.js.
  const pic = user.avatarRev ? `<img class="pfp" src="/social/a/${name}?v=${user.avatarRev}" alt="" width="200" height="200">` : "";
  // img.wear's rules are social.js's (social.html is at its guardrail): until it runs, the same size inline.
  const badge = user.badge
    ? `<img class="wear" src="${esc(badgeSrc(user.name, user.badge))}" alt="" width="16" height="16" style="width:1em;height:1em;margin-left:.25em;vertical-align:-.12em">`
    : "";
  return (
    (pic ? `<div class="pfw">${pic}</div>` : "") +
    `<div class="name"><h2>${name}${badge}</h2>${user.loc ? `<span class="muted">[${esc(user.loc)}]</span>` : ""}</div>` +
    (user.bio ? `<p class="ld">${esc(user.bio)}</p>` : "") +
    `<div class="pacts">${pay}${add}${last}</div>`
  );
}

/**
 * A Social page's frame as client/social/main.js show() leaves it, so the
 * first paint is already laid out the way the page will stay: the body's
 * classes (the grid each page sits on) and, for a page with no card beside
 * it, the side column gone and #mn one column (useSide(false)). Without this,
 * the script set them only once it ran, and the columns moved under the page.
 * Mirrors route() there; a path it does not know keeps the plain frame.
 */
export function socialFrame(path: string): { cls: string; side: boolean } {
  const p = path.replace(/\/+$/, "") || "/social";
  if (/^\/social\/ads(?:\/|$)/.test(p)) return { cls: "ads", side: false };
  if (p === "/social" || p === "/social/saved") return { cls: "tl", side: true };
  if (/^\/social\/p\/[A-Za-z0-9_-]{1,32}$/.test(p)) return { cls: "tl detail", side: true };
  if (/^\/social\/u\/[a-z0-9_]{3,16}$/.test(p)) return { cls: "profile", side: true };
  if (p === "/social/c" || /^\/social\/c\/[a-z0-9_]{3,16}$/.test(p)) return { cls: "chat", side: true };
  if (p === "/social/new") return { cls: "newpost", side: false };
  if (p === "/social/friends" || p === "/social/notifications" || p === "/social/edit" || p === "/social/shop") return { cls: "", side: false };
  return { cls: "", side: true };
}

/** `html` (social.html) in the frame socialFrame gives `path`. Throws if the build moved what it rewrites. */
export function frameSocial(html: string, path: string): string {
  const { cls, side } = socialFrame(path);
  const swaps: [string, string][] = [];
  if (cls) swaps.push(['<body class="res soc"', `<body class="res soc ${cls}"`]);
  if (!side) swaps.push(['<div id="mn">', '<div id="mn" class="solo">'], ['<aside id="sd">', '<aside id="sd" hidden>']);
  let out = html;
  for (const [from, into] of swaps) {
    if (!out.includes(from)) throw new Error(`no ${from}`);
    out = out.replace(from, () => into);
  }
  return out;
}
