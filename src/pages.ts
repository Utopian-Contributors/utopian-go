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

export type Page = "index" | "wallet" | "social";

/** Text and attribute values, escaped. */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SOCIAL = '<a class="ac-soc" href="/social" aria-label="Get Social"><span class="ac-soc-t">Get Social</span></a>';
const LOG_IN = '<a class="ac-w ac-in" href="/wallet">Log in</a>';

/** The header's #ac, as mountAccount paints it (index, wallet) or applyMe leaves it (social). */
export function accountNav(page: Page, signed: boolean): string {
  let inner: string;
  if (page === "social") {
    const hide = (hidden: boolean) => (hidden ? " hidden" : "");
    inner =
      `<a class="ac-w" href="/wallet" id="aw"${hide(!signed)}>Wallet</a> ` +
      `<a class="ac-w ac-in" href="/wallet" id="in"${hide(signed)}>Log in</a> ` +
      `<button type="button" class="ac-out" id="out"${hide(!signed)}>Log out</button>`;
  } else if (!signed) inner = page === "index" ? LOG_IN : LOG_IN + SOCIAL;
  else if (page === "wallet") inner = `${SOCIAL}<button type="button" class="ac-out">Log out</button>`;
  else inner = `<a class="ac-w" href="/wallet">Wallet</a>${SOCIAL}`;
  return `<nav id="ac" aria-label="Account">${inner}</nav>`;
}

/**
 * What else a page leaves out for someone signed out: the wallet's account
 * line and its Receive, Send and Swap, which only a Social account has
 * (client/wallet/main.js paintKeys, paintActions). Shipped hidden, so the
 * script hiding them moves nothing.
 */
const SIGNED_OUT: Partial<Record<Page, string[]>> = {
  wallet: ['<div class="wl-ph wl-sk" id="wl-ph" aria-hidden="true">', '<div class="wl-acts" id="wl-acts">'],
};

/** A built page as someone signed in, or signed out, first sees it. Throws if the build moved what it renders into. */
export function renderPage(page: Page, html: string, signed: boolean): string {
  if (!ACCOUNT_NAV.test(html)) throw new Error("no #ac to render into");
  let out = html.replace(ACCOUNT_NAV, () => accountNav(page, signed));
  for (const tag of SIGNED_OUT[page] ?? []) {
    if (!out.includes(tag)) throw new Error(`no ${tag}`);
    if (!signed) out = out.replace(tag, () => tag.replace(/>$/, " hidden>"));
  }
  return out;
}

/** The empty or default #ac a built page ships, whatever its contents. */
export const ACCOUNT_NAV = /<nav id="ac" aria-label="Account">[\s\S]*?<\/nav>/;

/** A profile's card: picture, name, place, bio, and its row of action tiles. */
export function profileCard(user: Pick<User, "name" | "address" | "bio" | "loc" | "avatarRev">, own: boolean, friend: boolean): string {
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
  return (
    (user.avatarRev ? `<img class="pfp" src="/social/a/${name}?v=${user.avatarRev}" alt="" width="200" height="200">` : "") +
    `<div class="name"><h2>${name}</h2>${user.loc ? `<span class="muted">[${esc(user.loc)}]</span>` : ""}</div>` +
    (user.bio ? `<p class="ld">${esc(user.bio)}</p>` : "") +
    `<div class="pacts">${pay}${add}${last}</div>`
  );
}
