/**
 * The passkey step and the account picker as a lazy bundle: every page
 * fetches this when it finds itself signed in to an account that has no
 * passkey yet, or when someone opens Accounts. Logging in and creating an
 * account are pages (client/auth), not part of it.
 */
import { openAccounts } from "../js/accounts.js";
import { setupPasskey } from "../js/login.js";

window.__login = { setupPasskey, accounts: openAccounts };
