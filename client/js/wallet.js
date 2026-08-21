/**
 * Solana Wallet Standard, by hand.
 *
 * Wallets announce themselves through two window events, and every feature we
 * need — connect, sign-and-send — is a plain function on the wallet object that
 * takes and returns raw bytes. That is the whole reason this app can swap
 * without @solana/web3.js: we never build or parse a transaction, we pass
 * Jupiter's bytes straight through to the wallet.
 *
 * Lives under js/ rather than swap/ because connecting is no longer only the
 * buy dialog's business: the header's Login button and the wallet page both
 * reach a wallet without ever opening a trade.
 */
import { readSession, writeSession } from "./session.js";

const CHAIN = "solana:mainnet";
const CONNECT = "standard:connect";
const DISCONNECT = "standard:disconnect";
const SIGN_AND_SEND = "solana:signAndSendTransaction";
const REGISTER = "wallet-standard:register-wallet";

/** @type {Set<any>} */
const found = new Set();
let listening = false;

/**
 * The registration handshake runs both ways: wallets already present answer our
 * `app-ready` announcement, and wallets that load later fire `register-wallet`
 * at us. Listening for only one of the two misses whole classes of wallet.
 */
function discover() {
  if (!listening) {
    listening = true;
    window.addEventListener(REGISTER, (e) => {
      try {
        e.detail({ register: (...ws) => (ws.forEach((w) => found.add(w)), () => {}) });
      } catch {
        // A wallet that throws during registration is one we skip, not a crash.
      }
    });
  }

  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", {
      detail: { register: (...ws) => (ws.forEach((w) => found.add(w)), () => {}) },
    }),
  );

  return qualified();
}

/**
 * The registered wallets that can actually sign a mainnet Solana trade.
 *
 * Split out of `discover` so a caller can re-read the set without dispatching
 * `app-ready` again — `settled` below reads it on every registration, and
 * re-announcing ourselves each time would be a handshake per wallet for no
 * new information.
 */
function qualified() {
  return [...found].filter(
    (w) =>
      w?.features?.[CONNECT] &&
      w?.features?.[SIGN_AND_SEND] &&
      w?.chains?.includes(CHAIN),
  );
}

/** Wallets able to sign a mainnet Solana transaction, in registration order. */
export function wallets() {
  return discover();
}

/**
 * The same list, but after giving wallets a chance to answer.
 *
 * `wallets()` announces the app and reads the set in the same tick. For a
 * browser extension that is right: it injected itself during page load, long
 * before anyone pressed a button, so it is already in `found` when we look.
 *
 * Inside a wallet's own in-app browser it is wrong. There the provider is
 * injected with the page, and whether it has registered by the time someone
 * taps Buy is a race we do not control. Losing that race used to mean telling
 * a visitor there was no Solana wallet while they stood inside one — and then
 * sending them to jup.ag, where the trade earns us nothing and costs them our
 * referral. A synchronous read is the difference between a trade and a punt.
 *
 * Resolves the instant a qualifying wallet appears, so the ordinary case — a
 * wallet already registered — costs one microtask rather than the timeout.
 * `ms` is a ceiling on waiting, not a delay to sit through.
 *
 * @param {number} ms how long to keep listening before accepting the answer
 * @returns {Promise<any[]>}
 */
export function settled(ms) {
  const now = discover();
  if (now.length) return Promise.resolve(now);

  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener(REGISTER, tick);
      resolve(qualified());
    };
    // Registered after discover()'s own listener, so by the time this runs the
    // wallet that fired the event is already in `found`.
    const tick = () => {
      if (qualified().length) done();
    };
    window.addEventListener(REGISTER, tick);
    timer = setTimeout(done, ms);
  });
}

/**
 * Pick the account to trade from out of a connect result.
 *
 * @param {any} accounts
 * @returns {any}
 */
function pick(accounts) {
  return (accounts ?? []).find((a) => a.features?.includes(SIGN_AND_SEND) ?? true);
}

/**
 * Connect and return the account to trade from.
 *
 * The address is remembered on the way out, so the next visit starts logged in.
 *
 * @param {any} wallet
 * @returns {Promise<any>} a Wallet Standard account
 */
export async function connect(wallet) {
  const { accounts } = await wallet.features[CONNECT].connect();
  const account = pick(accounts);
  if (!account) throw new Error("Wallet returned no account");
  writeSession(account.address, wallet.name);
  return account;
}

/**
 * Re-establish the remembered session without prompting.
 *
 * `silent: true` is the Wallet Standard's way of asking "am I still
 * authorised?" — a wallet that already trusts this origin hands the account
 * straight back, and one that does not returns nothing rather than throwing a
 * dialog in front of someone who only came to read a balance. Wallets differ
 * on which of those two they do, so both an empty result and a rejection are
 * read the same way: not connected, ask properly when it actually matters.
 *
 * @returns {Promise<{wallet: any, account: any} | null>}
 */
export async function restore() {
  const saved = readSession();
  if (!saved) return null;

  const list = wallets();
  // The remembered extension first; failing that, any wallet that turns out to
  // already hold the remembered address — someone who switched browsers'
  // wallet but kept the account should not be made to log in again.
  const ordered = saved.wallet
    ? [...list.filter((w) => w.name === saved.wallet), ...list.filter((w) => w.name !== saved.wallet)]
    : list;

  for (const wallet of ordered) {
    let accounts;
    try {
      ({ accounts } = await wallet.features[CONNECT].connect({ silent: true }));
    } catch {
      continue;
    }
    // Only the remembered address counts. A silent connect can come back with
    // a different account than the one on screen — the user switched accounts
    // in the extension since — and quietly adopting it would show one address
    // in the header and sign with another.
    const account = (accounts ?? []).find((a) => a.address === saved.address);
    if (account) return { wallet, account };
  }
  return null;
}

/**
 * Tell the wallet we are done, if it offers a way to be told.
 *
 * Best-effort by design. `standard:disconnect` clears the wallet's own notion
 * of a live connection; it does not revoke the origin's trust, and no wallet
 * exposes an API that does. So the durable half of logging out is forgetting
 * the address on our side, which clearSession does unconditionally — this is
 * the courtesy call, and a wallet that refuses it changes nothing.
 *
 * @param {any} wallet
 */
export async function disconnect(wallet) {
  try {
    await wallet?.features?.[DISCONNECT]?.disconnect();
  } catch {
    // Already gone, or the wallet does not implement it. Either is fine.
  }
}

/**
 * Sign and broadcast. The wallet uses its own RPC, so this app needs none.
 *
 * @param {any} wallet
 * @param {any} account
 * @param {Uint8Array} transaction
 * @returns {Promise<Uint8Array>} transaction signature
 */
export async function signAndSend(wallet, account, transaction) {
  const results = await wallet.features[SIGN_AND_SEND].signAndSendTransaction({
    account,
    transaction,
    chain: CHAIN,
  });
  const signature = results?.[0]?.signature;
  if (!signature) throw new Error("Wallet returned no signature");
  return signature;
}
