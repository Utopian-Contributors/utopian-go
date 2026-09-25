import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "crypto";

/**
 * Passkey as a second factor.
 *
 * Registration and assertion are checked here with node:crypto. Attestation
 * statements are not: the ceremony runs only after a password login, on a
 * session that already belongs to the account, and we asked the authenticator
 * for `none`. What still has to be true is the challenge, the origin, the
 * rpId hash, and the signature over authenticatorData || sha256(clientData).
 */

type Cbor = Map<unknown, unknown> | Buffer | string | number | boolean | null | Cbor[];

export function decodeCbor(buf: Buffer, at = 0): { value: Cbor; offset: number } {
  if (at >= buf.length) throw new Error("cbor");
  const ib = buf[at];
  const major = ib >> 5;
  const ai = ib & 31;
  let offset = at + 1;
  let n = 0;
  if (ai < 24) n = ai;
  else if (ai === 24) n = buf[offset++];
  else if (ai === 25) {
    n = buf.readUInt16BE(offset);
    offset += 2;
  } else if (ai === 26) {
    n = buf.readUInt32BE(offset);
    offset += 4;
  } else throw new Error("cbor");

  if (major === 0) return { value: n, offset };
  if (major === 1) return { value: -1 - n, offset };
  // subarray clamps silently; a length past the end is malformed, not short.
  if ((major === 2 || major === 3) && offset + n > buf.length) throw new Error("cbor");
  if (major === 2) return { value: buf.subarray(offset, offset + n), offset: offset + n };
  if (major === 3) {
    return { value: buf.subarray(offset, offset + n).toString("utf8"), offset: offset + n };
  }
  if (major === 4) {
    const arr: Cbor[] = [];
    for (let i = 0; i < n; i++) {
      const item = decodeCbor(buf, offset);
      arr.push(item.value);
      offset = item.offset;
    }
    return { value: arr, offset };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < n; i++) {
      const k = decodeCbor(buf, offset);
      const v = decodeCbor(buf, k.offset);
      map.set(k.value, v.value);
      offset = v.offset;
    }
    return { value: map, offset };
  }
  if (major === 6) return decodeCbor(buf, offset);
  if (major === 7 && (ai === 20 || ai === 21 || ai === 22)) {
    return { value: ai === 21 ? true : ai === 20 ? false : null, offset };
  }
  throw new Error("cbor");
}

function mapOf(value: Cbor): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error("cbor map");
  return value;
}

const P256_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const ED_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function coseKey(cose: Buffer): { key: KeyObject; alg: number } {
  const { value } = decodeCbor(cose, 0);
  const map = mapOf(value);
  const kty = map.get(1);
  const alg = map.get(3);
  const crv = map.get(-1);
  const x = map.get(-2);
  if (!Buffer.isBuffer(x)) throw new Error("cose");
  if (kty === 2 && alg === -7 && crv === 1) {
    const y = map.get(-3);
    if (!Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error("cose");
    const key = createPublicKey({
      key: Buffer.concat([P256_PREFIX, Buffer.from([0x04]), x, y]),
      format: "der",
      type: "spki",
    });
    return { key, alg: -7 };
  }
  if (kty === 1 && alg === -8 && crv === 6 && x.length === 32) {
    const key = createPublicKey({
      key: Buffer.concat([ED_PREFIX, x]),
      format: "der",
      type: "spki",
    });
    return { key, alg: -8 };
  }
  throw new Error("cose");
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function clientData(
  raw: Buffer,
  type: string,
  challenge: Buffer,
  origin: string,
): void {
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("clientData");
  }
  if (parsed.type !== type || parsed.origin !== origin) throw new Error("clientData");
  if (typeof parsed.challenge !== "string") throw new Error("clientData");
  let got: Buffer;
  try {
    got = Buffer.from(parsed.challenge, "base64url");
  } catch {
    throw new Error("clientData");
  }
  if (!same(got, challenge)) throw new Error("clientData");
}

function checkRp(auth: Buffer, rpId: string, needAttested: boolean): {
  flags: number;
  count: number;
  rest: Buffer;
} {
  if (auth.length < 37) throw new Error("authData");
  const rpHash = createHash("sha256").update(rpId).digest();
  if (!same(auth.subarray(0, 32), rpHash)) throw new Error("rpId");
  const flags = auth[32];
  // User presence and verification. We asked for verification, so both are due.
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error("flags");
  if (needAttested && (flags & 0x40) === 0) throw new Error("flags");
  const count = auth.readUInt32BE(33);
  return { flags, count, rest: auth.subarray(37) };
}

export interface RegisteredKey {
  id: string;
  cose: string;
  alg: number;
  count: number;
}

export function verifyRegistration(opts: {
  clientData: Buffer;
  attestation: Buffer;
  id: string;
  challenge: Buffer;
  origin: string;
  rpId: string;
}): RegisteredKey {
  clientData(opts.clientData, "webauthn.create", opts.challenge, opts.origin);
  const { value } = decodeCbor(opts.attestation, 0);
  const map = mapOf(value);
  const auth = map.get("authData");
  if (!Buffer.isBuffer(auth)) throw new Error("attestation");
  const parsed = checkRp(auth, opts.rpId, true);
  if (parsed.rest.length < 18) throw new Error("authData");
  const credLen = parsed.rest.readUInt16BE(16);
  const credStart = 18;
  if (parsed.rest.length < credStart + credLen) throw new Error("authData");
  const credId = parsed.rest.subarray(credStart, credStart + credLen);
  if (credId.toString("base64url") !== opts.id) throw new Error("id");
  const coseBuf = parsed.rest.subarray(credStart + credLen);
  const decoded = decodeCbor(coseBuf, 0);
  const cose = Buffer.from(coseBuf.subarray(0, decoded.offset));
  const key = coseKey(cose);
  return {
    id: opts.id,
    cose: cose.toString("base64url"),
    alg: key.alg,
    count: parsed.count,
  };
}

/**
 * Returns the counter to store.
 *
 * A counter of zero is an authenticator that does not count (platform
 * passkeys often don't). Any other counter has to move forward, which is
 * the only clone signal the ceremony gives us.
 */
export function verifyAssertion(opts: {
  clientData: Buffer;
  authData: Buffer;
  signature: Buffer;
  cose: Buffer;
  challenge: Buffer;
  origin: string;
  rpId: string;
  prevCount: number;
}): number {
  clientData(opts.clientData, "webauthn.get", opts.challenge, opts.origin);
  const parsed = checkRp(opts.authData, opts.rpId, false);
  if (parsed.count !== 0 && parsed.count <= opts.prevCount) throw new Error("counter");
  const { key, alg } = coseKey(opts.cose);
  const signed = Buffer.concat([
    opts.authData,
    createHash("sha256").update(opts.clientData).digest(),
  ]);
  const ok =
    alg === -7
      ? verify("sha256", signed, key, opts.signature)
      : verify(null, signed, key, opts.signature);
  if (!ok) throw new Error("signature");
  return parsed.count === 0 ? opts.prevCount : parsed.count;
}
