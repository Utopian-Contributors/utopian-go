import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  pbkdf2Sync,
  randomBytes,
  sign,
} from "crypto";
import { WORDLIST } from "./wordlist";

/**
 * A profile is a Solana account.
 *
 * The phrase is a 12-word BIP39 mnemonic. The address is that mnemonic run
 * through SLIP-0010 ed25519 at m/44'/501'/0'/0' — the path Phantom and
 * `solana-keygen prompt://?key=0/0` both use — so the phrase opens this exact
 * account in a normal wallet. The private key is not stored. The phrase is,
 * encrypted, and the address is derived once at registration.
 */

const HARDENED = 0x80000000;

/** PKCS#8 prefix that wraps a 32-byte ed25519 seed. */
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function mnemonicFromEntropy(entropy: Buffer): string {
  if (entropy.length !== 16) throw new Error("mnemonic entropy must be 128 bits");
  const checksumBits = entropy.length / 4;
  const checksum = createHash("sha256").update(entropy).digest()[0] >> (8 - checksumBits);
  let bits = 0n;
  for (const byte of entropy) bits = (bits << 8n) | BigInt(byte);
  bits = (bits << BigInt(checksumBits)) | BigInt(checksum);
  const words: string[] = [];
  for (let i = 11; i >= 0; i--) {
    words.push(WORDLIST[Number((bits >> BigInt(i * 11)) & 2047n)]);
  }
  return words.join(" ");
}

/**
 * A typed-in phrase as the words `mnemonicFromEntropy` would have produced,
 * or null. Case and spacing are forgiven; a wrong word or a failed checksum
 * is not, so a typo reads as a typo rather than as an unknown account.
 */
export function normalizeMnemonic(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 400) return null;
  const words = input.toLowerCase().trim().split(/\s+/);
  if (words.length !== 12) return null;
  let bits = 0n;
  for (const word of words) {
    const i = WORDLIST.indexOf(word);
    if (i < 0) return null;
    bits = (bits << 11n) | BigInt(i);
  }
  const entropy = Buffer.alloc(16);
  let rest = bits >> 4n;
  for (let i = 15; i >= 0; i--) {
    entropy[i] = Number(rest & 255n);
    rest >>= 8n;
  }
  const phrase = words.join(" ");
  return mnemonicFromEntropy(entropy) === phrase ? phrase : null;
}

export function generateMnemonic(): string {
  return mnemonicFromEntropy(randomBytes(16));
}

/** BIP39 seed. Empty passphrase, which is what a wallet import assumes. */
export function mnemonicToSeed(mnemonic: string): Buffer {
  return pbkdf2Sync(mnemonic.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
}

function hmac512(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha512", key).update(data).digest();
}

/**
 * SLIP-0010 hardened derivation for ed25519.
 *
 * Ed25519 has no non-hardened children. Every index here is expected to
 * already include the hardened offset; the Solana path is four of them.
 */
export function slip10ed25519(seed: Buffer, indexes: number[]): Buffer {
  const master = hmac512(Buffer.from("ed25519 seed"), seed);
  let key = master.subarray(0, 32);
  let chain = master.subarray(32);
  for (const index of indexes) {
    const data = Buffer.alloc(37);
    data[0] = 0;
    key.copy(data, 1);
    data.writeUInt32BE(index >>> 0, 33);
    const next = hmac512(chain, data);
    key = next.subarray(0, 32);
    chain = next.subarray(32);
  }
  return Buffer.from(key);
}

/** Raw 32-byte ed25519 public key from a 32-byte seed. */
export function ed25519Public(seed: Buffer): Buffer {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8, seed]),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

export function signEd25519(seed: Buffer, message: Buffer): Buffer {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  return sign(null, message, key);
}

export function base58(bytes: Buffer): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = n % 58n;
    n /= 58n;
    out = B58[Number(r)] + out;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Inverse of `base58`. Null when a character is outside the alphabet. */
export function base58Decode(text: string): Buffer | null {
  if (!text || text.length > 88) return null;
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

/** m/44'/501'/0'/0' — account 0, change 0, both hardened. */
const SOLANA_PATH = [44, 501, 0, 0].map((i) => i + HARDENED);

export function solanaSeed(mnemonic: string): Buffer {
  return slip10ed25519(mnemonicToSeed(mnemonic), SOLANA_PATH);
}

export function solanaAddress(mnemonic: string): string {
  const seed = solanaSeed(mnemonic);
  try {
    return base58(ed25519Public(seed));
  } finally {
    seed.fill(0);
  }
}
