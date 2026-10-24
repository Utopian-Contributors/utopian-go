import assert from "node:assert/strict";
import { createCipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, verify, webcrypto } from "crypto";
import express from "express";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import path from "path";
import { Client } from "pg";
import test, { after } from "node:test";
import { checkPassword, newPassword, openPhrase, pepperHash, sealPhrase, stale, wrapPhraseCt } from "./auth";
import { TERMS_VERSION, UTCC_MINT } from "../config";
import { audioKind } from "./audio";
import { jpegSize } from "./jpeg";
import {
  base58,
  base58Decode,
  ed25519Public,
  mnemonicFromEntropy,
  mnemonicToSeed,
  normalizeMnemonic,
  slip10ed25519,
  solanaAddress,
  solanaSeed,
} from "./keys";
import { checkSwapInstructions, parseMessage, reviewedFloor, signTransaction, simulationError, slippageFor } from "./swap";
import { ATA_PROGRAM, SOL_MINT, SYSTEM, TOKEN, associatedTokenAccount, compileMessage, onCurve } from "./send";
import { scrub } from "./guard";
import { AUDIO_BYTES, MAX_AUDIO_MS, SOCIAL_BYTES, TINY_BYTES, adKeyword, adText, adUrl, postWait, username, waitText } from "./limits";
import { sendAvatar, sendPostAudio, sendPostPhoto, socialRouter } from "./routes";
import { type AdCreative, type AdOrder, TIMELINE_PAGE, closePool, createPost, databaseUrl, ensureSchema, getAd, getUser, payOrder, postPayment, resetSocial, saveAd } from "./db";
import { MAX_CALLOUTS, calloutsIn, isTicker, resolveTickers } from "./callouts";
import { apiRouter } from "../routes/api";
import { adFor, adMarkup, flushAds, reloadAds } from "./ads";
import { USDC_MINT, decimal, dollars, matchTransfer, orderAmounts, orderCodes, payUrl, transfersIn, type ParsedTx } from "./adPay";
import { drawAvatar } from "./avatar";
import { backdrop, palette } from "./backdrop";
import { tokenKind } from "../lib/tokens/jupiter";
import { buildLists, isStable, pageOf } from "../lib/tokens/store";
import { type RawTx, readTx } from "../lib/history";
import { averageEntries, follows } from "../lib/entries";
import { encodeTicks } from "../lib/tokens/ticks";
import { stateTags } from "../state";
import type { Activity, PriceSeries, TokenKind, TokenQuote, TokenRecord } from "../types";
import { WORDLIST } from "./wordlist";

const dir = mkdtempSync(path.join(tmpdir(), "social-"));
process.env.SOCIAL_DIR = dir;
after(async () => {
  await closePool();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Accounts, posts, and saves are truncated between runs. That has to happen
 * in a database of its own, or `npm test` would empty the one the app uses.
 */
async function useTestDatabase(): Promise<void> {
  const current = databaseUrl();
  const url = new URL(current);
  const baseName = url.pathname.replace(/^\//, "").replace(/_test$/, "");
  const name = `${baseName}_test`;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`refusing test database name ${name}`);
  const admin = new URL(current);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("recovery phrase is BIP39 and the Solana account Phantom imports", () => {
  assert.equal(mnemonicFromEntropy(Buffer.alloc(16)), ABANDON);
  assert.equal(
    mnemonicToSeed(ABANDON).toString("hex"),
    "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
  );

  // SLIP-0010 ed25519 test vector 1.
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const master = slip10ed25519(seed, []);
  assert.equal(master.toString("hex"), "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
  assert.equal(
    ed25519Public(master).toString("hex"),
    "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
  );
  const child = slip10ed25519(seed, [0x80000000]);
  assert.equal(child.toString("hex"), "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");

  // m/44'/501'/0'/0' for that phrase, checked against ed25519-hd-key and web3.js.
  assert.equal(solanaAddress(ABANDON), "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  assert.equal(base58(Buffer.from([0, 0, 1])), "112");
});

test("phrase opens only with the password that sealed it", async () => {
  const box = await sealPhrase("abandon about", "correct horse");
  assert.equal(await openPhrase(box, "correct horse"), "abandon about");
  await assert.rejects(() => openPhrase(box, "nope"));
  const pass = await newPassword("correct horse");
  assert.equal(await checkPassword("correct horse", pass.salt, pass.hash), true);
  assert.equal(await checkPassword("nope", pass.salt, pass.hash), false);
  assert.equal(stale(pass.salt), false);
});

test("a hash from before the cost went up still verifies, and reads as stale", async () => {
  // N=2^14 with a bare salt: what every account created before versioning holds.
  const { scryptSync } = await import("crypto");
  const salt = Buffer.alloc(16, 7).toString("base64url");
  const hash = scryptSync("correct horse", Buffer.from(salt, "base64url"), 32, { N: 2 ** 14, r: 8, p: 1 });
  assert.equal(await checkPassword("correct horse", salt, hash.toString("base64url")), true);
  assert.equal(stale(salt), true);
});

test("a password hash is kept under the pepper, and one from before it still checks", async () => {
  const pass = await newPassword("correct horse");
  assert.match(pass.hash, /^peppered\./, "sealed, so a copy of the database has nothing to guess against");
  assert.equal(await checkPassword("correct horse", pass.salt, pass.hash), true);
  assert.equal(await checkPassword("nope", pass.salt, pass.hash), false);
  // As every hash was before the pepper: the scrypt output, bare.
  const salt = `2.${Buffer.alloc(16, 9).toString("base64url")}`;
  const bare = scryptSync("correct horse", Buffer.alloc(16, 9), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url");
  assert.equal(await checkPassword("correct horse", salt, bare), true);
  const sealed = pepperHash(bare);
  assert.match(sealed, /^peppered\./);
  assert.notEqual(sealed.includes(bare), true, "the hash is not in what is stored");
  assert.equal(pepperHash(sealed), sealed, "sealed once, however often asked");
  assert.equal(await checkPassword("correct horse", salt, sealed), true);
  assert.equal(await checkPassword("nope", salt, sealed), false);
  // A stored hash the pepper does not open is a key gone wrong, said out loud, not a wrong password.
  const [iv, tag, ct] = sealed.slice("peppered.".length).split(".");
  const tampered = `peppered.${iv}.${tag}.${ct[0] === "A" ? "B" : "A"}${ct.slice(1)}`;
  await assert.rejects(checkPassword("correct horse", salt, tampered));
});

test("the password box is sealed again under WALLET_KEY, and one sealed before that still opens", async () => {
  const box = await sealPhrase(ABANDON, "password1");
  assert.match(box.ct, /^wrapped\./);
  assert.equal(await openPhrase(box, "password1"), ABANDON);
  await assert.rejects(openPhrase(box, "password2"));
  // Under the password alone, as rows from before were written.
  const salt = randomBytes(16);
  const key = scryptSync("password1", salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(ABANDON, "utf8"), cipher.final()]);
  const old = { salt: `2.${salt.toString("base64url")}`, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url") };
  assert.equal(await openPhrase(old, "password1"), ABANDON);
  const sealed = { ...old, ct: wrapPhraseCt(old.ct) };
  assert.match(sealed.ct, /^wrapped\./);
  assert.equal(wrapPhraseCt(sealed.ct), sealed.ct, "sealed once, however often asked");
  assert.equal(await openPhrase(sealed, "password1"), ABANDON);
});

test("a typed phrase is forgiven its case and spacing, not a wrong word", () => {
  assert.equal(normalizeMnemonic(`  ${ABANDON.toUpperCase().replace(/ /g, "\n ")} `), ABANDON);
  assert.equal(normalizeMnemonic(ABANDON.replace(/about$/, "abandon")), null, "checksum");
  assert.equal(normalizeMnemonic(ABANDON.replace(/about$/, "abouts")), null, "not a word");
  assert.equal(normalizeMnemonic(ABANDON + " about"), null, "13 words");
  assert.equal(normalizeMnemonic(42), null);
});

test("a portrait jpeg is measured and a wide one is wide", () => {
  const portrait = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x14, 0x00, 0x0a, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  assert.deepEqual(jpegSize(portrait), { w: 10, h: 20 });
  const wide = Buffer.from(portrait);
  wide[7] = 0x00;
  wide[8] = 0x0a;
  wide[9] = 0x00;
  wide[10] = 0x14;
  assert.deepEqual(jpegSize(wide), { w: 20, h: 10 });
  assert.equal(jpegSize(Buffer.from("nope")), null);
});

test("a solana address round-trips and its key signs for it", () => {
  const address = solanaAddress(ABANDON);
  const pub = base58Decode(address);
  assert.ok(pub);
  assert.equal(pub.length, 32);
  assert.equal(base58(pub), address);
  const message = Buffer.from("a message for the wallet to sign");
  const seed = slip10ed25519(mnemonicToSeed(ABANDON), [44, 501, 0, 0].map((i) => i + 0x80000000));
  // The wallet's signature over a message verifies against the address.
  const pkcs8 = Buffer.from("302e020100300506032b657004220420", "hex");
  const priv = createPrivateKey({ key: Buffer.concat([pkcs8, seed]), format: "der", type: "pkcs8" });
  const sig = sign(null, message, priv);
  assert.equal(verify(null, message, createPublicKey(priv), sig), true);
  assert.equal(ed25519Public(seed).equals(pub), true);
  seed.fill(0);
});

test("a response cannot carry a password hash, a sealed phrase, or a passkey key", () => {
  const clean = scrub(
    {
      name: "ada",
      passHash: "h",
      phraseCt: "c",
      passkey: { id: "i", challenge: "ch", cose: "secret", count: 3 },
      nested: { phraseSalt: "s", passkey: true },
    },
    false,
  );
  assert.deepEqual(clean, {
    name: "ada",
    passkey: { id: "i", challenge: "ch" },
    nested: { passkey: true },
  });
  assert.deepEqual(scrub({ phrase: "abandon about" }, false), {});
  assert.deepEqual(scrub({ phrase: "abandon about" }, true), { phrase: "abandon about" });
});

test("the server signs only a transaction whose one signer is the account", () => {
  const seed = solanaSeed(ABANDON);
  const owner = ed25519Public(seed);
  const other = Buffer.alloc(32, 9);
  const message = (payer: Buffer, signers = 1) =>
    Buffer.concat([Buffer.from([0x80, signers, 0, 1, 2]), payer, other, Buffer.alloc(40)]);
  const tx = (m: Buffer, sigs = 1) => Buffer.concat([Buffer.from([sigs]), Buffer.alloc(64 * sigs), m]);
  const m = message(owner);
  const signed = signTransaction(tx(m), owner, seed);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), owner]),
    format: "der",
    type: "spki",
  });
  assert.equal(verify(null, m, publicKey, signed.subarray(1, 65)), true);
  assert.throws(() => signTransaction(tx(message(other)), owner, seed));
  assert.throws(() => signTransaction(tx(message(owner, 2), 2), owner, seed));
  seed.fill(0);
});

test("a token account address is the one the associated token program derives", () => {
  // The largest $UTCC holder on mainnet (itself a program address), and the account holding that balance.
  const owner = base58Decode("ED8PSBD3NvEHiBgaTxkL1QXTjGVDxTYZx2uzdKGdKngq")!;
  const mint = base58Decode("HGTXnhgyast5fJKhMcE4VgyeEVWhYKEsHxpZtpjhrYqA")!;
  const token = base58Decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")!;
  const account = associatedTokenAccount(owner, mint, token);
  assert.equal(base58(account), "AZtgHrsQtx49euvbeuz2THkqmDWa7pCu395Dn2w3P8ug");
  assert.equal(onCurve(account), false);
  const seed = solanaSeed(ABANDON);
  assert.equal(onCurve(ed25519Public(seed)), true);
  seed.fill(0);
});

test("a swap is signed only when every instruction is one a swap needs", () => {
  const owner = Buffer.alloc(32, 1);
  const other = Buffer.alloc(32, 2);
  const jupiter = base58Decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")!;
  const budget = base58Decode("ComputeBudget111111111111111111111111111111")!;
  const wsol = base58Decode(SOL_MINT)!;
  const wsolAta = associatedTokenAccount(owner, wsol, TOKEN);
  const u32 = (tag: number, n: number) => {
    const b = Buffer.alloc(5);
    b[0] = tag;
    b.writeUInt32LE(n, 1);
    return b;
  };
  const u64 = (tag: number, n: bigint, width = 9) => {
    const b = Buffer.alloc(width);
    b.writeUInt32LE(tag, 0);
    b.writeBigUInt64LE(n, width - 8);
    return b;
  };
  const price = (microLamports: bigint) => {
    const b = Buffer.alloc(9);
    b[0] = 3;
    b.writeBigUInt64LE(microLamports, 1);
    return b;
  };
  const meta = (key: Buffer, signer = false, writable = true) => ({ key, signer, writable });
  const jupiterSwap = [
    { program: budget, keys: [], data: u32(2, 300_000) },
    { program: budget, keys: [], data: price(10_000n) },
    {
      program: ATA_PROGRAM,
      keys: [meta(owner, true), meta(wsolAta), meta(owner, false, false), meta(wsol, false, false), meta(SYSTEM, false, false), meta(TOKEN, false, false)],
      data: Buffer.from([1]),
    },
    { program: SYSTEM, keys: [meta(owner, true), meta(wsolAta)], data: u64(2, 1_000_000n, 12) },
    { program: TOKEN, keys: [meta(wsolAta)], data: Buffer.from([17]) },
    { program: jupiter, keys: [meta(owner, true), meta(wsolAta), meta(other)], data: Buffer.from([1, 2, 3]) },
    { program: TOKEN, keys: [meta(wsolAta), meta(owner), meta(owner, true)], data: Buffer.from([9]) },
  ];
  const check = (ixs: typeof jupiterSwap) =>
    checkSwapInstructions(parseMessage(compileMessage(owner, ixs, Buffer.alloc(32, 9))), owner);
  check(jupiterSwap);

  const refused = [
    // SOL straight out to someone else.
    { program: SYSTEM, keys: [meta(owner, true), meta(other)], data: u64(2, 1_000_000n, 12) },
    // Tokens straight out: Transfer, then Approve a delegate, then a new owner.
    { program: TOKEN, keys: [meta(wsolAta), meta(other), meta(owner, true)], data: u64(3, 5n) },
    { program: TOKEN, keys: [meta(wsolAta), meta(other), meta(owner, true)], data: u64(4, 5n) },
    { program: TOKEN, keys: [meta(wsolAta), meta(owner, true)], data: Buffer.from([6, 2, 1, ...other]) },
    // Closing the owner's account into someone else's.
    { program: TOKEN, keys: [meta(wsolAta), meta(other), meta(owner, true)], data: Buffer.from([9]) },
    // A program the swap API never emits.
    { program: Buffer.alloc(32, 5), keys: [meta(owner, true)], data: Buffer.from([0]) },
    // A priority fee that would burn the balance.
    { program: budget, keys: [], data: price(10n ** 12n) },
  ];
  for (const bad of refused) assert.throws(() => check([...jupiterSwap, bad]));
});

test("a swap never pays out below what was reviewed, less its slippage", () => {
  assert.equal(reviewedFloor(1_000_000n, 100), 990_000n);
  // Same price: the requested slippage stands.
  assert.equal(slippageFor(1_000_000n, 990_000n, 100), 100);
  // Moved against the person: narrowed so the on-chain minimum is still the floor.
  const s = slippageFor(995_000n, 990_000n, 100);
  assert.ok(s < 100 && s >= 0);
  assert.ok((995_000n * BigInt(10_000 - s)) / 10_000n >= 990_000n);
  // Moved past the floor: refused.
  assert.equal(slippageFor(989_999n, 990_000n, 100), -1);
});

test("history reads each transaction as what it did to the wallet, fee and rent aside", () => {
  const [O, R, S, M, P, X] = ["Owner", "Recipient", "Sender", "Mint", "PoolAuthority", "Unlisted"].map((n) => `${n}1111111111111111111111111111`);
  const RENT = 2_039_280;
  const FEE = 5_000;
  const priced = { [M]: 1, [SOL_MINT]: 100 } as Record<string, number>;
  const lookup = (mints: string[]) =>
    new Map(mints.filter((m) => priced[m]).map((m) => [m, { mint: m, symbol: m === SOL_MINT ? "SOL" : "M", name: m, price: priced[m], liquidity: 1, verified: true } as TokenRecord]));
  const bal = (accountIndex: number, mint: string, owner: string, amount: number) => ({
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount: String(amount), decimals: mint === SOL_MINT ? 9 : 6 },
  });
  const tx = (keys: string[], pre: number[], post: number[], tokens: [ReturnType<typeof bal>[], ReturnType<typeof bal>[]], extra = {}) => ({
    blockTime: 1_700_000_000,
    transaction: { signatures: [`sig${keys.join("").length}${pre.join("")}`], message: { accountKeys: keys } },
    meta: { err: null, fee: FEE, preBalances: pre, postBalances: post, preTokenBalances: tokens[0], postTokenBalances: tokens[1], ...extra },
  });
  const read = (t: RawTx) => {
    const hidden = { n: 0 };
    return { a: readTx(O, t, hidden, lookup), hidden: hidden.n };
  };

  // A token sent, opening the recipient's account: the token alone, and to whom.
  const sent = read(
    tx([O, "Ar", R, M, "Ao"], [1e9, 0, 0, 1, RENT], [1e9 - FEE - RENT, RENT, 0, 1, RENT], [
      [bal(4, M, O, 5_000_000)],
      [bal(4, M, O, 3_000_000), bal(1, M, R, 2_000_000)],
    ]),
  ).a;
  assert.equal(sent?.kind, "send");
  assert.deepEqual(sent?.moves.map((m) => [m.mint, m.amount]), [[M, "-2000000"]]);
  assert.equal(sent?.peer, R);

  // SOL for a token, through a wrapped-SOL account opened and closed inside
  // the swap, into a token account it opened: SOL out, the token in.
  const swap = read(
    tx([O, "Ao", "W", "PoolSol", "PoolM"], [1e9, 0, 0, 5e9, RENT], [1e9 - FEE - RENT - 1e8, RENT, 0, 5e9 + 1e8, RENT], [
      [bal(3, SOL_MINT, P, 5e9), bal(4, M, P, 90_000_000)],
      [bal(1, M, O, 42_000_000), bal(3, SOL_MINT, P, 5e9 + 1e8), bal(4, M, P, 48_000_000)],
    ]),
  ).a;
  assert.equal(swap?.kind, "swap");
  assert.deepEqual(swap?.moves.map((m) => [m.mint, m.amount]), [[SOL_MINT, "-100000000"], [M, "42000000"]]);
  assert.equal(swap?.peer, undefined);

  // Paid into an account the wallet already holds, in a transaction that
  // never names the wallet: still its receipt, from the sender.
  const paid = read(
    tx([S, "As", "Ao"], [1e9, RENT, RENT], [1e9 - FEE, RENT, RENT], [
      [bal(1, M, S, 10_000_000), bal(2, M, O, 1_000_000)],
      [bal(1, M, S, 7_000_000), bal(2, M, O, 4_000_000)],
    ]),
  ).a;
  assert.equal(paid?.kind, "receive");
  assert.equal(paid?.peer, S);

  // SOL from someone else, who paid the fee.
  const sol = read(tx([S, O], [5e9, 1e9], [5e9 - 1e8 - FEE, 1e9 + 1e8], [[], []])).a;
  assert.deepEqual(sol?.moves.map((m) => [m.mint, m.amount]), [[SOL_MINT, "100000000"]]);
  assert.equal(sol?.peer, S);

  // $UTCC paid while the index has no record of it: still UTCC, and still shown.
  const utcc = read(
    tx([S, "As", "Ao"], [1e9, RENT, RENT], [1e9 - FEE, RENT, RENT], [
      [bal(1, UTCC_MINT, S, 5e12), bal(2, UTCC_MINT, O, 0)],
      [bal(1, UTCC_MINT, S, 3.5e12), bal(2, UTCC_MINT, O, 1.5e12)],
    ]),
  );
  assert.equal(utcc.a?.kind, "receive");
  assert.deepEqual(utcc.a?.moves.map((m) => [m.symbol, m.amount]), [["UTCC", "1500000000000"]]);

  // Dust sent unasked, and a token nobody lists: left out, and counted.
  const dust = read(tx([S, O], [5e9, 1e9], [5e9 - 1 - FEE, 1e9 + 1], [[], []]));
  assert.equal(dust.a, null);
  assert.equal(dust.hidden, 1);
  const spam = read(
    tx([S, "As", "Ao"], [1e9, RENT, 0], [1e9 - FEE - RENT, RENT, RENT], [
      [bal(1, X, S, 1e12)],
      [bal(1, X, S, 0), bal(2, X, O, 1e12)],
    ]),
  );
  assert.equal(spam.a, null);
  assert.equal(spam.hidden, 1);

  // The wallet's own failure is news; someone else's is not, and is not counted.
  const mine = read(tx([O, R], [1e9, 0], [1e9 - FEE, 0], [[], []], { err: { InstructionError: [0, "Custom"] } }));
  assert.equal(mine.a?.kind, "failed");
  const theirs = read(tx([S, O], [1e9, 0], [1e9 - FEE, 0], [[], []], { err: { InstructionError: [0, "Custom"] } }));
  assert.equal(theirs.a, null);
  assert.equal(theirs.hidden, 0);
});

