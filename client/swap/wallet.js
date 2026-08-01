/**
 * Solana Wallet Standard, by hand.
 *
 * Wallets announce themselves through two window events, and every feature we
 * need — connect, sign-and-send — is a plain function on the wallet object that
 * takes and returns raw bytes. That is the whole reason this app can swap
 * without @solana/web3.js: we never build or parse a transaction, we pass
 * Jupiter's bytes straight through to the wallet.
 */

const CHAIN = "solana:mainnet";
const CONNECT = "standard:connect";
const SIGN_AND_SEND = "solana:signAndSendTransaction";

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
    window.addEventListener("wallet-standard:register-wallet", (e) => {
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
 * Connect and return the account to trade from.
 *
 * @param {any} wallet
 * @returns {Promise<any>} a Wallet Standard account
 */
export async function connect(wallet) {
  const { accounts } = await wallet.features[CONNECT].connect();
  const account = (accounts ?? []).find((a) =>
    a.features?.includes(SIGN_AND_SEND) ?? true,
  );
  if (!account) throw new Error("Wallet returned no account");
  return account;
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
