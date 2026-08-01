#!/usr/bin/env node
/**
 * Audit — and optionally create — Jupiter referral token accounts for every
 * mint in the token index.
 *
 * READ THIS BEFORE RUNNING WITH --create
 * -------------------------------------
 * You almost certainly do not need these. Jupiter takes the platform fee on
 * whichever side of the swap matches the `feeAccount` you hand it, and every
 * swap this app builds has SOL or USDC on one side. Verified by simulation: a
 * 1 SOL buy of BONK credits exactly 2,000,000 lamports (20 bps) to the *SOL*
 * referral account, even though the quote reports `platformFee` denominated in
 * BONK. One SOL account already collects on the entire index.
 *
 * Creating an account per mint costs rent — run the audit first and read the
 * total it prints. The reason to do it anyway is if you later let people fund
 * a swap with something other than SOL or USDC, where the fee would land in a
 * mint you hold no account for.
 *
 * Usage:
 *   node scripts/referral-accounts.mjs                  # audit, no writes
 *   node scripts/referral-accounts.mjs --create --keypair ~/.config/solana/id.json
 *   node scripts/referral-accounts.mjs --mints SOL,USDC # limit to some symbols
 *
 * The audit is dependency-free. --create lazily imports @jup-ag/referral-sdk
 * and @solana/web3.js, which are not project dependencies — install them with
 * `npm i -D @jup-ag/referral-sdk @solana/web3.js` if you decide to go ahead.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REFERRAL_PROGRAM = "REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3";
/** Rent-exempt minimum for a 165-byte SPL token account, in lamports. */
const TOKEN_ACCOUNT_RENT = 2_039_280;
/** getMultipleAccounts caps out at 100 addresses per call. */
const BATCH = 100;

// —— env ——

function env() {
  const out = {};
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    if (!line.includes("=") || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// —— base58 ——

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decode58(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58: ${str}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function encode58(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// —— PDA derivation ——
// A program address is the first bump whose sha256 does not land on the
// ed25519 curve, so this needs point decompression. Thirty lines of BigInt
// beats pulling in a crypto library for a script that runs once.

const P = (1n << 255n) - 19n;
const D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}

function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * mod(v * v));
  const v7 = mod(v3 * mod(v3 * v));
  const x = mod(mod(u * v3) * pow(mod(u * v7), (P - 5n) / 8n));
  const check = mod(v * mod(x * x));
  return check === u || check === mod(-u);
}

const MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const ATA_SEED = Buffer.from("referral_ata", "utf8");

function referralTokenAccount(referral, mint) {
  const pid = decode58(REFERRAL_PROGRAM);
  const ref = decode58(referral);
  const m = decode58(mint);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    h.update(ATA_SEED);
    h.update(ref);
    h.update(m);
    h.update(Buffer.from([bump]));
    h.update(pid);
    h.update(MARKER);
    const candidate = h.digest();
    if (!onCurve(candidate)) return encode58(candidate);
  }
  throw new Error(`no PDA for ${mint}`);
}

// —— chain ——

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// —— main ——

const cfg = env();
const referral = cfg.JUP_REFERAL_ACCOUNT || cfg.JUP_REFERRAL_ACCOUNT;
const rpcUrl = cfg.HELIUS_RPC_URL;
if (!referral) throw new Error("JUP_REFERAL_ACCOUNT missing from .env");
if (!rpcUrl) throw new Error("HELIUS_RPC_URL missing from .env");

const snapshot = JSON.parse(
  readFileSync(path.join(root, ".cache", "tokens.json"), "utf8"),
);
let tokens = snapshot.records ?? [];

const only = opt("--mints");
if (only) {
  const wanted = new Set(only.split(",").map((s) => s.trim().toUpperCase()));
  tokens = tokens.filter((t) => wanted.has(t.symbol.toUpperCase()));
}

console.log(`referral account : ${referral}`);
console.log(`mints in index   : ${tokens.length}\n`);

console.log("Deriving PDAs…");
const rows = tokens.map((t) => ({
  symbol: t.symbol,
  mint: t.mint,
  pda: referralTokenAccount(referral, t.mint),
}));

console.log("Checking which already exist on chain…");
const existing = new Set();
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  const res = await rpc(rpcUrl, "getMultipleAccounts", [
    slice.map((r) => r.pda),
    { encoding: "base64" },
  ]);
  res.value.forEach((acct, j) => acct && existing.add(slice[j].pda));
  process.stdout.write(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
}

const missing = rows.filter((r) => !existing.has(r.pda));
const rentSol = (missing.length * TOKEN_ACCOUNT_RENT) / 1e9;

console.log(`\n\nexisting : ${rows.length - missing.length}`);
console.log(`missing  : ${missing.length}`);
console.log(`rent to create all missing: ${rentSol.toFixed(4)} SOL (plus tx fees)\n`);

for (const r of rows.filter((x) => existing.has(x.pda))) {
  console.log(`  ✓ ${r.symbol.padEnd(12)} ${r.pda}`);
}

if (!flag("--create")) {
  console.log(
    `\nAudit only — nothing was written. Re-run with --create --keypair <path>` +
      `\nto create the ${missing.length} missing account(s). Read the header of` +
      `\nthis file first: for SOL- and USDC-funded swaps you do not need them.\n`,
  );
  process.exit(0);
}

// —— creation ——

const keypairPath = opt("--keypair");
if (!keypairPath) throw new Error("--create requires --keypair <path to id.json>");

let ReferralProvider, web3;
try {
  ({ ReferralProvider } = await import("@jup-ag/referral-sdk"));
  web3 = await import("@solana/web3.js");
} catch {
  console.error(
    "\n--create needs the Jupiter SDK, which is not a project dependency:\n" +
      "  npm i -D @jup-ag/referral-sdk @solana/web3.js\n",
  );
  process.exit(1);
}

const { Connection, Keypair, PublicKey, sendAndConfirmTransaction } = web3;
const connection = new Connection(rpcUrl, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(keypairPath.replace(/^~/, process.env.HOME), "utf8"))),
);
const provider = new ReferralProvider(connection);

console.log(`\npayer: ${payer.publicKey.toBase58()}`);
const balance = await connection.getBalance(payer.publicKey);
console.log(`balance: ${(balance / 1e9).toFixed(4)} SOL`);
if (balance < missing.length * TOKEN_ACCOUNT_RENT) {
  console.error("Not enough SOL to cover rent for every missing account.");
  process.exit(1);
}

let created = 0;
let failed = 0;
for (const [i, r] of missing.entries()) {
  try {
    const { tx } = await provider.initializeReferralTokenAccount({
      payerPubKey: payer.publicKey,
      referralAccountPubKey: new PublicKey(referral),
      mint: new PublicKey(r.mint),
    });
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    created += 1;
    console.log(`  [${i + 1}/${missing.length}] ${r.symbol} → ${sig}`);
  } catch (err) {
    failed += 1;
    console.warn(`  [${i + 1}/${missing.length}] ${r.symbol} failed: ${err.message}`);
  }
}

console.log(`\ncreated ${created}, failed ${failed}`);