test("a position enters at what was paid for it, however long ago", async () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.now();
  const tickAt = Math.floor(now / HOUR) * HOUR;
  const [M, N, P, Q, R, U] = ["Mint", "Next", "Plain", "Quick", "Rare", "Usd"].map((n) => `${n}1111111111111111111111111111`);
  const rec = (mint: string, price: number, closes?: number[]) => {
    const day = closes && encodeTicks(closes);
    return {
      mint, symbol: mint, name: mint, price, liquidity: 1, verified: true,
      ...(day ? { ticks: day.ticks, tickLo: day.lo, tickHi: day.hi, tickAt } : {}),
    } as TokenRecord;
  };
  // SOL flat at $100 today; M from $1 to $2 across the day; Q, R and U with no day of their own.
  const sol = rec(SOL_MINT, 100, new Array(24).fill(100));
  const m = rec(M, 2, Array.from({ length: 24 }, (_, i) => 1 + i / 23));
  const n = rec(N, 4, new Array(24).fill(4));
  const p = rec(P, 1, new Array(24).fill(1));
  const q = rec(Q, 0.02);
  const r = rec(R, 5);
  const u = rec(U, 1);
  const recs = new Map([sol, m, n, p, q, r, u].map((x) => [x.mint, x]));
  const lookup = (mints: string[]) => new Map(mints.filter((x) => recs.has(x)).map((x) => [x, recs.get(x)!]));
  // Before today, from the chart API: SOL at $80 until twenty days ago, $90 until a week ago,
  // then $95; M at $2; N at $1 until a week ago, then $3; U at $1. Q is too new for it, R unknown.
  const hourly = (f: (daysAgo: number) => number): PriceSeries[] => [
    { at: tickAt, step: HOUR, v: Array.from({ length: 2000 }, (_, i) => f((now - (tickAt - (1999 - i) * HOUR)) / DAY)) },
  ];
  const pasts: Record<string, PriceSeries[]> = {
    [SOL_MINT]: hourly((d) => (d > 20 ? 80 : d > 7 ? 90 : 95)),
    [M]: hourly(() => 2),
    [N]: hourly((d) => (d > 7 ? 1 : 3)),
    [P]: hourly(() => 1),
    [U]: hourly(() => 1),
  };
  const asked: string[] = [];
  const older = async (mint: string) => {
    asked.push(mint);
    return pasts[mint] ?? [];
  };
  const act = (daysAgo: number, moves: [string, number, number][]): Activity => ({
    signature: `s${daysAgo}`,
    at: now - daysAgo * DAY,
    kind: "swap",
    moves: moves.map(([mint, amount, decimals]) => ({ mint, symbol: "", decimals, amount: String(amount) })),
  });
  const past = [
    // 10 SOL arrive when SOL was $80.
    act(30, [[SOL_MINT, 10e9, 9]]),
    // 10 N for $10, all sold, then 10 more for $30: only the position held now counts.
    act(25, [[U, -10e6, 6], [N, 10e6, 6]]),
    act(15, [[N, -10e6, 6], [U, 12e6, 6]]),
    // 1 SOL ($90) for 50 M ($100): the $90 paid is what they cost.
    act(10, [[SOL_MINT, -1e9, 9], [M, 50e6, 6]]),
    // Half of them for 0.5 SOL, which cost the $50 of M given for it.
    act(5, [[M, -25e6, 6], [SOL_MINT, 0.5e9, 9]]),
    // 0.1 SOL ($9.50) for 1000 Q, which nothing else can price.
    act(2, [[SOL_MINT, -0.1e9, 9], [Q, 1000e6, 6]]),
    act(2, [[U, -30e6, 6], [N, 10e6, 6]]),
    // 5 of the P held from before anything here reaches.
    act(1.5, [[P, -5e6, 6], [U, 5e6, 6]]),
    // 1 SOL for 40 M three hours ago, priced off today's ticks.
    act(3 / 24, [[SOL_MINT, -1e9, 9], [M, 40e6, 6]]),
    // 3 R received an hour ago, with nothing to price them by.
    act(1 / 24, [[R, 3e6, 6]]),
  ];
  const held = [
    { rec: sol, units: 8.4 },
    { rec: m, units: 65 },
    { rec: n, units: 10 },
    { rec: p, units: 7 },
    { rec: q, units: 1000 },
    { rec: r, units: 3 },
  ];
  const near = (a: number | undefined, b: number) => assert.ok(a != null && Math.abs(a / b - 1) < 1e-3, `${a} ≉ ${b}`);
  // Read as far as a walk goes, which stops short of where P began.
  const got = await averageEntries(held, past, { lookup, older, cut: true });
  // 10 at $80, 1 out at the average, 0.5 in for $50; the sales since leave the average where it was.
  near(got.entries[SOL_MINT], 770 / 9.5);
  // 50 for $90, half sold at the average, 40 for $100: $145 for 65.
  near(got.entries[M], 145 / 65);
  // Bought again after it was sold out: the second buy's price alone.
  near(got.entries[N], 3);
  // What was paid, though the chart API has nothing for Q.
  near(got.entries[Q], 0.0095);
  // Nothing here reaches where P began, and nothing knows what R was worth: given up on, not guessed.
  assert.equal(got.entries[P], undefined);
  assert.equal(got.entries[R], undefined);
  assert.deepEqual(got.far.sort(), [P, R].sort());
  assert.ok(got.settled);
  // Only for what today's ticks cannot price, once each.
  assert.equal(asked.length, new Set(asked).size);
  assert.ok(!asked.includes(P));

  // Read to the wallet's first transaction and still short of P: the index is behind, not P given up on.
  const behind = await averageEntries(held, past, { lookup, older });
  assert.ok(!behind.settled);
  assert.deepEqual(behind.far, [R]);

  // A trade since, worked on from the basis alone, comes out as a walk through everything would,
  // and asks the chart API nothing: today is priced off the ticks.
  const trade = act(0.5 / 24, [[SOL_MINT, -1e9, 9], [M, 30e6, 6]]);
  const later = held.map((h) => (h.rec === sol ? { rec: sol, units: 7.4 } : h.rec === m ? { rec: m, units: 95 } : h));
  asked.length = 0;
  const step = await averageEntries(later, [trade], { lookup, older, seed: got.lots, cut: true });
  assert.equal(asked.length, 0);
  const whole = await averageEntries(later, [...past, trade], { lookup, older, cut: true });
  for (const mint of [SOL_MINT, M, N, Q]) near(step.entries[mint], whole.entries[mint]!);
  assert.deepEqual(step.far.sort(), whole.far.sort());

  // The basis adds up with what came since; not with a token's units off, nor without a holding it never knew.
  const basis = { slot: 1, lots: got.lots, far: got.far };
  assert.ok(follows(later, basis, [trade]));
  assert.ok(!follows(later, { ...basis, lots: { ...got.lots, [N]: [12, 36] } }, [trade]));
  assert.ok(!follows(later, { slot: 1, lots: {} }, [trade]));
});

test("posting waits ten minutes", () => {
  const now = 1_000_000;
  assert.equal(postWait(0, now), 0);
  assert.equal(postWait(now, now), 10 * 60 * 1000);
  assert.equal(postWait(now - 10 * 60 * 1000, now), 0);
  assert.match(waitText(10 * 60 * 1000), /10 min/);
  assert.equal(username(" Ada "), "ada");
  assert.equal(username("no"), null);
});

function packPost(text: string, photos: [Buffer, Buffer][], memo?: { bytes: Buffer; ms: number; wave: string }): Buffer {
  const encoded = Buffer.from(text);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(encoded.length);
  const parts: Buffer[] = [head, encoded, Buffer.from([photos.length])];
  for (const [small, full] of photos) {
    const len = Buffer.alloc(8);
    len.writeUInt32BE(small.length, 0);
    len.writeUInt32BE(full.length, 4);
    parts.push(len, small, full);
  }
  if (memo) {
    const len = Buffer.alloc(8);
    len.writeUInt32BE(memo.bytes.length, 0);
    len.writeUInt32BE(memo.ms, 4);
    parts.push(len, Buffer.from(memo.wave, "latin1"), memo.bytes);
  }
  return Buffer.concat(parts);
}

/** The EBML header Chrome's MediaRecorder writes, then `n` bytes standing in for the recording. */
function webm(n: number): Buffer {
  return Buffer.concat([
    Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102", "hex"),
    Buffer.alloc(n, 7),
  ]);
}

/** An ftyp box, as Safari's MediaRecorder opens an MP4 with. */
function mp4(n: number): Buffer {
  return Buffer.concat([Buffer.from("0000001c667479706d7034320000000069736f6d6d703432", "hex"), Buffer.alloc(n, 7)]);
}

function jpeg(w: number, h: number): Buffer {
  const buf = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  return buf;
}

function coseP256(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function authData(rpId: string, flags: number, count: number, credId: Uint8Array | null, cose: Uint8Array | null): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(count);
  const parts: Uint8Array[] = [createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counter];
  if (credId && cose) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    parts.push(Buffer.alloc(16), len, credId, cose);
  }
  return Buffer.concat(parts);
}

