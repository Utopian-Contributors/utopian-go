/**
 * Games: the list of games is static markup, and this is all its script does.
 * It keeps the page offline, and with it every game listed (offline.js),
 * leaves it without a view transition (js/plainswap.js), and shows the
 * header's account buttons for whoever is signed in: Wallet and Accounts, or
 * Log in, to the login page and back here.
 */
import { keepOffline } from "./offline.js";
import { plainSwap } from "../js/plainswap.js";
import { noStickyHover } from "../js/hover.js";
import { loginPath, openAccounts } from "../js/acct.js";
import { busy } from "../js/busy.js";
import { onName, readName } from "../js/me.js";

plainSwap();
noStickyHover();

keepOffline();

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

function paintAccount() {
  const signed = !!readName();
  $("aw").hidden = $("out").hidden = !signed;
  const login = /** @type {HTMLAnchorElement} */ ($("in"));
  login.hidden = signed;
  login.href = loginPath();
}

onName(paintAccount);
window.addEventListener("pageshow", (e) => e.persisted && paintAccount());
paintAccount();

// Back on Games as whoever the picker leaves signed in, or nobody.
$("out").addEventListener("click", (e) =>
  busy(/** @type {HTMLElement} */ (e.currentTarget), () => openAccounts({ onLoggedOut: () => location.reload() })),
);
