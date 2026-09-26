/**
 * The Log in dialog as a lazy bundle, for the pages that do not carry it:
 * search and the wallet page fetch this the first time someone presses Log in.
 * Social bundles client/js/login.js directly.
 */
import { open } from "../js/login.js";

window.__login = { open };