test("accounts, posts, friends, phrase, and a passkey", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  // As src/server.ts has it: state tags on every GET, ahead of the routes.
  app.use(stateTags);
  app.use("/api/social", socialRouter);
  app.get("/social/a/:name", sendAvatar);
  app.get("/social/t/:name", sendAvatar);
  app.get("/social/i/:id/:n", sendPostPhoto);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let jar = "";
  let client = "10.0.0.1";
  /**
   * Password routes allow three calls a minute per address. Each one here
   * stands for its own visitor, unless `pinned` holds the address still to
   * test that limit itself.
   */
  const PASSWORD_ROUTE = /^\/api\/social\/(login|register|recover|phrase|passkey\/options)$/;
  let visitors = 0;
  let pinned = false;

  async function call(method: string, urlPath: string, body?: Buffer | Record<string, unknown> | string) {
    const from = PASSWORD_ROUTE.test(urlPath) && !pinned ? `10.9.${++visitors >> 8}.${visitors & 255}` : client;
    const headers: Record<string, string> = { Origin: base, Accept: "application/json", "X-Forwarded-For": from };
    if (jar) headers.Cookie = jar;
    let payload: Buffer | string | undefined;
    if (Buffer.isBuffer(body)) {
      headers["Content-Type"] = urlPath.endsWith("/avatar") ? "image/jpeg" : "application/octet-stream";
      payload = body;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(base + urlPath, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() ?? [];
    const map = new Map(
      jar
        .split("; ")
        .filter(Boolean)
        .map((part) => {
          const i = part.indexOf("=");
          return [part.slice(0, i), part.slice(i + 1)] as const;
        }),
    );
    for (const cookie of set) {
      const pair = cookie.split(";")[0];
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(cookie)) map.delete(name);
      else map.set(name, value);
    }
    jar = [...map].map(([key, value]) => `${key}=${value}`).join("; ");
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, text };
  }

  try {
    const ada = await call("POST", "/api/social/register", {
      username: "Ada",
      password: "password1",
      terms: true,
    });
    assert.equal(ada.status, 200);
    assert.equal(ada.json?.name, "ada");
    assert.equal(typeof ada.json?.address, "string");
    assert.equal(JSON.stringify(ada.json).includes("phrase"), false);
    const adaAddress = String(ada.json?.address);
    const adaTerms = (await getUser("ada"))?.terms;
    assert.equal(adaTerms?.version, TERMS_VERSION);
    assert.ok(adaTerms && Date.now() - adaTerms.at < 60_000);
    jar = "";
    const secret = /passHash|pass_hash|phraseCt|phrase_ct|phraseSalt|phrase_salt|"cose"/;
    const pub = await call("GET", "/api/social/u/ada");
    assert.equal(pub.status, 200);
    assert.equal(secret.test(pub.text), false);
    // A new account starts with its own picture, drawn at sign-up in its name's colours.
    const start = await drawAvatar("ada");
    assert.equal((pub.json?.user as { avatarRev: number }).avatarRev, 1);
    assert.ok(Buffer.from(await (await fetch(`${base}/social/a/ada?v=1`)).arrayBuffer()).equals(start.full));
    assert.ok(Buffer.from(await (await fetch(`${base}/social/t/ada?v=1`)).arrayBuffer()).equals(start.tiny));
    assert.deepEqual(jpegSize(start.full), { w: 480, h: 480 });
    assert.deepEqual(jpegSize(start.tiny), { w: 80, h: 80 });
    assert.equal((await call("GET", "/api/social/friends")).status, 401);
    assert.equal((await call("GET", "/api/social/users?q=ada")).status, 401);
    assert.equal((await call("POST", "/api/social/phrase", { password: "password1" })).status, 401);

    const ben = await call("POST", "/api/social/register", {
      username: "ben",
      password: "password2",
      terms: true,
    });
    assert.equal(ben.status, 200);
    jar = "";

    const unagreed = await call("POST", "/api/social/register", { username: "dee", password: "password4" });
    assert.equal(unagreed.status, 400);

    const taken = await call("POST", "/api/social/register", {
      username: "ada",
      password: "password1",
      terms: true,
    });
    assert.equal(taken.status, 409);

    const bad = await call("POST", "/api/social/login", { username: "ada", password: "nope" });
    assert.equal(bad.status, 401);

    const login = await call("POST", "/api/social/login", { username: "ada", password: "password1" });
    assert.equal(login.status, 200);
    assert.ok(jar.includes("soc="));

    const timeline = await call("GET", "/api/social/timeline");
    assert.equal((timeline.json?.me as { name: string }).name, "ada");

    const post = await call("POST", "/api/social/post", { text: "hello @Ben" });
    assert.equal(post.status, 200);
    const postId = String((post.json?.post as { id: string }).id);
    assert.equal((post.json?.post as { text: string }).text, "hello @Ben");

    const again = await call("POST", "/api/social/post", { text: "too soon" });
    assert.equal(again.status, 429);
    assert.match(String(again.json?.error), /10 min/);

    // When the account may post again is a time, the same on every answer, so
    // a copy kept and shown again later (src/state.ts) is still right.
    const posted = (post.json?.post as { at: number }).at;
    const first = (await call("GET", "/api/social/me")).json?.me as { nextPost: number };
    assert.equal(first.nextPost, posted + 10 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(((await call("GET", "/api/social/me")).json?.me as { nextPost: number }).nextPost, first.nextPost);

    const selfComment = await call("POST", "/api/social/comment", { post: postId, text: "myself" });
    assert.equal(selfComment.status, 200);

    const own = await call("GET", "/api/social/notes");
    assert.equal((own.json?.notes as unknown[]).length, 0, "commenting on your own post notifies nobody");

    const beforeLogout = jar;
    await call("POST", "/api/social/logout", {});
    assert.equal(jar.includes("soc="), false);
    // Logging out ends the session everywhere, not only in this browser.
    jar = beforeLogout;
    assert.equal((await call("GET", "/api/social/me")).json?.me, null, "a copied cookie dies with logout");
    jar = "";
    assert.equal((await call("GET", "/api/social/notes")).status, 401);

    // A throwaway account for the guessing limits, so nobody below is held up.
    assert.equal((await call("POST", "/api/social/register", { username: "cat", password: "password3", terms: true })).status, 200);
    jar = "";
    // Three password guesses a minute from one address, whatever the account.
    pinned = true;
    client = "10.0.0.9";
    for (let i = 0; i < 3; i++) {
      assert.equal((await call("POST", "/api/social/login", { username: "cat", password: "wrong" + i })).status, 401);
    }
    assert.equal((await call("POST", "/api/social/login", { username: "cat", password: "password3" })).status, 429);
    pinned = false;
    client = "10.0.0.1";
    // And three wrong a minute per account, from any number of addresses.
    const catLocked = await call("POST", "/api/social/login", { username: "cat", password: "password3" });
    assert.equal(catLocked.status, 429, "cat's three misses above hold the account for a minute");
    assert.match(String(catLocked.json?.error), /Too many wrong passwords/);

    const benIn = await call("POST", "/api/social/login", { username: "ben", password: "password2" });
    assert.equal(benIn.status, 200);

    const pair = (): [Buffer, Buffer] => [jpeg(8, 8), jpeg(8, 8)];
    const tooMany = await call("POST", "/api/social/post", packPost("x", [pair(), pair(), pair(), pair(), pair()]));
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.json?.error), /Four photos/);
    const notJpeg = await call("POST", "/api/social/post", packPost("", [[Buffer.from("nope"), jpeg(8, 8)]]));
    assert.equal(notJpeg.status, 400);

    const phone0 = Buffer.concat([jpeg(16, 12), Buffer.from([1])]);
    const desk0 = jpeg(40, 20);
    const pictured = await call(
      "POST",
      "/api/social/post",
      packPost("", [
        [phone0, desk0],
        [jpeg(12, 16), jpeg(20, 30)],
      ]),
    );
    assert.equal(pictured.status, 200);
    const picturedPost = pictured.json?.post as { id: string; text: string; photos: number };
    assert.equal(picturedPost.text, "");
    assert.equal(picturedPost.photos, 2);
    const shot = await fetch(`${base}/social/i/${picturedPost.id}/0`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get("content-type"), "image/jpeg");
    assert.equal((await shot.arrayBuffer()).byteLength, desk0.length);
    const phoneShot = await fetch(`${base}/social/i/${picturedPost.id}/0?m=1`);
    assert.equal(phoneShot.status, 200);
    assert.equal((await phoneShot.arrayBuffer()).byteLength, phone0.length);
    assert.equal((await fetch(`${base}/social/i/${picturedPost.id}/1`)).status, 200);
    assert.equal((await fetch(`${base}/social/i/${picturedPost.id}/2`)).status, 404);
    const feed = await call("GET", "/api/social/timeline");
    const card = (feed.json?.posts as { by: string; photos: number; text: string }[]).find((row) => row.by === "ben");
    assert.equal(card?.photos, 2);
    assert.equal(card?.text, "");

    // A snapshot's tag (src/state.ts): the offline app asks with it, and an
    // unchanged timeline is a 304 with no body. The no-cache is what a browser
    // adds to a request with a conditional header of its author's.
    const check = (tag: string) =>
      fetch(`${base}/api/social/timeline`, {
        headers: { Cookie: jar, "X-UG-Check": "1", "If-None-Match": tag, "Cache-Control": "no-cache" },
      });
    const snapshot = (await fetch(`${base}/api/social/timeline`, { headers: { Cookie: jar } })).headers.get("etag") ?? "";
    assert.match(snapshot, /^"[\w-]+(\.[\w-]+)?"$/);
    const same = await check(snapshot);
    assert.equal(same.status, 304);
    assert.equal(await same.text(), "");

    const comment = await call("POST", "/api/social/comment", { post: postId, text: "nice @ada" });
    assert.equal(comment.status, 200);
    // The comment count moved, so the same snapshot is out of date.
    assert.equal((await check(snapshot)).status, 200);
    const lookup = await call("GET", "/api/social/users?q=ad");
    assert.equal(lookup.status, 200);
    assert.equal(/pass_hash|phrase_ct|passkey_cose/.test(lookup.text), false);
    const people = lookup.json?.users as { name: string; friend: boolean }[];
    assert.equal(people.length, 1);
    assert.equal(people[0].name, "ada");
    assert.equal(people[0].friend, false);
    const wild = await call("GET", "/api/social/users?q=" + encodeURIComponent("a_"));
    assert.equal((wild.json?.users as unknown[]).length, 0);
    const self = await call("GET", "/api/social/users?q=ben");
    assert.equal((self.json?.users as unknown[]).length, 0);
    const blank = await call("GET", "/api/social/users");
    assert.equal((blank.json?.users as unknown[]).length, 0);
    await call("POST", "/api/social/logout", {});
    const found = await call("GET", "/api/social/people?q=" + encodeURIComponent("@Ada"));
    assert.equal(found.status, 200);
    assert.equal(/pass_hash|phrase_ct|passkey_cose|address/.test(found.text), false);
    assert.deepEqual((found.json?.people as { name: string }[]).map((p) => p.name), ["ada"]);
    assert.equal(((await call("GET", "/api/social/people?q=ad")).json?.people as unknown[]).length, 0);
    assert.equal(((await call("GET", "/api/social/people?q=a_%25")).json?.people as unknown[]).length, 0);
    await call("POST", "/api/social/login", { username: "ben", password: "password2" });

    // The profile card offers Add until it has been used.
    const before = await call("GET", "/api/social/u/ada");
    assert.equal((before.json?.user as { friend: boolean }).friend, false);
    const added = await call("POST", "/api/social/friends", { username: "ada" });
    assert.equal(added.status, 200);
    assert.equal((added.json?.friends as { name: string }[])[0].name, "ada");
    const friends = await call("GET", "/api/social/friends");
    assert.equal((friends.json?.friends as { name: string }[])[0].name, "ada");
    const marked = await call("GET", "/api/social/users?q=ada");
    assert.equal((marked.json?.users as { friend: boolean }[])[0].friend, true);
    const after = await call("GET", "/api/social/u/ada");
    assert.equal((after.json?.user as { friend: boolean }).friend, true);
    await call("POST", "/api/social/logout", {});
    const out = await call("GET", "/api/social/u/ada");
    assert.equal((out.json?.user as { friend: boolean }).friend, false);

    const adaIn = await call("POST", "/api/social/login", { username: "ada", password: "password1" });
    assert.equal(adaIn.status, 200);
    const noted = await call("GET", "/api/social/notes");
    const notes = noted.json?.notes as { from: string; post: string; avatarRev: number; at: number; seen: boolean }[];
    assert.equal(notes.length, 1);
    assert.equal(notes[0].from, "ben");
    assert.equal(notes[0].post, postId);
    assert.equal(typeof notes[0].avatarRev, "number");
    assert.equal(typeof notes[0].at, "number");
    assert.equal(notes[0].seen, false);
    assert.equal((noted.json?.me as { unseen: number }).unseen, 1);

    const phrase = await call("POST", "/api/social/phrase", { password: "password1" });
    const adaPhrase = String(phrase.json?.phrase);
    assert.equal(phrase.status, 200);

    // Every send is confirmed with a passkey, however small; the session alone
    // moves nothing, and neither does the password.
    const tiny = { to: base58(Buffer.alloc(32, 7)), mint: SOL_MINT, amount: "1" };
    const unconfirmed = await call("POST", "/api/social/send", tiny);
    assert.equal(unconfirmed.status, 403, unconfirmed.text);
    assert.equal(unconfirmed.json?.stepUp, true);
    assert.equal(unconfirmed.json?.passkey, false, "ada has no passkey, so she is told to add one");
    const byPassword = await call("POST", "/api/social/send", { ...tiny, password: "password1" });
    assert.equal(byPassword.status, 403, byPassword.text);
    assert.equal(byPassword.json?.stepUp, true);
    // A swap states the output it reviewed, or it is not a swap the server will make.
    const unreviewed = await call("POST", "/api/social/swap", {
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000",
      slippageBps: 100,
    });
    assert.equal(unreviewed.status, 400);
    const words = String(phrase.json?.phrase).split(" ");
    assert.equal(words.length, 12);
    for (const word of words) assert.ok(WORDLIST.includes(word));
    assert.equal(solanaAddress(String(phrase.json?.phrase)), adaAddress);

    const wrong = await call("POST", "/api/social/phrase", { password: "nope" });
    assert.equal(wrong.status, 403);

    const frozen = await call("POST", "/api/social/profile", { username: "eve", bio: "nope" });
    assert.equal(frozen.status, 400);
    assert.match(String(frozen.json?.error), /can't be changed/);

    const saved = await call("POST", "/api/social/profile", { bio: "hello there", loc: "Lisbon" });
    assert.equal(saved.status, 200);
    // The answer is the saved state, which Edit profile redraws from.
    const savedMe = saved.json?.me as { bio: string; loc: string };
    assert.equal(savedMe.bio, "hello there");
    assert.equal(savedMe.loc, "Lisbon");
    const profile = await call("GET", "/api/social/u/ada");
    const user = profile.json?.user as { bio: string; loc: string; name: string };
    assert.equal(user.bio, "hello there");
    assert.equal(user.loc, "Lisbon");
    assert.equal(user.name, "ada");

    const wide = await call("POST", "/api/social/avatar", jpeg(20, 10));
    assert.equal(wide.status, 400);
    assert.match(String(wide.json?.error), /portrait/);

    const photo = await call("POST", "/api/social/avatar", jpeg(10, 20));
    assert.equal(photo.status, 200);
    assert.equal((photo.json?.me as { avatarRev: number }).avatarRev, photo.json?.avatarRev);
    const avatar = await fetch(`${base}/social/a/ada?v=${photo.json?.avatarRev}`);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get("content-type"), "image/jpeg");

    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = coseP256(Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"));
    const credId = Buffer.from("credential-id-001");
    assert.equal((await call("POST", "/api/social/passkey/options", {})).status, 403, "needs the password");
    const options = await call("POST", "/api/social/passkey/options", { password: "password1" });
    assert.equal(options.status, 200);
    const challenge = Buffer.from(String(options.json?.challenge), "base64url");
    const rpId = "127.0.0.1";
    const regClient = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: String(options.json?.challenge),
        origin: base,
      }),
    );
    const regAuth = authData(rpId, 0x45, 0, credId, cose);
    const attestation = Buffer.concat([
      Buffer.from([0xa3]),
      Buffer.from([0x63]),
      Buffer.from("fmt"),
      Buffer.from([0x64]),
      Buffer.from("none"),
      Buffer.from([0x67]),
      Buffer.from("attStmt"),
      Buffer.from([0xa0]),
      Buffer.from([0x68]),
      Buffer.from("authData"),
      Buffer.from([0x58, regAuth.length]),
      regAuth,
    ]);
    const enrolled = await call("POST", "/api/social/passkey", {
      id: credId.toString("base64url"),
      challenge: String(options.json?.challenge),
      clientData: regClient.toString("base64url"),
      attestation: attestation.toString("base64url"),
    });
    assert.equal(enrolled.status, 200, enrolled.text);
    assert.deepEqual((enrolled.json?.me as { passkey: unknown }).passkey, { id: credId.toString("base64url") });

    await call("POST", "/api/social/logout", {});
    const needsKey = await call("POST", "/api/social/login", {
      username: "ada",
      password: "password1",
    });
    assert.equal(needsKey.status, 200);
    assert.ok(needsKey.json?.passkey);
    assert.equal(jar.includes("soc="), false);

    const loginChallenge = String((needsKey.json?.passkey as { challenge: string }).challenge);
    const getClient = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: loginChallenge, origin: base }),
    );
    const getAuth = authData(rpId, 0x05, 1, null, null);
    const signed = Buffer.concat([getAuth, createHash("sha256").update(getClient).digest()]);
    const signature = sign("sha256", signed, privateKey);
    const authed = await call("POST", "/api/social/login/passkey", {
      username: "ada",
      challenge: loginChallenge,
      clientData: getClient.toString("base64url"),
      authenticatorData: getAuth.toString("base64url"),
      signature: signature.toString("base64url"),
    });
    assert.equal(authed.status, 200, authed.text);
    assert.ok(jar.includes("soc="));

    const seen = await call("GET", "/api/social/timeline");
    assert.deepEqual((seen.json?.me as { passkey: unknown }).passkey, { id: credId.toString("base64url") });
    assert.equal(challenge.length, 32);

    await call("POST", "/api/social/logout", {});
    const alone = await call("POST", "/api/social/passkey/login", {});
    assert.equal(alone.status, 200, alone.text);
    const aloneChallenge = String(alone.json?.challenge);
    const aloneClient = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: aloneChallenge, origin: base }),
    );
    const aloneAuth = authData(rpId, 0x05, 2, null, null);
    const aloneSig = sign(
      "sha256",
      Buffer.concat([aloneAuth, createHash("sha256").update(aloneClient).digest()]),
      privateKey,
    );
    const byKey = await call("POST", "/api/social/login/passkey", {
      id: credId.toString("base64url"),
      challenge: aloneChallenge,
      clientData: aloneClient.toString("base64url"),
      authenticatorData: aloneAuth.toString("base64url"),
      signature: aloneSig.toString("base64url"),
    });
    assert.equal(byKey.status, 200, byKey.text);
    assert.equal(byKey.json?.name, "ada");
    assert.ok(jar.includes("soc="));
    assert.equal(((await call("GET", "/api/social/me")).json?.me as { name: string }).name, "ada");

    // Its own address: the secrets bucket is five calls deep, and the phrase tests above spent it.
    client = "10.0.0.2";
    async function unlock(count: number, signer = privateKey) {
      const opt = await call("POST", "/api/social/phrase/passkey/options", {});
      assert.equal(opt.status, 200, opt.text);
      assert.equal(opt.json?.id, credId.toString("base64url"));
      const ch = String(opt.json?.challenge);
      const cdata = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch, origin: base }));
      const auth = authData(rpId, 0x05, count, null, null);
      const sig = sign("sha256", Buffer.concat([auth, createHash("sha256").update(cdata).digest()]), signer);
      return call("POST", "/api/social/phrase/passkey", {
        challenge: ch,
        clientData: cdata.toString("base64url"),
        authenticatorData: auth.toString("base64url"),
        signature: sig.toString("base64url"),
      });
    }
    const byPasskey = await unlock(3);
    assert.equal(byPasskey.status, 200, byPasskey.text);
    assert.equal(byPasskey.json?.phrase, adaPhrase);
    assert.equal(/key_ct|keyBox|phrase_ct/.test(byPasskey.text), false);
    const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    assert.equal((await unlock(4, otherKey)).status, 403);
    assert.equal((await unlock(5)).status, 200);

    const swap = (body: Record<string, unknown>) => call("POST", "/api/social/swap", body);
    const sol = "So11111111111111111111111111111111111111112";
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    assert.equal((await swap({ inputMint: sol, outputMint: sol, amount: "1" })).status, 400);
    assert.equal((await swap({ inputMint: sol, outputMint: usdc, amount: "0" })).status, 400);
    assert.equal((await swap({ inputMint: sol, outputMint: usdc, amount: "1.5" })).status, 400);
    assert.equal((await swap({ inputMint: sol, outputMint: usdc, amount: "1", slippageBps: 5000 })).status, 400);
    const send = (body: Record<string, unknown>) => call("POST", "/api/social/send", body);
    assert.equal((await send({ to: "nope", mint: sol, amount: "1" })).status, 400);
    assert.equal((await send({ to: adaAddress, mint: sol, amount: "1" })).status, 400);
    assert.equal((await send({ to: usdc, mint: sol, amount: "-1" })).status, 400);
    // With a passkey on the account, a send asks for that passkey and takes no other.
    const asked = await send({ to: usdc, mint: sol, amount: "1" });
    assert.equal(asked.status, 403, asked.text);
    assert.equal(asked.json?.passkey, true);
    const sendOpt = await call("POST", "/api/social/send/passkey/options", {});
    assert.equal(sendOpt.status, 200, sendOpt.text);
    const sendCh = String(sendOpt.json?.challenge);
    const sendData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: sendCh, origin: base }));
    const sendAuth = authData(rpId, 0x05, 6, null, null);
    const forged = await send({
      to: usdc,
      mint: sol,
      amount: "1",
      challenge: sendCh,
      clientData: sendData.toString("base64url"),
      authenticatorData: sendAuth.toString("base64url"),
      signature: sign("sha256", Buffer.concat([sendAuth, createHash("sha256").update(sendData).digest()]), otherKey).toString("base64url"),
    });
    assert.equal(forged.status, 403, forged.text);
    assert.match(String(forged.json?.error), /Passkey was not accepted/);

    await call("POST", "/api/social/logout", {});
    assert.equal((await call("POST", "/api/social/login", { username: "ben", password: "password2" })).status, 200);
    const plus = await call("POST", "/api/social/plus", { post: postId });
    assert.equal(plus.status, 200, plus.text);
    assert.equal(plus.json?.saved, true);
    const savedList = await call("GET", "/api/social/timeline?saved=1");
    const savedPosts = savedList.json?.posts as { id: string; saved: boolean }[];
    assert.equal(savedPosts[0].id, postId);
    assert.equal(savedPosts[0].saved, true);
    const plusAgain = await call("POST", "/api/social/plus", { post: postId });
    assert.equal(plusAgain.status, 200, plusAgain.text);
    assert.equal(plusAgain.json?.saved, false);
    const savedGone = await call("GET", "/api/social/timeline?saved=1");
    assert.equal((savedGone.json?.posts as unknown[]).length, 0);
    const repost = await call("POST", "/api/social/repost", { post: postId });
    assert.equal(repost.status, 200, repost.text);
    const copied = ((await call("GET", "/api/social/timeline")).json?.posts as {
      id: string;
      by: string;
      repost: string;
      repostBy: string;
    }[]).find((post) => post.repost === postId);
    assert.equal(copied?.by, "ben");
    assert.equal(copied?.repostBy, "ada");
    const repostAgain = await call("POST", "/api/social/repost", { post: postId });
    assert.equal(repostAgain.status, 400);
    const repostCopy = await call("POST", "/api/social/repost", { post: copied?.id });
    assert.equal(repostCopy.status, 400);
    await call("POST", "/api/social/logout", {});
    const adaBack = await call("POST", "/api/social/login", { username: "ada", password: "password1" });
    const againChallenge = String((adaBack.json?.passkey as { challenge: string }).challenge);
    const againClient = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: againChallenge, origin: base }),
    );
    const againAuth = authData(rpId, 0x05, 7, null, null);
    const againSig = sign(
      "sha256",
      Buffer.concat([againAuth, createHash("sha256").update(againClient).digest()]),
      privateKey,
    );
    assert.equal(
      (
        await call("POST", "/api/social/login/passkey", {
          username: "ada",
          challenge: againChallenge,
          clientData: againClient.toString("base64url"),
          authenticatorData: againAuth.toString("base64url"),
          signature: againSig.toString("base64url"),
        })
      ).status,
      200,
    );
    const noted2 = await call("GET", "/api/social/notes");
    const kinds = (noted2.json?.notes as { kind: string; from: string }[]).map((note) => note.kind).sort();
    assert.deepEqual(kinds, ["comment", "repost"]);
    const noteSeen = await call("POST", "/api/social/notes/seen", {});
    assert.equal(noteSeen.status, 200);
    assert.equal((noteSeen.json?.me as { unseen: number }).unseen, 0);
    // Seen notes stay listed, as Earlier; only the badge's count goes.
    const read = await call("GET", "/api/social/notes");
    assert.deepEqual((read.json?.notes as { seen: boolean }[]).map((note) => note.seen), [true, true]);
    assert.equal((read.json?.me as { unseen: number }).unseen, 0);
    const opened = await call("POST", "/api/social/open", { post: postId });
    assert.equal(opened.status, 200, opened.text);
    assert.equal((opened.json?.me as { name: string }).name, "ada");
    assert.equal((opened.json?.post as { views: number; comments: number }).views, 1);
    assert.equal((opened.json?.post as { comments: number }).comments, 2);
    const openedComments = opened.json?.comments as { avatarRev: number }[];
    assert.equal(openedComments.length, 2);
    assert.equal(typeof openedComments[0].avatarRev, "number");
    const openedAgain = await call("POST", "/api/social/open", { post: postId });
    assert.equal((openedAgain.json?.post as { views: number }).views, 2);

    const filler = new Client({ connectionString: process.env.DATABASE_URL });
    await filler.connect();
    try {
      for (let i = 0; i < TIMELINE_PAGE; i++) {
        await filler.query("INSERT INTO posts (id, by_name, text, at) VALUES ($1, 'ada', $2, $3)", [
          `old${i}`,
          `old ${i}`,
          1_000_000 + i,
        ]);
      }
    } finally {
      await filler.end();
    }
    const firstPage = await call("GET", "/api/social/timeline");
    const firstPosts = firstPage.json?.posts as { id: string }[];
    assert.equal(firstPosts.length, TIMELINE_PAGE);
    const cursor = firstPage.json?.next as { at: number; id: string };
    assert.equal(typeof cursor.at, "number");
    assert.equal(typeof cursor.id, "string");
    const secondPage = await call(
      "GET",
      `/api/social/timeline?before=${cursor.at}&id=${encodeURIComponent(cursor.id)}`,
    );
    const secondPosts = secondPage.json?.posts as { id: string }[];
    assert.equal(secondPosts.length, 3);
    assert.equal(secondPage.json?.next, null);
    const seenIds = new Set(firstPosts.map((post) => post.id));
    for (const post of secondPosts) assert.equal(seenIds.has(post.id), false);
    assert.equal((await call("GET", "/api/social/timeline?before=nope&id=x")).status, 400);

    // Recovery: the phrase alone, a new password, every old session gone.
    const oldJar = jar;
    assert.equal((await call("POST", "/api/social/recover", { phrase: "one two", password: "password9" })).status, 400);
    const stranger = await call("POST", "/api/social/recover", { phrase: ABANDON, password: "password9" });
    assert.equal(stranger.status, 401);
    const back = await call("POST", "/api/social/recover", {
      phrase: `  ${adaPhrase.toUpperCase()} `,
      password: "password9",
    });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json?.name, "ada");
    assert.equal(((await call("GET", "/api/social/timeline")).json?.me as { name: string }).name, "ada");
    const newJar = jar;
    jar = oldJar;
    assert.equal((await call("GET", "/api/social/timeline")).json?.me, null, "old cookie is revoked");
    jar = newJar;
    await call("POST", "/api/social/logout", {});
    assert.equal((await call("POST", "/api/social/login", { username: "ada", password: "password1" })).status, 401);
    // The passkey went with the old password, so this logs straight in.
    const fresh = await call("POST", "/api/social/login", { username: "ada", password: "password9" });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fresh.json?.name, "ada");
    const reread = await call("POST", "/api/social/phrase", { password: "password9" });
    assert.equal(reread.json?.phrase, adaPhrase);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

