import { createHash } from "crypto";
import { base58, base58Decode, signEd25519, solanaSeed } from "./keys";
import { SocialError } from "./limits";
import { rpc } from "./pay";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM = Buffer.alloc(32);
const TOKEN = base58Decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")!;
const TOKEN_2022 = base58Decode("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")!;
const ATA_PROGRAM = base58Decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")!;

const P = 2n ** 255n - 19n;

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const D = (((-121665n * modPow(121666n, P - 2n)) % P) + P) % P;

/** Whether 32 bytes decode to a point on ed25519. A program address must not. */
export function onCurve(bytes: Buffer): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modPow(v, P - 2n)) % P;
  if (x2 === 0n) return !(bytes[31] & 0x80);
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

export function programAddress(seeds: Buffer[], program: Buffer): Buffer {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from("ProgramDerivedAddress")]))
      .digest();
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no program address");
}

export function associatedTokenAccount(owner: Buffer, mint: Buffer, tokenProgram: Buffer): Buffer {
  return programAddress([owner, tokenProgram, mint], ATA_PROGRAM);
}

function shortvec(n: number): Buffer {
  const out: number[] = [];
  let left = n;
  for (;;) {
    const low = left & 0x7f;
    left >>= 7;
    if (!left) {
      out.push(low);
      return Buffer.from(out);
    }
    out.push(low | 0x80);
  }
}

interface Meta {
  key: Buffer;
  signer: boolean;
  writable: boolean;
}
interface Instruction {
  program: Buffer;
  keys: Meta[];
  data: Buffer;
}

/** A legacy message with `payer` as the only signer. */
export function compileMessage(payer: Buffer, instructions: Instruction[], blockhash: Buffer): Buffer {
  const metas = new Map<string, Meta>();
  const add = (m: Meta) => {
    const id = m.key.toString("hex");
    const had = metas.get(id);
    if (had) {
      had.signer ||= m.signer;
      had.writable ||= m.writable;
    } else metas.set(id, { ...m });
  };
  add({ key: payer, signer: true, writable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) add(k);
    add({ key: ix.program, signer: false, writable: false });
  }
  const rank = (m: Meta) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
  const list = [...metas.values()].sort((a, b) => (a.key.equals(payer) ? -1 : b.key.equals(payer) ? 1 : rank(a) - rank(b)));
  if (list.filter((m) => m.signer).length !== 1) throw new Error("one signer only");
  const index = (key: Buffer) => list.findIndex((m) => m.key.equals(key));
  const readonlyUnsigned = list.filter((m) => !m.signer && !m.writable).length;
  return Buffer.concat([
    Buffer.from([1, 0, readonlyUnsigned]),
    shortvec(list.length),
    ...list.map((m) => m.key),
    blockhash,
    shortvec(instructions.length),
    ...instructions.map((ix) =>
      Buffer.concat([
        Buffer.from([index(ix.program)]),
        shortvec(ix.keys.length),
        Buffer.from(ix.keys.map((k) => index(k.key))),
        shortvec(ix.data.length),
        ix.data,
      ]),
    ),
  ]);
}

function lamportsData(lamports: bigint): Buffer {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return data;
}

async function blockhash(): Promise<Buffer> {
  const latest = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: string } };
  const hash = base58Decode(latest?.value?.blockhash || "");
  if (!hash || hash.length !== 32) throw new SocialError(503, "Sending is not available right now.");
  return hash;
}

/** The mint's token program and decimals, read from the chain. */
async function mintInfo(mint: Buffer): Promise<{ program: Buffer; decimals: number }> {
  const info = (await rpc("getAccountInfo", [base58(mint), { encoding: "base64" }])) as {
    value?: { owner?: string; data?: [string, string] };
  };
  const owner = base58Decode(info?.value?.owner || "");
  const data = Buffer.from(info?.value?.data?.[0] || "", "base64");
  if (!owner || (!owner.equals(TOKEN) && !owner.equals(TOKEN_2022)) || data.length < 45) {
    throw new SocialError(400, "That is not a token we can send.");
  }
  return { program: owner, decimals: data[44] };
}

/**
 * Build the instructions for sending `amount` base units of `mint` (or SOL) to
 * `to`. An SPL send opens the recipient's token account first, paid by the
 * sender, so a fresh wallet can receive anything.
 */
export async function sendInstructions(from: Buffer, to: Buffer, mint: string, amount: bigint): Promise<Instruction[]> {
  if (mint === SOL_MINT) {
    return [
      {
        program: SYSTEM,
        keys: [
          { key: from, signer: true, writable: true },
          { key: to, signer: false, writable: true },
        ],
        data: lamportsData(amount),
      },
    ];
  }
  const mintKey = base58Decode(mint)!;
  const { program, decimals } = await mintInfo(mintKey);
  const source = associatedTokenAccount(from, mintKey, program);
  const dest = associatedTokenAccount(to, mintKey, program);
  const transfer = Buffer.alloc(10);
  transfer[0] = 12;
  transfer.writeBigUInt64LE(amount, 1);
  transfer[9] = decimals;
  return [
    {
      program: ATA_PROGRAM,
      keys: [
        { key: from, signer: true, writable: true },
        { key: dest, signer: false, writable: true },
        { key: to, signer: false, writable: false },
        { key: mintKey, signer: false, writable: false },
        { key: SYSTEM, signer: false, writable: false },
        { key: program, signer: false, writable: false },
      ],
      data: Buffer.from([1]),
    },
    {
      program,
      keys: [
        { key: source, signer: false, writable: true },
        { key: mintKey, signer: false, writable: false },
        { key: dest, signer: false, writable: true },
        { key: from, signer: true, writable: false },
      ],
      data: transfer,
    },
  ];
}

export async function sendFor(
  owner: string,
  phrase: string,
  p: { to: Buffer; mint: string; amount: bigint },
): Promise<{ signature: string }> {
  const from = base58Decode(owner)!;
  const message = compileMessage(from, await sendInstructions(from, p.to, p.mint, p.amount), await blockhash());
  const seed = solanaSeed(phrase);
  let signature: Buffer;
  try {
    signature = signEd25519(seed, message);
  } finally {
    seed.fill(0);
  }
  const tx = Buffer.concat([shortvec(1), signature, message]);
  const sent = await rpc("sendTransaction", [
    tx.toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
  if (typeof sent !== "string") throw new SocialError(502, "The transaction was not sent.");
  return { signature: sent };
}
