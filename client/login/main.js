/**
 * The Log in dialog as a lazy bundle: search, the wallet page and Social all
 * fetch this the first time someone presses Log in, or signs in to an account
 * that has no passkey yet.
 */
import { open, setupPasskey } from "../js/login.js";

window.__login = { open, setupPasskey };