/**
 * Messenger, driven the way the browser drives it: WebCrypto for the keys and
 * the sealing, a signed passkey assertion to publish a key. The server is
 * checked for what it must never see and what it must refuse.
 */
test("messenger keeps only ciphertext and refuses stale or foreign keys", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/social", socialRouter);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const rpId = "127.0.0.1";
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder();
  let ip = 0;

  function person() {
    let jar = "";
    return async function call(method: string, urlPath: string, body?: Buffer | Record<string, unknown>) {
      const headers: Record<string, string> = { Origin: base, Accept: "application/json", "X-Forwarded-For": `10.1.0.${++ip % 250}` };
      if (jar) headers.Cookie = jar;
      let payload: Buffer | string | undefined;
      if (Buffer.isBuffer(body)) {
        headers["Content-Type"] = "application/octet-stream";
        payload = body;
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + urlPath, { method, headers, body: payload });
      for (const cookie of res.headers.getSetCookie?.() ?? []) jar = cookie.split(";")[0];
      const raw = Buffer.from(await res.arrayBuffer());
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        json = null;
      }
      return { status: res.status, json, raw, text: raw.toString("utf8") };
    };
  }

  async function join(name: string) {
    const call = person();
    assert.equal((await call("POST", "/api/social/register", { username: name, password: "password1", terms: true })).status, 200);
    return call;
  }

  async function enroll(call: ReturnType<typeof person>, tag: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = coseP256(Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"));
    const credId = Buffer.from(`cred-${tag}`);
    const options = await call("POST", "/api/social/passkey/options", { password: "password1" });
    const regAuth = authData(rpId, 0x45, 0, credId, cose);
    const attestation = Buffer.concat([
      Buffer.from([0xa3, 0x63]), Buffer.from("fmt"), Buffer.from([0x64]), Buffer.from("none"),
      Buffer.from([0x67]), Buffer.from("attStmt"), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from("authData"), Buffer.from([0x58, regAuth.length]), regAuth,
    ]);
    const enrolled = await call("POST", "/api/social/passkey", {
      id: credId.toString("base64url"),
      challenge: String(options.json?.challenge),
      clientData: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: String(options.json?.challenge), origin: base })).toString("base64url"),
      attestation: attestation.toString("base64url"),
    });
    assert.equal(enrolled.status, 200, enrolled.text);
    let count = 0;
    return async function assertion(signer = privateKey) {
      const opt = await call("POST", "/api/social/ck/options", {});
      assert.equal(opt.status, 200, opt.text);
      assert.equal(opt.json?.id, credId.toString("base64url"));
      const ch = String(opt.json?.challenge);
      const cdata = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch, origin: base }));
      const auth = authData(rpId, 0x05, ++count, null, null);
      const sig = sign("sha256", Buffer.concat([auth, createHash("sha256").update(cdata).digest()]), signer);
      return {
        challenge: ch,
        clientData: cdata.toString("base64url"),
        authenticatorData: auth.toString("base64url"),
        signature: sig.toString("base64url"),
      };
    };
  }

  const ECDH = { name: "ECDH", namedCurve: "P-256" };

  async function hkdf(bytes: ArrayBuffer, info: string) {
    const baseKey = await subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function newKey() {
    const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
    const pub = Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url");
    return { priv: pair.privateKey, pub };
  }

  async function pairKey(me: string, myV: number, priv: webcrypto.CryptoKey, peer: string, theirV: number, pub: string) {
    const theirs = await subtle.importKey("raw", Buffer.from(pub, "base64url"), ECDH, false, []);
    const bits = await subtle.deriveBits({ name: "ECDH", public: theirs }, priv, 256);
    return hkdf(bits, `ug chat ${[`${me}.${myV}`, `${peer}.${theirV}`].sort().join(" ")}`);
  }

  function pack(head: Record<string, unknown>, photos: Buffer[] = [], audio?: Buffer): Buffer {
    const json = Buffer.from(JSON.stringify(head));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(json.length);
    const parts: Buffer[] = [len, json, Buffer.from([photos.length])];
    for (const blob of audio ? [...photos, audio] : photos) {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(blob.length);
      parts.push(n, blob);
    }
    return Buffer.concat(parts);
  }

  async function sealWith(key: webcrypto.CryptoKey, aad: string, bytes: Uint8Array): Promise<Buffer> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    return Buffer.concat([iv, Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes))]);
  }

  try {
    const ada = await join("ada");
    const bob = await join("bob");
    const eve = await join("eve");

    assert.equal((await ada("GET", "/api/social/ck")).json?.cred, null);
    assert.equal((await ada("POST", "/api/social/ck/options", {})).status, 400, "a passkey comes first");

    const adaProof = await enroll(ada, "ada");
    const bobProof = await enroll(bob, "bob");
    const adaKey = await newKey();
    const bobKey = await newKey();
    const box = { iv: Buffer.alloc(12, 1).toString("base64url"), ct: Buffer.alloc(64, 2).toString("base64url") };

    const forged = await ada("POST", "/api/social/ck", {
      ...(await adaProof(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)),
      pub: adaKey.pub,
      ...box,
    });
    assert.equal(forged.status, 403, "a session alone cannot publish a key");
    const offCurve = Buffer.alloc(65, 7);
    offCurve[0] = 4;
    const bad = await ada("POST", "/api/social/ck", { ...(await adaProof()), pub: offCurve.toString("base64url"), ...box });
    assert.equal(bad.status, 400);
    const published = await ada("POST", "/api/social/ck", { ...(await adaProof()), pub: adaKey.pub, ...box });
    assert.equal(published.status, 200, published.text);
    assert.equal(published.json?.v, 1);
    const mine = await ada("GET", "/api/social/ck");
    assert.equal(mine.json?.key.v, 1);
    assert.equal(mine.json?.key.ct, box.ct, "the owner gets the sealed box back");
    assert.equal(mine.json?.key.cred, mine.json?.cred);

    const toBob = await ada("GET", "/api/social/c/bob");
    assert.equal(toBob.status, 200);
    assert.deepEqual(toBob.json?.peer.keys, [], "bob has not turned Messenger on");
    const early = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 1, iv: box.iv, ct: box.ct }));
    assert.equal(early.status, 409);
    assert.equal(early.json?.stale, true);

    assert.equal((await bob("POST", "/api/social/ck", { ...(await bobProof()), pub: bobKey.pub, ...box })).status, 200);

    const words = "meet at the fountain at noon";
    const adaPair = await pairKey("ada", 1, adaKey.priv, "bob", 1, bobKey.pub);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ivText = Buffer.from(iv).toString("base64url");
    const ct = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("ada>bob") }, adaPair, te.encode(words)));
    const jpegBytes = jpeg(10, 20);
    const piv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const photo = Buffer.concat([
      piv,
      Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv: piv, additionalData: te.encode(`ada>bob ${ivText} 0`) }, adaPair, jpegBytes)),
    ]);
    const sent = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 1, iv: ivText, ct: ct.toString("base64url") }, [photo]));
    assert.equal(sent.status, 200, sent.text);
    const id = String(sent.json?.message.id);
    assert.equal(sent.json?.message.photos, 1);

    const inbox = await bob("GET", "/api/social/c");
    assert.equal(inbox.json?.me.unread, 1);
    assert.equal(inbox.json?.chats[0].with, "ada");
    assert.equal(inbox.json?.chats[0].unread, 1);
    assert.equal(inbox.json?.chats[0].pub, adaKey.pub, "the row carries the key its preview was sealed with");
    assert.equal(inbox.text.includes(words), false);

    const opened = await bob("GET", "/api/social/c/ada");
    const got = opened.json?.messages[0];
    const bobPair = await pairKey("bob", 1, bobKey.priv, "ada", 1, opened.json?.peer.keys[0].pub);
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(got.iv, "base64url"), additionalData: te.encode(`${got.from}>bob`) },
      bobPair,
      Buffer.from(got.ct, "base64url"),
    );
    assert.equal(new TextDecoder().decode(plain), words, "the recipient opens what the sender sealed");
    await assert.rejects(
      subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(got.iv, "base64url"), additionalData: te.encode("bob>ada") }, bobPair, Buffer.from(got.ct, "base64url")),
      "the direction is bound in",
    );
    assert.equal((await bob("GET", "/api/social/me")).json?.me.unread, 0, "opening reads it");

    const sealedPhoto = await bob("GET", `/api/social/cp/${id}/0`);
    assert.equal(sealedPhoto.status, 200);
    assert.deepEqual(sealedPhoto.raw, photo, "photos come back exactly as sealed");
    assert.equal((await eve("GET", `/api/social/cp/${id}/0`)).status, 404, "only the two people");
    assert.equal((await bob("GET", `/api/social/cp/${id}/1`)).status, 404);
    assert.equal((await eve("GET", "/api/social/c")).json?.chats.length, 0);

    const empty = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 1, iv: ivText, ct: Buffer.alloc(16).toString("base64url") }));
    assert.equal(empty.status, 400, "an empty message needs a photo");
    assert.equal((await ada("POST", "/api/social/c/ada", pack({ kf: 1, kt: 1, iv: ivText, ct: ct.toString("base64url") }))).status, 400);

    // Bob's new key makes Ada's copy of it stale, and her next send is refused until she fetches it.
    const bobKey2 = await newKey();
    assert.equal((await bob("POST", "/api/social/ck", { ...(await bobProof()), pub: bobKey2.pub, ...box })).json?.v, 2);
    const stale = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 1, iv: ivText, ct: ct.toString("base64url") }));
    assert.equal(stale.status, 409);
    const keys = (await ada("GET", "/api/social/c/bob")).json?.peer.keys;
    assert.deepEqual(keys.map((k: { v: number }) => k.v), [1, 2], "old keys stay, so old messages stay readable");

    for (let i = 0; i < 34; i++) {
      const res = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 2, iv: ivText, ct: ct.toString("base64url") }));
      assert.equal(res.status, 200, res.text);
    }
    const page = await bob("GET", "/api/social/c/ada");
    assert.equal(page.json?.messages.length, 30);
    assert.ok(page.json?.next);
    assert.ok(page.json?.messages[0].at <= page.json?.messages[29].at, "oldest first");
    const above = await bob(
      "GET",
      `/api/social/c/ada?before=${page.json?.next.at}&id=${encodeURIComponent(page.json?.next.id)}`,
    );
    assert.equal(above.json?.messages.length, 5);
    assert.equal(above.json?.next, null);
    assert.equal(above.json?.peer, undefined);
    const lastSeen = page.json?.messages[29];
    const poll = await bob("GET", `/api/social/c/ada?after=${lastSeen.at}&id=${encodeURIComponent(lastSeen.id)}`);
    assert.equal(poll.json?.messages.length, 0);
    const moved = await bob("GET", `/api/social/c?after=${page.json?.messages[29].at}`);
    assert.equal(moved.json?.chats[0].with, "ada");

    // A voice memo: its length and shape in a sealed box of their own, the recording as a sealed tail.
    const nowPair = await pairKey("ada", 1, adaKey.priv, "bob", 2, bobKey2.pub);
    const shape = JSON.stringify({ ms: 4200, wave: "A".repeat(40) });
    const memo = (await sealWith(nowPair, `ada>bob ${ivText} memo`, te.encode(shape))).toString("base64url");
    const recording = webm(64);
    const audio = await sealWith(nowPair, `ada>bob ${ivText} audio`, recording);
    const blank = Buffer.alloc(16).toString("base64url");
    const spoken = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 2, iv: ivText, ct: blank, memo }, [], audio));
    assert.equal(spoken.status, 200, spoken.text);
    const vid = String(spoken.json?.message.id);
    assert.equal(spoken.json?.message.memo, memo);
    const heard = await bob("GET", "/api/social/c/ada");
    const said = heard.json?.messages.at(-1);
    assert.equal(said.id, vid);
    assert.equal(heard.text.includes("4200"), false, "the length is sealed too");
    const bobNow = await pairKey("bob", 2, bobKey2.priv, "ada", 1, adaKey.pub);
    const memoBox = Buffer.from(said.memo, "base64url");
    const heardShape = await subtle.decrypt(
      { name: "AES-GCM", iv: memoBox.subarray(0, 12), additionalData: te.encode(`ada>bob ${said.iv} memo`) },
      bobNow,
      memoBox.subarray(12),
    );
    assert.equal(new TextDecoder().decode(heardShape), shape, "the recipient opens the memo's shape");
    const fetched = await bob("GET", `/api/social/ca/${vid}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.raw, audio, "the recording comes back exactly as sealed");
    assert.equal((await eve("GET", `/api/social/ca/${vid}`)).status, 404, "only the two people");
    assert.equal((await bob("GET", `/api/social/ca/${id}`)).status, 404, "a message without a memo has none");
    const half = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 2, iv: ivText, ct: blank, memo }));
    assert.equal(half.status, 400, "a memo's box without its recording");
    const mute = await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 2, iv: ivText, ct: blank }, [], audio));
    assert.equal(mute.status, 400, "a recording without its box");
    const huge = Buffer.alloc(640 * 1024 + 29);
    assert.equal((await ada("POST", "/api/social/c/bob", pack({ kf: 1, kt: 2, iv: ivText, ct: blank, memo }, [], huge))).status, 400);

    // A $UTCC payment rides the conversation in the clear, with no key on either side.
    const paid = await postPayment("ada", "bob", { amount: "1500000000", sig: "5ig" }, Date.now());
    const bobList = await bob("GET", "/api/social/c");
    const row = bobList.json?.chats.find((c: { with: string }) => c.with === "ada");
    assert.equal(row.last.id, paid.id, "it is the chat's newest");
    assert.ok(row.unread > 0, "and unread for whoever was paid");
    const withPay = await bob("GET", "/api/social/c/ada");
    assert.deepEqual(withPay.json?.messages.at(-1).pay, { amount: "1500000000", sig: "5ig" });
    assert.equal(withPay.json?.messages.at(-1).id, paid.id);
    await postPayment("ada", "eve", { amount: "1", sig: "5ig2" }, Date.now());
    const eveList = await eve("GET", "/api/social/c");
    assert.equal(eveList.json?.chats[0].last.pay.amount, "1", "without Messenger turned on");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("a voice memo is WebM or MP4, known by its header", () => {
  assert.equal(audioKind(webm(8)), "webm");
  assert.equal(audioKind(mp4(8)), "m4a");
  const matroska = Buffer.from(webm(8).toString("latin1").replace("webm", "mkvx"), "latin1");
  assert.equal(audioKind(matroska), null, "EBML that is not WebM");
  assert.equal(audioKind(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20)])), null);
  assert.equal(audioKind(jpeg(8, 8)), null);
  assert.equal(audioKind(webm(0).subarray(0, 8)), null, "too short to say");
});

test("a voice memo posts, plays from its own address, and rides a re-post", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/social", socialRouter);
  app.get("/social/v/:id", sendPostAudio);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let ip = 0;

  async function join(name: string) {
    let jar = "";
    const call = async (method: string, urlPath: string, body?: Buffer | Record<string, unknown>) => {
      const headers: Record<string, string> = { Origin: base, Accept: "application/json", "X-Forwarded-For": `10.2.0.${++ip % 250}` };
      if (jar) headers.Cookie = jar;
      if (body) headers["Content-Type"] = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
      const res = await fetch(base + urlPath, { method, headers, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
      for (const cookie of res.headers.getSetCookie?.() ?? []) jar = cookie.split(";")[0];
      const text = await res.text();
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    };
    assert.equal((await call("POST", "/api/social/register", { username: name, password: "password1", terms: true })).status, 200);
    return call;
  }
  const files = (ext: string) => readdirSync(path.join(dir, "posts")).filter((f) => f.endsWith(ext));

  try {
    const amy = await join("amy");
    const wave = "A".repeat(20) + "_".repeat(20);
    const refused = async (memo: { bytes: Buffer; ms: number; wave: string }, why: RegExp) => {
      const res = await amy("POST", "/api/social/post", packPost("", [], memo));
      assert.equal(res.status, 400, res.text);
      assert.match(String(res.json?.error), why);
    };
    await refused({ bytes: jpeg(8, 8), ms: 2000, wave }, /WebM or MP4/);
    assert.equal(MAX_AUDIO_MS, 180_000, "three minutes");
    await refused({ bytes: webm(64), ms: MAX_AUDIO_MS + 1001, wave }, /3 minutes/);
    await refused({ bytes: webm(64), ms: 100, wave }, /3 minutes/);
    await refused({ bytes: webm(64), ms: 2000, wave: wave.slice(1) }, /Malformed/);
    await refused({ bytes: webm(64), ms: 2000, wave: "!" + wave.slice(1) }, /Malformed/);
    await refused({ bytes: webm(AUDIO_BYTES), ms: 2000, wave }, /too large/);
    const cut = packPost("", [], { bytes: webm(64), ms: 2000, wave });
    assert.equal((await amy("POST", "/api/social/post", cut.subarray(0, cut.length - 1))).status, 400, "shorter than it says");

    // A memo alone is a post. A stop just past the limit is drawn as the limit.
    const recording = webm(900);
    const posted = await amy("POST", "/api/social/post", packPost("", [], { bytes: recording, ms: MAX_AUDIO_MS + 400, wave }));
    assert.equal(posted.status, 200, posted.text);
    const card = posted.json?.post;
    assert.equal(card.text, "");
    assert.equal(card.audio, MAX_AUDIO_MS);
    assert.equal(card.wave, wave);
    assert.equal(card.photos, 0);

    const played = await fetch(`${base}/social/v/${card.id}`);
    assert.equal(played.status, 200);
    assert.equal(played.headers.get("content-type"), "audio/webm");
    assert.equal(played.headers.get("cache-control"), "public, max-age=86400");
    assert.deepEqual(Buffer.from(await played.arrayBuffer()), recording);
    // Safari asks for a range before it will play anything.
    const part = await fetch(`${base}/social/v/${card.id}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-9/${recording.length}`);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${base}/social/v/nope`)).status, 404);
    assert.equal((await fetch(`${base}/social/v/a.b`)).status, 404);

    // Too soon for a second post: the memo that came with it is not kept.
    const again = await amy("POST", "/api/social/post", packPost("", [], { bytes: webm(64), ms: 2000, wave }));
    assert.equal(again.status, 429);
    assert.equal(files(".webm").length, 1);

    // Words, a photo, and a memo from Safari, together.
    const bob = await join("bob");
    const both = await bob("POST", "/api/social/post", packPost("listen", [[jpeg(8, 8), jpeg(16, 16)]], { bytes: mp4(300), ms: 4200, wave }));
    assert.equal(both.status, 200, both.text);
    assert.equal(both.json?.post.photos, 1);
    assert.equal(both.json?.post.audio, 4200);
    assert.equal((await fetch(`${base}/social/v/${both.json?.post.id}`)).headers.get("content-type"), "audio/mp4");
    assert.equal(files(".m4a").length, 1);

    // A re-post carries the original's memo, as it carries its photos.
    assert.equal((await bob("POST", "/api/social/repost", { post: card.id })).status, 200);
    const feed = await bob("GET", "/api/social/timeline");
    const shared = (feed.json?.posts as { repost: string | null; audio: number; wave: string }[]).find((p) => p.repost === card.id);
    assert.equal(shared?.audio, MAX_AUDIO_MS);
    assert.equal(shared?.wave, wave);
    const plain = (feed.json?.posts as { text: string; audio: number; wave: string }[]).filter((p) => p.text === "listen");
    assert.equal(plain.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("the timeline filters in the query, and pages through what is left", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/social", socialRouter);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let ip = 0;

  function visitor() {
    let jar = "";
    return async (method: string, urlPath: string, body?: Record<string, unknown>) => {
      const headers: Record<string, string> = { Origin: base, Accept: "application/json", "X-Forwarded-For": `10.3.0.${++ip % 250}` };
      if (jar) headers.Cookie = jar;
      if (body) headers["Content-Type"] = "application/json";
      const res = await fetch(base + urlPath, { method, headers, body: body && JSON.stringify(body) });
      for (const cookie of res.headers.getSetCookie?.() ?? []) jar = cookie.split(";")[0];
      const text = await res.text();
      return { status: res.status, json: JSON.parse(text) as Record<string, any>, text };
    };
  }
  async function join(name: string) {
    const call = visitor();
    assert.equal((await call("POST", "/api/social/register", { username: name, password: "password1", terms: true })).status, 200);
    return call;
  }
  /** Every id the filtered timeline gives, page after page. Only a full page may have a next. */
  async function everything(call: ReturnType<typeof visitor>, query: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await call("GET", `/api/social/timeline?${query}${cursor}`);
      assert.equal(page.status, 200, page.text);
      const posts = page.json.posts as { id: string }[];
      ids.push(...posts.map((post) => post.id));
      const next = page.json.next as { at: number; id: string } | null;
      if (!next) return ids;
      assert.equal(posts.length, TIMELINE_PAGE, query);
      cursor = `&before=${next.at}&id=${encodeURIComponent(next.id)}`;
    }
  }

  try {
    const ada = await join("ada");
    const bob = await join("bob");
    const carl = await join("carl");
    // Sixty posts a minute apart, oldest first, by carl, bob and ada in turn.
    // Every fourth has a photo, every fifth a memo. Straight into the table:
    // the route would make each author wait ten minutes between them.
    const rows = new Client({ connectionString: process.env.DATABASE_URL });
    await rows.connect();
    try {
      for (let i = 0; i < 60; i++) {
        await rows.query("INSERT INTO posts (id, by_name, text, at, photos, audio) VALUES ($1,$2,$3,$4,$5,$6)", [
          `f${i}`,
          ["carl", "bob", "ada"][i % 3],
          `post ${i}`,
          1_000_000 + i * 60_000,
          i % 4 === 0 ? 1 : 0,
          i % 5 === 0 ? 3000 : 0,
        ]);
      }
    } finally {
      await rows.end();
    }
    const newest = (keep: (i: number) => boolean) =>
      Array.from({ length: 60 }, (_, i) => 59 - i).filter(keep).map((i) => `f${i}`);
    const byBob = (i: number) => i % 3 === 1;
    const byAda = (i: number) => i % 3 === 2;
    const photo = (i: number) => i % 4 === 0;
    const memo = (i: number) => i % 5 === 0;

    assert.deepEqual(await everything(ada, ""), newest(() => true));
    assert.deepEqual(await everything(ada, "images=1&audio=1"), newest(() => true));
    assert.deepEqual(await everything(ada, "images=0"), newest((i) => !photo(i)));
    assert.deepEqual(await everything(ada, "audio=0"), newest((i) => !memo(i)));
    assert.deepEqual(await everything(ada, "images=0&audio=0"), newest((i) => !photo(i) && !memo(i)));

    // Friends is the people added, and yourself.
    assert.deepEqual(await everything(ada, "friends=1"), newest(byAda));
    assert.equal((await ada("POST", "/api/social/friends", { username: "bob" })).status, 200);
    assert.deepEqual(await everything(ada, "friends=1"), newest((i) => byAda(i) || byBob(i)));
    assert.deepEqual(await everything(ada, "friends=1&images=0"), newest((i) => (byAda(i) || byBob(i)) && !photo(i)));
    assert.deepEqual(await everything(bob, "friends=1"), newest(byBob), "adding is one way");

    // Saved is in the timeline's order, not the order things were saved in,
    // and pages like the rest: bob's twenty and one of carl's.
    for (const i of [0, ...newest(byBob).map((id) => Number(id.slice(1)))]) {
      const saved = await ada("POST", "/api/social/plus", { post: `f${i}` });
      assert.equal(saved.json.saved, true, saved.text);
    }
    const savedByAda = (i: number) => byBob(i) || i === 0;
    assert.deepEqual(await everything(ada, "saved=1"), newest(savedByAda));
    assert.deepEqual(await everything(ada, "saved=1&images=0"), newest((i) => savedByAda(i) && !photo(i)));
    assert.deepEqual(await everything(ada, "saved=1&audio=0"), newest((i) => savedByAda(i) && !memo(i)));
    assert.deepEqual(await everything(ada, "saved=1&friends=1"), newest(byBob));
    assert.deepEqual(await everything(bob, "saved=1"), [], "saves are each person's own");
    // Un-saving takes it off.
    assert.equal((await ada("POST", "/api/social/plus", { post: "f0" })).json.saved, false);
    assert.deepEqual(await everything(ada, "saved=1"), newest(byBob));

    // Signed out, friends and saved are nobody's, so the whole feed shows.
    assert.deepEqual(await everything(visitor(), "friends=1&saved=1"), newest(() => true));

    // A re-post is judged by the original's photo and memo, which it shows.
    assert.equal((await carl("POST", "/api/social/repost", { post: "f44" })).status, 200);
    const [shared] = (await ada("GET", "/api/social/timeline")).json.posts as { id: string; repost: string }[];
    assert.equal(shared.repost, "f44");
    assert.equal((await everything(ada, "audio=0"))[0], shared.id, "f44 has no memo");
    assert.deepEqual(await everything(ada, "images=0"), newest((i) => !photo(i)), "f44 has a photo");

    // The desktop rail's Friends to add is who posted this month, less yourself and
    // whoever you added. The sixty above are dated 1970; carl's re-post is today's.
    const rail = async (call: ReturnType<typeof visitor>) =>
      ((await call("GET", "/api/social/rail")).json.people as { name: string; posts: number }[]).map((p) => `${p.name} ${p.posts}`);
    assert.deepEqual(await rail(ada), ["carl 1"]);
    assert.deepEqual(await rail(visitor()), ["carl 1"]);
    assert.deepEqual(await rail(carl), [], "not yourself");
    assert.equal((await bob("POST", "/api/social/friends", { username: "carl" })).status, 200);
    assert.deepEqual(await rail(bob), [], "not someone already added");
    // The top of Trending and its length; nothing on it in an empty index.
    assert.deepEqual((await ada("GET", "/api/social/rail")).json.assets, { count: 0, tokens: [] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("a name's colours are its own, never black or white, and dither from one end to the other", async () => {
  assert.deepEqual(palette("ada"), palette("ada"));
  assert.notDeepEqual(palette("ada").from, palette("adb").from, "a letter apart, a different colour");
  const lightness = ([r, g, b]: number[]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
  const hueOf = ([r, g, b]: number[]) => {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  };
  const slices = new Array(12).fill(0);
  for (let i = 0; i < 2000; i++) {
    const name = `user_${i.toString(36)}`;
    const colours = palette(name);
    for (const colour of [colours.from, colours.to, colours.figure]) {
      const l = lightness(colour);
      assert.ok(l > 0.38 && l < 0.9, `${name}: ${colour} is too close to black or white`);
      assert.ok(Math.max(...colour) - Math.min(...colour) > 20, `${name}: ${colour} is a grey`);
    }
    slices[Math.floor(hueOf(colours.from) / 30) % 12] += 1;
  }
  // Every twelfth of the wheel gets its share, give or take half: no colour for everyone.
  for (const n of slices) assert.ok(n > 2000 / 12 / 2 && n < (2000 / 12) * 2, `hues spread over the wheel: ${slices}`);

  // Opaque, the lighter end at the top left and the darker at the bottom right, whatever the shape.
  const { from, to } = palette("ada");
  for (const [w, h] of [[480, 480], [80, 80], [360, 480], [37, 91]]) {
    const out = new Uint8ClampedArray(w * h * 4);
    backdrop("ada", w, h, out);
    assert.deepEqual([...out.subarray(0, 4)], [...from, 255], `${w}×${h} top left`);
    assert.deepEqual([...out.subarray(out.length - 4)], [...to, 255], `${w}×${h} bottom right`);
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
  }

  // Both files fit what an upload may be, and the same name draws the same bytes.
  for (const name of ["ada", "tobi_k", "zzzzzzzzzzzzzzzz", "a_1"]) {
    const pic = await drawAvatar(name);
    assert.ok(pic.full.length <= SOCIAL_BYTES && pic.tiny.length <= TINY_BYTES, name);
    assert.deepEqual(jpegSize(pic.full), { w: 480, h: 480 });
    assert.deepEqual(jpegSize(pic.tiny), { w: 80, h: 80 });
    assert.ok((await drawAvatar(name)).full.equals(pic.full));
  }
});

test("Trending assets leave out stablecoins, tagged by Jupiter or not", () => {
  const token = (symbol: string, name: string, price: number, change24h: number, extra: Partial<TokenRecord> = {}) =>
    ({ mint: symbol, symbol, name, price, change24h, liquidity: 1e7, verified: true, priceAt: 0, checkedAt: 0, ...extra }) as TokenRecord;
  // Prices and moves from a real day's index, before the tags came in.
  const stable = [
    token("USDC", "USD Coin", 0.9998, -0.01),
    token("USDT", "USDT", 0.9994, -0.02),
    token("PYUSD", "PayPal USD", 1, -0.013),
    token("JupUSD", "Jupiter USD", 0.9997, 0.008),
    token("jlUSDC", "Jupiter Lend USDC", 1.0621, 0.002),
    token("EURC", "EURC", 1.1349, 0.3),
    token("VCHF", "VNX Swiss Franc", 1.2292, 0.1),
    token("CASH", "CASH", 0.9998, 0.012),
    token("JUICED", "JUICED", 1.039, 0),
    token("PRIME", "PRIME", 1.0618, -0.07),
    token("ANY", "Anything", 42, 5, { stable: true }),
  ];
  const traded = [
    token("SOL", "Wrapped SOL", 120.83, -0.22),
    token("JLP", "Jupiter Perps", 4.89, 0.02),
    token("JitoSOL", "Jito Staked SOL", 157.68, -0.04),
    token("BP", "Backpack", 1.2074, -9.09),
    token("SUI", "SUI", 1.183, 1.82),
    token("NEWx", "New xStock", 1.05, 0, { equity: true }),
  ];
  for (const rec of stable) assert.equal(isStable(rec), true, rec.symbol);
  for (const rec of traded) assert.equal(isStable(rec), false, rec.symbol);
});

test("every token is one kind, read off Jupiter's tags", () => {
  // Tags as Jupiter served them, verified and token-2022 left out.
  const cases: [string, string[], string[], TokenKind][] = [
    ["USDC", ["strict", "stable"], [], "stables"],
    ["jlUSDC", ["community-assist", "jup-lend-earn", "yb", "yield"], [], "stables"],
    ["ANTHROPIC", ["prestocks", "stocks", "rwa"], [], "stocks"],
    ["XAI", ["prestocks", "rwa"], [], "stocks"],
    ["NVDAx", ["moonshot-verified", "xstocks", "stocks", "rwa", "equities"], ["NVDA", "NVIDIA"], "stocks"],
    ["SPCX", ["stocks", "rwa", "backpack"], ["SpaceX"], "stocks"],
    ["XAUt0", ["rwa", "commodities"], [], "rwas"],
    ["PAXG", ["rwa"], [], "rwas"],
    ["SOL", ["community", "strict", "major"], ["SOL"], "majors"],
    ["LBTC", ["community-assist", "major", "yield"], [], "majors"],
    ["cbBTC", ["community", "moonshot-verified"], ["BTC"], "majors"],
    ["JitoSOL", ["original-lst", "strict", "yield", "community", "lst"], [], "defi"],
    ["xORCA", ["yield"], [], "defi"],
    ["TRUMP", ["birdeye-trending", "community", "moonshot-verified", "meme"], [], "memes"],
    ["JUP", ["defi", "birdeye-trending", "community", "strict"], [], "defi"],
    ["RENDER", ["infra", "community", "strict"], [], "defi"],
    ["ZEC", ["moonshot-verified"], [], "other"],
  ];
  for (const [symbol, tags, aliases, kind] of cases) assert.equal(tokenKind(tags, aliases, true), kind, symbol);
  // Anyone can call a token Wrapped BTC; only a verified one is taken at its word.
  assert.equal(tokenKind([], ["BTC"], false), "other");
});

test("the wallet page's lists: Trending is the busiest 5%, each kind all of itself, paged by cursor", () => {
  const token = (symbol: string, volume24h: number, extra: Partial<TokenRecord> = {}) =>
    ({ mint: `m-${symbol}`, symbol, name: symbol, price: 2, change24h: 3, volume24h, liquidity: 1e7, verified: true, priceAt: 0, checkedAt: 0, ...extra }) as TokenRecord;
  const kinds: TokenKind[] = ["memes", "stocks", "majors", "defi", "other"];
  const traded = Array.from({ length: 41 }, (_, i) => token(`T${i}`, 1000 - i * 10, { kind: kinds[i % kinds.length] }));
  // Two at the same volume, so the order has to fall back on the mint.
  traded.push(token("TIEb", 500, { kind: "memes" }), token("TIEa", 500, { kind: "memes" }));
  const usdc = token("USDC", 1e9, { price: 1, kind: "stables", stable: true });
  const order = [usdc, ...traded].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || (a.mint < b.mint ? -1 : 1));
  const lists = buildLists(order);

  // 43 traded, the stablecoin left out before the cut: 5% is 3, rounded up, busiest first.
  const trending = lists.get("trending")!;
  assert.equal(trending.length, 3);
  assert.deepEqual(trending.map((r) => r.symbol), order.slice(1, 4).map((r) => r.symbol));
  assert.ok(![...lists.values()].some((list) => list.includes(usdc)), "no stablecoin on any list");
  assert.equal(lists.get("memes")!.length, 11);
  assert.deepEqual(lists.get("rwas"), []);
  for (const [key, list] of lists) {
    if (key !== "trending") assert.ok(list.every((r) => r.kind === key), key);
  }

  // Page through memes three at a time: every row once, in order, and no cursor after the last.
  const memes = lists.get("memes")!;
  const seen: string[] = [];
  let after = "";
  for (let pages = 0; pages < 10; pages += 1) {
    const page = pageOf(memes, after, 3);
    assert.equal(page.total, 11);
    seen.push(...page.tokens.map((t) => t.symbol));
    if (!page.after) break;
    after = page.after;
  }
  assert.deepEqual(seen, memes.map((r) => r.symbol));
  assert.ok(seen.indexOf("TIEa") === seen.indexOf("TIEb") - 1, "ties ordered by mint");

  // A cursor names a place in the order, not an offset: after a rebuild drops
  // a row from the first page, the next page still starts where this one ended.
  const first = pageOf(memes, "", 3);
  const rebuilt = memes.filter((r) => r.symbol !== first.tokens[0].symbol);
  assert.equal(pageOf(rebuilt, first.after!, 3).tokens[0].symbol, memes[3].symbol);
  assert.deepEqual(pageOf(memes, "garbage", 3).tokens, []);
});

test("a swap that fails for want of SOL says so, with the amounts", () => {
  // A wallet that has never held SOL simulates as AccountNotFound.
  const empty = simulationError("AccountNotFound", [], { have: 0n, need: 2_100_000n, spendsSol: false });
  assert.equal(empty.status, 400);
  assert.equal(empty.extra.needsSol, true);
  assert.match(empty.message, /Not enough SOL for network fees.*0\.0021 SOL.*has 0 SOL/);

  // A failed wrap deep in the route is the same shortage.
  const wrap = simulationError(
    { InstructionError: [2, { Custom: 1 }] },
    ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports 100, need 2039280"],
    { have: 100n, need: 1_000_000n, spendsSol: true },
  );
  assert.match(wrap.message, /^Not enough SOL\. This trade needs about 0\.001 SOL/);

  const moved = simulationError(
    { InstructionError: [3, { Custom: 6001 }] },
    ["Program log: Error: custom program error: 0x1771"],
    { have: 5_000_000_000n, need: 10_000n, spendsSol: false },
  );
  assert.equal(moved.status, 409);
  assert.equal(moved.extra.requote, true);

  const other = simulationError({ InstructionError: [3, { Custom: 42 }] }, [], { have: 5_000_000_000n, need: 10_000n, spendsSol: false });
  assert.match(other.message, /would fail right now/);
});

test("an ad's link is https to a named host, and its words are one plain line", () => {
  assert.equal(adUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(adUrl(" https://Shop.Example.co.uk "), "https://shop.example.co.uk/");
  for (const bad of [
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "https://user:pw@example.com",
    "https://127.0.0.1/",
    "https://localhost/",
    "https://example.com:8443/",
    "example.com",
    `https://example.com/${"a".repeat(200)}`,
  ]) {
    assert.equal(adUrl(bad), null, bad);
  }
  assert.equal(adKeyword("  Solana   RPC! "), "solana rpc");
  assert.equal(adKeyword("Café, Zürich"), "café zürich");
  assert.equal(adKeyword("!!!"), null);
  assert.equal(adKeyword("a".repeat(41)), null);
  const text = adText("Fast‮ RPC\n<b>now</b>", 60);
  assert.deepEqual(text, { ok: true, text: "Fast RPC <b>now</b>" });
  assert.equal(adText("x".repeat(61), 60).ok, false);
});

test("a transfer names its order by reference, by memo, or by its exact amount", () => {
  const payTo = "PayeeWa11et1111111111111111111111111111111";
  const order = (id: string, at: number, lamports: number | null, usdc: number, memo = "UG-ABCDEFGH"): AdOrder => ({
    id, ad: "a", title: "T", reference: `Ref${id}`, memo, payTo, cents: 250, usdc, lamports, at, paidAt: null,
    signature: null, fund: null, received: null, payer: null, matched: null,
  });
  const usdc = (memo: string, before: string, after: string, err: unknown = null, owner = payTo): ParsedTx => ({
    meta: {
      err,
      preTokenBalances: [{ mint: USDC_MINT, owner, uiTokenAmount: { amount: before } }],
      postTokenBalances: [{ mint: USDC_MINT, owner, uiTokenAmount: { amount: after } }],
      innerInstructions: [],
    },
    transaction: { message: { accountKeys: [{ pubkey: "Payer" }], instructions: [{ program: "spl-token" }, { program: "spl-memo", parsed: memo }] } },
  });
  // What Phantom's scanner sent: a plain system transfer, no memo, no reference.
  const sol = (gained: number, to = payTo, extra: string[] = [], memo?: string): ParsedTx => ({
    meta: { err: null, preBalances: [9e9, 890_880, 1], postBalances: [9e9 - gained - 5000, 890_880 + gained, 1] },
    transaction: {
      message: {
        accountKeys: [{ pubkey: "Payer" }, { pubkey: to }, { pubkey: "11111111111111111111111111111111" }, ...extra.map((pubkey) => ({ pubkey }))],
        instructions: [{ program: "system" }, ...(memo ? [{ program: "spl-memo", parsed: memo }] : [])],
      },
    },
  });
  const now = Date.now();
  const first = order("o1", now - 60_000, 32_747_123, 2_500_042);
  const second = order("o2", now - 30_000, 32_747_456, 2_500_077);
  const open = [second, first];
  const one = (tx: ParsedTx, at = now) => transfersIn("sig", at, tx, payTo);

  const plain = one(sol(32_747_456));
  assert.equal(plain.length, 1);
  assert.deepEqual({ fund: plain[0].fund, received: plain[0].received, payer: plain[0].payer }, { fund: "sol", received: 32_747_456, payer: "Payer" });
  assert.deepEqual(matchTransfer(plain[0], open), { order: second, matched: "amount" }, "the exact amount names it");
  assert.equal(matchTransfer(one(sol(32_747_455))[0], open), null, "a lamport off names none");
  assert.equal(matchTransfer(one(sol(32_747_456), now - 3 * 60_000)[0], open), null, "made after the transfer");
  assert.deepEqual(matchTransfer(one(sol(40_000_000, payTo, ["Refo2"]))[0], open), { order: second, matched: "reference" });
  assert.deepEqual(matchTransfer(one(sol(40_000_000, payTo, [], "UG-ABCDEFGH"))[0], open), { order: first, matched: "memo" }, "the oldest it covers");
  assert.deepEqual(matchTransfer(one(sol(32_747_456, payTo, [], "UG-ABCDEFGH"))[0], open), { order: second, matched: "memo" }, "the one asking exactly this");
  assert.equal(matchTransfer(one(sol(1_000, payTo, [], "UG-ABCDEFGH"))[0], open), null, "the memo, but not the money");
  assert.deepEqual(one(sol(32_747_456, "Someone")), [], "paid elsewhere");
  assert.deepEqual(matchTransfer(one(usdc("", "1000000", "3500042"))[0], open), { order: first, matched: "amount" });
  assert.deepEqual(one(usdc("UG-ABCDEFGH", "1000000", "3500042", { InstructionError: [0, "x"] })), [], "failed");
  assert.deepEqual(one(usdc("UG-ABCDEFGH", "1000000", "3500042", null, "Someone")), []);
  assert.equal(matchTransfer(one(sol(32_747_123))[0], [{ ...first, lamports: null }]), null, "no SOL price, no SOL order");

  // An order's amount is its own: a mark under a cent, unlike every open order's.
  const taken = [{ usdc: 2_500_001, lamports: null }];
  for (let i = 0; i < 50; i++) {
    const amounts = orderAmounts(250, taken);
    assert.ok(amounts.usdc > 2_500_000 && amounts.usdc < 2_510_000, String(amounts.usdc));
    assert.notEqual(amounts.usdc, 2_500_001);
  }
  assert.equal(decimal(2_500_042, 6), "2.500042");
  assert.equal(decimal(52_341_000, 9), "0.052341");
  assert.equal(dollars(100), "1");
  assert.equal(dollars(1205), "12.05");
  const codes = orderCodes();
  assert.match(codes.memo, /^UG-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(base58Decode(codes.reference)?.length, 32);
  assert.match(payUrl(first, "sol"), /^solana:PayeeWa11et1+\?amount=0\.032747123&reference=Refo1&label=UtopianGO&message=UtopianGO%20ad&memo=UG-ABCDEFGH$/);
  assert.match(payUrl(first, "usdc"), /amount=2\.500042&spl-token=EPjF/);
});

test("an ad runs once paid: the higher bid first, on search and in timelines, each viewer charged once, until its budget is spent", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/social", socialRouter);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let ip = 0;
  async function join(name: string) {
    let jar = "";
    const call = async (method: string, urlPath: string, body?: Buffer | Record<string, unknown>, agent = "Mozilla/5.0 (Macintosh)") => {
      const headers: Record<string, string> = {
        Origin: base,
        Accept: "application/json",
        "User-Agent": agent,
        "X-Forwarded-For": `10.4.0.${++ip % 250}`,
      };
      if (jar) headers.Cookie = jar;
      if (body) headers["Content-Type"] = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
      const res = await fetch(base + urlPath, { method, headers, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
      for (const cookie of res.headers.getSetCookie?.() ?? []) jar = cookie.split(";")[0];
      const text = await res.text();
      return { status: res.status, json: JSON.parse(text) as Record<string, any>, text };
    };
    assert.equal((await call("POST", "/api/social/register", { username: name, password: "password1", terms: true })).status, 200);
    return call;
  }
  const packAd = (json: Record<string, unknown>, banner?: [Buffer, Buffer]) => {
    const text = Buffer.from(JSON.stringify(json));
    const head = Buffer.alloc(2);
    head.writeUInt16BE(text.length);
    if (!banner) return Buffer.concat([head, text]);
    const lens = Buffer.alloc(8);
    lens.writeUInt32BE(banner[0].length, 0);
    lens.writeUInt32BE(banner[1].length, 4);
    return Buffer.concat([head, text, lens, ...banner]);
  };
  const creative: AdCreative = { cta: "Try it", url: "https://rpc.example.com/", title: "Fast RPC", body: "Low latency.", devices: "all", bid: 1 };
  const visit = (who: string, agent = "Mozilla/5.0 (Macintosh)", extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { "user-agent": agent, ...extra };
    return { ip: who, get: (name: string) => headers[name.toLowerCase()] } as unknown as express.Request;
  };
  const save = (owner: string, id: string | null, over: Partial<AdCreative>, plan: { keyword: string; cents: number }[], keywords = plan.map((p) => p.keyword)) =>
    saveAd({
      id,
      owner,
      creative: { ...creative, ...over },
      keywords,
      plan,
      minimum: 100,
      banner: null,
      codes: orderCodes(),
      pay: plan.length ? { to: "Payee", usdc: plan.reduce((n, p) => n + p.cents, 0) * 10_000 + 7, lamports: 600_000 } : null,
      reuse: Date.now() - 15 * 60_000,
      at: Date.now(),
    });
  const paid = async (owner: string, over: Partial<AdCreative>, keywords: string[]) => {
    const { ad, order } = await save(owner, null, over, keywords.map((keyword) => ({ keyword, cents: 100 })));
    assert.ok(order);
    assert.equal(ad.status, "pending");
    assert.equal(order.memo, ad.memo, "the order carries its campaign's memo");
    assert.equal(order.usdc, order.cents * 10_000 + 7);
    assert.equal(order.payTo, "Payee");
    const proof = { signature: `sig-${order.id}`, fund: "sol" as const, received: 600_000, payer: "Payer", matched: "amount" as const };
    assert.equal(await payOrder(order.id, proof, Date.now()), true);
    assert.equal(await payOrder(order.id, proof, Date.now()), false, "credited once");
    return ad.id;
  };

  try {
    const amy = await join("amy");
    const ben = await join("ben");
    const cat = await join("cat");
    assert.deepEqual((await amy("GET", "/api/social/ads")).json.ads, []);

    // Every field through its validator, before anything is stored.
    const refused = async (over: Record<string, unknown>, why: RegExp) => {
      const res = await amy("POST", "/api/social/ads", packAd({ ...creative, banner: false, keywords: [{ keyword: "rpc", add: 100 }], ...over }));
      assert.equal(res.status, 400, res.text);
      assert.match(res.json.error, why);
    };
    await refused({ url: "javascript:alert(1)" }, /https/);
    await refused({ title: "" }, /^Title/);
    await refused({ bid: 0 }, /Bid/);
    await refused({ bid: 1.5 }, /Bid/);
    await refused({ devices: "tv" }, /where/);
    await refused({ keywords: [] }, /keyword/);
    await refused({ keywords: [{ keyword: "rpc", add: 150 }] }, /whole dollars/);
    await refused({ keywords: [{ keyword: "rpc", add: 100 }, { keyword: "RPC!", add: 100 }] }, /twice/);
    const wide = await amy("POST", "/api/social/ads", packAd({ ...creative, banner: true, keywords: [{ keyword: "rpc", add: 100 }] }, [jpeg(400, 400), jpeg(1200, 400)]));
    assert.equal(wide.status, 400);
    assert.match(wide.json.error, /3:1/);
    // Valid, but this server has nowhere to be paid: nothing is saved.
    const unpaid = await amy("POST", "/api/social/ads", packAd({ ...creative, banner: false, keywords: [{ keyword: "rpc", add: 100 }] }));
    assert.equal(unpaid.status, 503, unpaid.text);

    // A pending ad is not listed and not served; checking out again keeps its memo.
    const pending = await save("amy", null, {}, [{ keyword: "solana", cents: 100 }]);
    const again = await save("amy", pending.ad.id, {}, [{ keyword: "solana", cents: 200 }]);
    assert.equal(again.ad.memo, pending.ad.memo);
    assert.equal(again.order?.memo, pending.ad.memo);
    assert.notEqual(again.order?.id, pending.order?.id, "another budget, another order");
    const same = await save("amy", pending.ad.id, { title: "Retitled" }, [{ keyword: "solana", cents: 200 }]);
    assert.equal(same.order?.id, again.order?.id, "the same budget again: the same order, and the same code");
    assert.equal(same.ad.title, "Retitled");
    await assert.rejects(save("amy", null, {}, [], ["solana"]), /at least \$1/);

    const cheap = await paid("amy", { title: "Cheap" }, ["solana rpc"]);
    const dear = await paid("ben", { title: "Dear", bid: 2 }, ["solana"]);
    const phones = await paid("ben", { title: "Phones", devices: "mobile", bid: 5 }, ["wallet"]);
    await reloadAds();
    const listed = (await amy("GET", "/api/social/ads")).json;
    assert.equal(listed.ads.length, 1);
    assert.equal(listed.receipts, 3, "every checkout, paid or not");
    const receipts = (await amy("GET", "/api/social/ads/receipts")).json.receipts;
    assert.deepEqual(receipts.map((r: { status: string }) => r.status), ["paid", "open", "open"]);
    assert.equal(receipts[0].matched, "amount");
    assert.equal(receipts[0].signature, `sig-${receipts[0].id}`);
    assert.equal(receipts[0].urls, null);
    assert.match(receipts[1].urls.usdc, /^solana:Payee\?amount=2\.000007&spl-token=/);
    assert.equal(receipts[1].memo, pending.ad.memo);
    const reused = { signature: `sig-${receipts[0].id}`, fund: "sol" as const, received: 600_000, payer: "Payer", matched: "amount" as const };
    assert.equal(await payOrder(receipts[1].id, reused, Date.now()), false, "one transfer pays one order");
    assert.match(adFor(visit("1.1.1.1"), "SOLANA!"), />Dear</, "matched as words");
    assert.match(adFor(visit("1.1.1.1"), "best solana rpc"), />Dear</, "the higher bid first");
    assert.equal(adFor(visit("1.1.1.3"), "rpc"), "", "every word of a keyword");
    assert.equal(adFor(visit("1.1.1.4"), "wallet"), "", "a mobile ad, to a computer");
    assert.match(adFor(visit("1.1.1.5", "Mozilla/5.0 (iPhone)"), "wallet"), />Phones</);
    assert.equal(adFor(visit("1.1.1.6", "Googlebot/2.1"), "solana"), "", "no ads for crawlers");
    assert.ok(!adFor(visit("1.1.1.7"), "solana").includes("<img"), "search is words only");

    // Search put Dear on three pages, the same viewer twice: two impressions at 2¢.
    await flushAds();
    let ad = await getAd(dear);
    assert.deepEqual(ad?.keywords, [{ keyword: "solana", budget: 100, spent: 4, shown: 2, social: 0 }]);

    // Social: what someone last posted about that an ad matched picks their timeline's ad.
    assert.equal((await cat("GET", "/api/social/timeline")).json.ad, null, "nothing posted yet");
    assert.equal((await cat("POST", "/api/social/post", { text: "Loving Solana today" })).status, 200);
    const feed = await cat("GET", "/api/social/timeline");
    assert.equal(feed.json.ad.title, "Dear");
    assert.equal(feed.json.ad.owner, "ben");
    assert.equal(feed.json.ad.host, "rpc.example.com");
    assert.equal(feed.json.ad.img, "");
    assert.equal(Object.keys(feed.json.ad).includes("bid"), false, "only what the post draws");
    assert.equal((await cat("GET", `/api/social/timeline?before=${feed.json.posts[0].at}&id=${feed.json.posts[0].id}`)).json.ad, null, "first page only");
    assert.equal((await cat("GET", "/api/social/timeline?saved=1")).json.ad, null, "not among saved posts");
    // A post no ad matches leaves the topic as it was.
    const sql = new Client({ connectionString: process.env.DATABASE_URL });
    await sql.connect();
    await sql.query("UPDATE users SET last_post = 0 WHERE name = 'cat'");
    await sql.end();
    assert.equal((await cat("POST", "/api/social/post", { text: "Just coffee" })).status, 200);
    assert.equal((await cat("GET", "/api/social/timeline")).json.ad.title, "Dear");
    assert.match((await cat("GET", "/api/social/timeline", undefined, "Mozilla/5.0 (iPhone)")).json.ad.title, /Dear/);
    // Your own ad shows where it runs, and your looking costs it nothing: ben's Dear outbids amy's Cheap.
    assert.equal((await ben("POST", "/api/social/post", { text: "solana rpc tips" })).status, 200);
    assert.equal((await ben("GET", "/api/social/timeline")).json.ad.title, "Dear");
    // cat saw Dear on three timelines, on two devices: one viewer, signed in, so one impression.
    await flushAds();
    ad = await getAd(dear);
    assert.deepEqual(ad?.keywords, [{ keyword: "solana", budget: 100, spent: 6, shown: 3, social: 1 }]);

    // Spend the rest; then the 1¢ ad is the one left.
    for (let i = 0; i < 47; i++) assert.match(adFor(visit(`2.0.0.${i}`), "solana rpc"), />Dear</);
    assert.match(adFor(visit("2.0.1.0"), "solana rpc"), />Cheap</);
    await flushAds();
    ad = await getAd(dear);
    assert.equal(ad?.keywords[0].spent, 100, "never past the budget");
    assert.equal(ad?.keywords[0].shown, 50);

    // A script cycling user agents from one address is five viewers at most;
    // an <img> pointed at a results page, and a prefetch, show the ad to no one.
    for (let i = 0; i < 10; i++) assert.match(adFor(visit("4.0.0.1", `Mozilla/5.0 (Macintosh) v${i}`), "solana rpc"), />Cheap</);
    assert.match(adFor(visit("5.0.0.1", undefined, { "sec-fetch-dest": "image" }), "solana rpc"), />Cheap</);
    assert.match(adFor(visit("5.0.0.2", undefined, { "sec-fetch-dest": "document", "sec-purpose": "prefetch;prerender" }), "solana rpc"), />Cheap</);
    assert.match(adFor(visit("5.0.0.3", undefined, { "sec-fetch-dest": "document" }), "solana rpc"), />Cheap</);
    await flushAds();
    assert.equal((await getAd(cheap))?.keywords[0].shown, 1 + 5 + 1);

    // Paid budget stays: words change at once, a keyword with budget left cannot go.
    const edit = (json: Record<string, unknown>) => amy("POST", `/api/social/ads/${cheap}`, packAd({ ...creative, banner: false, ...json }));
    const kept = await edit({ keywords: [{ keyword: "solana", add: 0 }] });
    assert.equal(kept.status, 400);
    assert.match(kept.json.error, /budget left/);
    const xss = await edit({ title: '<img src=x onerror="alert(1)">', keywords: [{ keyword: "solana rpc", add: 0 }] });
    assert.equal(xss.status, 200, xss.text);
    assert.equal(xss.json.order, null);
    assert.equal(xss.json.ad.title, '<img src=x onerror="alert(1)">', "stored as written");
    const shown = adFor(visit("3.0.0.1"), "solana rpc");
    assert.ok(shown.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), shown);
    assert.ok(!shown.includes("<img src=x"));
    assert.equal((await amy("GET", `/api/social/ads/${dear}`)).status, 404, "someone else's");
    assert.equal((await amy("GET", `/api/social/ads/${pending.ad.id}`)).status, 404, "not paid");
    assert.equal((await amy("POST", `/api/social/ads/${dear}`, packAd({ ...creative, banner: false, keywords: [{ keyword: "solana", add: 0 }] }))).status, 404);
    assert.ok(phones);
    const markup = adMarkup({ cta: "Go", title: "T", body: "B", url: "https://a.example.com/$&" });
    assert.ok(markup.includes('href="https://a.example.com/&#36;&amp;"'), markup);
  } finally {
    server.close();
  }
});

test("a $ticker is called out once, at its price when posted, and never an amount or part of a word", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const listed: Record<string, TokenQuote> = {
    SOL: { mint: SOL, symbol: "SOL", name: "Wrapped SOL", price: 150.25 },
    // Another ticker for the same mint, as an alias puts it there.
    WSOL: { mint: SOL, symbol: "SOL", name: "Wrapped SOL", price: 150.25 },
    BONK: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "Bonk", name: "Bonk", price: 0.00002113 },
    GO: { mint: "GoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGoGo11", symbol: "GO", name: "Go", price: 2 },
    WIF: { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", name: "dogwifhat", price: 1.5 },
    FREE: { mint: "FreeFreeFreeFreeFreeFreeFreeFreeFreeFree1111", symbol: "FREE", name: "No price", price: 0 },
  };
  const asked: string[] = [];
  // What the store's lookupToken does with it: a `$` query, matched case-blind.
  const quote = (q: string) => {
    asked.push(q);
    assert.ok(q.startsWith("$"), "asked as an explicit ticker, so stopwords like $GO get through");
    return listed[q.slice(1).toUpperCase()] ?? null;
  };
  const symbols = (text: string) => calloutsIn(text, quote).map((c) => c.symbol);

  assert.deepEqual(calloutsIn("$SOL to the moon", quote), [{ mint: SOL, symbol: "SOL", price: 150.25, tickers: ["SOL"] }]);
  assert.deepEqual(symbols("$sol, $SOL's run, and $WSOL too."), ["SOL"], "one card a mint, however it is named");
  assert.deepEqual(calloutsIn("$sol, $SOL's run, and $WSOL too.", quote)[0].tickers, ["SOL", "WSOL"], "each ticker that came to it, once");
  assert.deepEqual(symbols("$5 or $100k, US$20, a$SOL, $$SOL, $S"), [], "amounts, words, $$ and one letter are text");
  assert.deepEqual(symbols("$NOPE $FREE $BONK"), ["Bonk"], "unknown or unpriced is left as text");
  assert.equal(MAX_CALLOUTS, 3);
  assert.deepEqual(symbols("$GO $BONK $WIF $SOL"), ["GO", "Bonk", "WIF"], "the first three, in the order named");
  asked.length = 0;
  calloutsIn("$GO $BONK $WIF $SOL $NOPE", quote);
  assert.equal(asked.length, 3, "nothing past the third is looked up");
  assert.deepEqual(symbols("$ABCDEFGHIJKLM"), [], "longer than a ticker is not one");

  // A draft's preview: the same cards, and which tickers went where, for the composer to colour.
  const draft = resolveTickers(["go", "NOPE", "Bonk", "WIF", "GO", "SOL"], quote);
  assert.deepEqual(draft.calls.map((c) => c.symbol), ["GO", "Bonk", "WIF"]);
  assert.deepEqual(draft.named, { GO: listed.GO.mint, BONK: listed.BONK.mint, WIF: listed.WIF.mint }, "not $NOPE, and nothing past the third card");
  assert.ok(isTicker("SOL") && isTicker("a1") && !isTicker("1A") && !isTicker("S") && !isTicker("SOL,") && !isTicker("ABCDEFGHIJKLM"));
});

test("a called-out ticker rides its post to the timeline, the post page, a profile and a re-post", async () => {
  await useTestDatabase();
  await ensureSchema();
  await resetSocial();
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/social", socialRouter);
  app.use(apiRouter);
  const server: Server = await new Promise((resolve) => {
    const listening = createServer(app);
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let ip = 0;

  async function join(name: string) {
    let jar = "";
    const call = async (method: string, urlPath: string, body?: Record<string, unknown>) => {
      const headers: Record<string, string> = { Origin: base, Accept: "application/json", "X-Forwarded-For": `10.3.0.${++ip % 250}` };
      if (jar) headers.Cookie = jar;
      if (body) headers["Content-Type"] = "application/json";
      const res = await fetch(base + urlPath, { method, headers, body: body && JSON.stringify(body) });
      for (const cookie of res.headers.getSetCookie?.() ?? []) jar = cookie.split(";")[0];
      const text = await res.text();
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    };
    assert.equal((await call("POST", "/api/social/register", { username: name, password: "password1", terms: true })).status, 200);
    return call;
  }

  try {
    const amy = await join("amy");
    const bob = await join("bob");
    // A sub-cent price keeps every digit through jsonb and back.
    const coins = [
      { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", price: 150.25, tickers: ["SOL"] },
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "Bonk", price: 0.00002113, tickers: ["BONK"] },
    ];
    const made = await createPost("amy", "$SOL and $BONK", Date.now() - 1000, [], null, coins);
    assert.ok(!("wait" in made));
    assert.deepEqual(made.coins, coins);
    // With no index to look in (tests start none), a ticker is only text.
    const plain = await bob("POST", "/api/social/post", { text: "$SOL soon" });
    assert.equal(plain.status, 200, plain.text);
    assert.deepEqual(plain.json?.post.coins, []);

    const feed = await bob("GET", "/api/social/timeline");
    const byText = (posts: { text: string; repost: string | null; coins: unknown }[], text: string) =>
      posts.filter((p) => p.text === text && !p.repost);
    assert.deepEqual(byText(feed.json?.posts, "$SOL and $BONK")[0]?.coins, coins);
    assert.deepEqual(byText(feed.json?.posts, "$SOL soon")[0]?.coins, []);
    assert.deepEqual((await bob("POST", "/api/social/open", { post: made.id })).json?.post.coins, coins);
    assert.deepEqual((await bob("GET", "/api/social/u/amy")).json?.user.posts[0].coins, coins);

    // A re-post shows the original's tickers, at the original's prices.
    assert.equal((await bob("POST", "/api/social/repost", { post: made.id })).status, 200);
    const after = await amy("GET", "/api/social/timeline");
    const shared = (after.json?.posts as { repost: string | null; coins: unknown }[]).find((p) => p.repost === made.id);
    assert.deepEqual(shared?.coins, coins);

    // The price now is asked for separately, by mint, from memory.
    assert.equal((await amy("GET", "/api/quotes")).status, 400);
    assert.equal((await amy("GET", "/api/quotes?m=not-a-mint")).status, 400);
    assert.equal((await amy("GET", `/api/quotes?m=${Array(61).fill(coins[0].mint).join(",")}`)).status, 400);
    const quotes = await amy("GET", `/api/quotes?m=${coins.map((c) => c.mint).join(",")}`);
    assert.equal(quotes.status, 200, quotes.text);
    assert.deepEqual(quotes.json, { tokens: [] }, "nothing indexed, so no card");

    // A draft sends its tickers, never its words.
    assert.equal((await amy("GET", "/api/callouts")).status, 400);
    assert.equal((await amy("GET", "/api/callouts?t=I%20love%20SOL")).status, 400);
    assert.equal((await amy("GET", `/api/callouts?t=${Array(21).fill("SOL").join(",")}`)).status, 400);
    const draft = await amy("GET", "/api/callouts?t=SOL,BONK");
    assert.equal(draft.status, 200, draft.text);
    assert.deepEqual(draft.json, { tokens: [], named: {} }, "nothing indexed, so nothing blue");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
