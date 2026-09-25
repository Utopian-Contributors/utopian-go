import { HELIUS_RPC_URL } from "../config";
import { SocialError } from "./limits";
import { base58Decode } from "./keys";

/** At most a million SOL, and at most 9 decimal places. Zero is not a payment. */
export function parseSol(input: unknown): bigint | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!/^\d{1,7}(\.\d{1,9})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt((frac + "000000000").slice(0, 9));
  if (lamports <= 0n || lamports > 1_000_000n * 1_000_000_000n) return null;
  return lamports;
}

export function solanaPubkey(text: string): Buffer | null {
  const raw = base58Decode(text.trim());
  return raw && raw.length === 32 ? raw : null;
}

function shortvec(n: number): Buffer {
  const out: number[] = [];
  let left = n;
  while (true) {
    let elem = left & 0x7f;
    left >>= 7;
    if (left === 0) {
      out.push(elem);
      break;
    }
    out.push(elem | 0x80);
  }
  return Buffer.from(out);
}

/** Legacy message: one signer pays `lamports` to `to` through the system program. */
export function transferMessage(from: Buffer, to: Buffer, lamports: bigint, blockhash: Buffer): Buffer {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return Buffer.concat([
    Buffer.from([1, 0, 1]),
    shortvec(3),
    from,
    to,
    Buffer.alloc(32),
    blockhash,
    shortvec(1),
    Buffer.from([2]),
    shortvec(2),
    Buffer.from([0, 1]),
    shortvec(data.length),
    data,
  ]);
}

/** The wire format with an empty signature for the wallet to fill in. */
export function unsignedTransfer(from: Buffer, to: Buffer, lamports: bigint, blockhash: Buffer): Buffer {
  const message = transferMessage(from, to, lamports, blockhash);
  return Buffer.concat([shortvec(1), Buffer.alloc(64), message]);
}

export async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (!HELIUS_RPC_URL) throw new SocialError(503, "Payments are not available.");
  let body: { result?: unknown; error?: { message?: string } };
  try {
    const res = await fetch(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new SocialError(503, "Payments are not available.");
  }
  if (body.error) {
    const message = body.error.message || "";
    if (/rent/i.test(message)) {
      throw new SocialError(
        400,
        "Every Solana account must keep about 0.001 SOL. Send more SOL, or leave more in this wallet.",
      );
    }
    if (/insufficient/i.test(message)) throw new SocialError(400, "Not enough SOL in this wallet.");
    throw new SocialError(400, "The transaction was not sent.");
  }
  return body.result;
}

/**
 * An unsigned transfer. The wallet signs and broadcasts it.
 * This process never sees a key.
 */
export async function prepareTransfer(from: Buffer, to: Buffer, lamports: bigint): Promise<Buffer> {
  const latest = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
    value?: { blockhash?: string };
  };
  const blockhash = base58Decode(latest?.value?.blockhash || "");
  if (!blockhash || blockhash.length !== 32) throw new SocialError(503, "Payments are not available.");
  return unsignedTransfer(from, to, lamports, blockhash);
}
