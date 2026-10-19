/**
 * The Log in dialog as a lazy bundle: search, the wallet page and Social all
 * fetch this the first time someone presses Log in.
 */
import { open } from "../js/login.js";

window.__login = { open };
