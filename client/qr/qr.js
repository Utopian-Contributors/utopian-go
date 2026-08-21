/**
 * A QR encoder scoped to exactly one job: turning a trade URL into an inline
 * SVG for the buy dialog.
 *
 * The npm `qrcode` package costs 9,674 B gzip in a browser bundle. swap.js is
 * 8,709 B. Adding a general-purpose encoder to draw one code would have more
 * than doubled the bundle a visitor waits on after pressing Buy — so instead of
 * a library we ship the subset the payload actually reaches, in a bundle of its
 * own that only someone who asks for a code ever fetches.
 *
 * Three cuts do almost all of the work, and each one is forced by the payload
 * rather than chosen for convenience:
 *
 * 1. BYTE MODE ONLY. The payload is `<origin>/?q=<symbol>&buy=<mint>`, and the
 *    mint is base58 — the alphabet Solana writes addresses in, which includes
 *    the full lowercase run `a-z`. QR's alphanumeric mode is a 45-character
 *    uppercase set, so 25 of base58's 58 characters fall outside it and any
 *    real mint forces byte mode on its own; the lowercase in `https` and in the
 *    parameter names would force it again. That is the *expensive* mode per
 *    character (8 bits vs 5.5) and the *cheapest* mode to implement, so the
 *    constraint that makes our symbols bigger is the same one that deletes
 *    numeric, alphanumeric, Kanji, ECI, the mode-detection regexes and the
 *    whole segment optimiser. Measured against `qrcode`'s own optimiser:
 *    splitting these payloads into mixed segments never once lowered the
 *    version, so the optimiser and its `dijkstrajs` dependency buy nothing.
 *
 * 2. ONE ECC LEVEL (M). See ECC_NOTE below.
 *
 * 3. VERSIONS 1-13 ONLY. See VERSION_NOTE below.
 *
 * What is NOT cut: Reed-Solomon, real format-info bits, and real mask selection
 * across all eight masks with all four penalty rules. Those are what make a
 * symbol scan; they are not where the bytes were. Verified bit-identical to
 * `qrcode@1.5.4` at the same mask across 3,000 payloads, and decoded back by
 * two independent decoders (jsQR and ZXing).
 */

/**
 * ECC_NOTE — why M and not L.
 *
 * L (7% recovery) is tempting: this is drawn on a backlit screen at arm's
 * length, not printed on a receipt that lives in a wallet for a year. But
 * "on a screen" is not the easy case for a camera. The code is read by a second
 * phone pointed at a first one, which means glare from the panel, moiré between
 * the display's pixel grid and the sensor's, and auto-exposure that blows the
 * white modules out or crushes the dark ones. Those artefacts destroy modules
 * in exactly the blotchy way redundancy exists to absorb.
 *
 * The second reason is narrower here than it would be for a payment code, but
 * it points the same way. RS parity is the only integrity check a QR symbol has
 * — there is no separate checksum underneath it — and a decoder handed more
 * errors than it can resolve does not always fail loudly; it can miscorrect
 * into a different codeword that still looks structurally valid. What that
 * yields here is a URL we did not write, which in practice fails to resolve
 * rather than sending anyone anywhere they did not intend to go. So this is an
 * argument for M, not the emergency it would be if the symbol carried a
 * recipient address — and if this encoder is ever pointed at one, M is already
 * the right floor and none of this has to be revisited.
 *
 * M costs us nothing in this bundle: the tables below are one column wide
 * whichever level we pick. On screen it costs one version step — a 78-byte
 * trade URL is v4 (33²) at L and v5 (37²) at M. Rendered in the 220 CSS px
 * panel the dialog gives it, and counting the four-module quiet zone on each
 * side, that is 5.4 -> 4.9 device-independent px per module: both far above
 * what a phone camera resolves at arm's length. We are buying real robustness
 * with invisible area.
 *
 * H (30%) is where the trade turns: it would push the same URL to 45² and start
 * shrinking modules for damage tolerance a backlit screen never needs.
 */

/**
 * VERSION_NOTE — why the range stops at 13.
 *
 * Alignment-pattern centres are a 40-row lookup table in a general encoder. In
 * the range we need they are not: they are exactly `[6, 4v+10]` for v2-v6 and
 * `[6, 2v+8, 4v+10]` for v7-v13. Verified against a reference encoder on every
 * version in range — and the formula breaks at v14, which takes four centres
 * (`[6,26,46,66]`) where the closed form predicts three. So 13 is not an
 * arbitrary cut; it is the last version before the table stops being a formula.
 *
 * It also happens to be far past anything we can be handed. At M, v13 holds 331
 * bytes. What this app builds is an origin, a symbol and a 44-character mint:
 * `https://utopiango.com/?q=UTCC&buy=<44>` is 78 bytes, which is v5. A symbol
 * long enough to reach even three figures would have to be pathological, and
 * `pickVersion` throws rather than truncating if one ever is. Versions 6-13 are
 * pure headroom, and they are nearly free because the alignment formula already
 * covers them.
 *
 * Stopping here also deletes the 18-bit version-information BCH generator: only
 * v7-v13 carry version info at all, so seven precomputed constants replace it.
 */

/** Highest version this encoder builds. Past here the alignment formula lies. */
const MAX_VERSION = 13;

/**
 * Data codewords available per version at ECC level M — the payload budget
 * before the mode indicator and length header are taken out of it.
 * Cross-checked against `qrcode`'s internal tables for v1-v13.
 */
const DATA_CODEWORDS = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334];

/**
 * How many RS blocks the data is split across, and how many parity codewords
 * each block gets. Blocks exist so a burst of damage lands in one block's error
 * budget instead of exhausting the whole symbol's; interleaving them on the way
 * out is what spreads a physical smudge across several blocks.
 */
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9];
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22];

/**
 * The 15-bit format information for ECC M, one entry per mask 0-7, already
 * BCH(15,5)-encoded and XORed with the 0x5412 spec mask.
 *
 * A general encoder computes these with a polynomial-division loop because it
 * has 32 of them (4 ECC levels x 8 masks). We have eight. The loop and its
 * bit-length helper are more code than the answers.
 */
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

/**
 * The 18-bit version information for v7-v13, BCH(18,6)-encoded. Versions 1-6
 * carry none, which is why this array starts at index 0 == version 7.
 */
const VERSION_INFO = [0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847];

// —— GF(256), the field Reed-Solomon lives in ——

/**
 * Log/antilog tables for GF(2^8) under the QR primitive polynomial 0x11d.
 *
 * Multiplication in this field is expensive done directly and trivial done as
 * `exp[log a + log b]`, which is why every RS implementation starts here. EXP
 * is doubled to 512 entries so that sum of two logs (max 254 + 254) can index
 * it without a modulo in the hot loop.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 256) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

/** @param {number} a @param {number} b */
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/**
 * The RS generator polynomial of degree `n`: (x - a^0)(x - a^1)...(x - a^n-1).
 *
 * Built on demand rather than tabled. There are only six distinct degrees in
 * range (10, 16, 18, 22, 24, 26, 30) but a table of them is ~150 coefficients,
 * and this loop is a dozen tokens.
 * @param {number} n
 */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Parity codewords for one block: the remainder of the message polynomial
 * divided by the generator, computed in place by synthetic division.
 * @param {Uint8Array} data
 * @param {number} n number of parity codewords to produce
 */
function parity(data, n) {
  const gen = generator(n);
  const buf = new Uint8Array(data.length + n);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const lead = buf[i];
    if (!lead) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], lead);
  }
  return buf.subarray(data.length);
}

// —— payload -> interleaved codeword stream ——

/**
 * Smallest version that holds `len` bytes at M.
 *
 * The header is 4 bits of mode indicator plus the character count, and the
 * count field widens from 8 to 16 bits at v10 — which is the one place the
 * version choice feeds back into its own budget. Checking in bits rather than
 * bytes keeps that honest instead of rounding a byte away.
 * @param {number} len
 */
function pickVersion(len) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (DATA_CODEWORDS[v - 1] * 8 >= 4 + countBits + len * 8) return v;
  }
  throw new Error("QR payload too long");
}

/**
 * Assemble the final codeword stream: header, data, padding, RS parity, all
 * interleaved into the order the matrix reads them.
 * @param {Uint8Array} bytes
 * @param {number} version
 */
function codewords(bytes, version) {
  const capacity = DATA_CODEWORDS[version - 1];
  /** @type {number[]} */
  const bits = [];
  /** @param {number} value @param {number} width */
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(4, 4); // byte mode indicator, 0b0100 — the only mode we emit
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // Terminator: up to four zero bits, truncated if the payload ends flush
  // against capacity. Then zero-fill to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  /** @type {number[]} */
  const stream = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    stream.push(byte);
  }
  // The spec's alternating pad bytes. They are not arbitrary filler: 0xec/0x11
  // is 11101100/00010001, a deliberately busy pattern that keeps the unused
  // tail of a sparse symbol from turning into a large blank region the mask
  // then has to fight.
  for (let i = 0; stream.length < capacity; i++) stream.push(i % 2 ? 0x11 : 0xec);

  // Split into blocks. Where capacity does not divide evenly the longer blocks
  // go last, which is what makes the interleave below line up.
  const blocks = BLOCKS[version - 1];
  const ecCount = EC_PER_BLOCK[version - 1];
  const shortLen = Math.floor(capacity / blocks);
  const longCount = capacity % blocks;
  /** @type {number[][]} */
  const data = [];
  /** @type {Uint8Array[]} */
  const ec = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const len = shortLen + (i >= blocks - longCount ? 1 : 0);
    const block = stream.slice(at, at + len);
    at += len;
    data.push(block);
    ec.push(parity(Uint8Array.from(block), ecCount));
  }

  // Interleave: one codeword from each block in turn, data first then parity.
  // This is the whole point of blocking — adjacent modules in the symbol now
  // belong to different blocks, so a thumb over one corner spreads its damage
  // across every block's error budget instead of blowing through one.
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i <= shortLen; i++) {
    for (const block of data) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecCount; i++) for (const block of ec) out.push(block[i]);
  return out;
}

// —— matrix ——

/**
 * Lay down every function pattern, then thread the codeword stream through
 * what's left.
 *
 * Returns the unmasked matrix plus a parallel map of which modules are function
 * patterns, because masking must skip them and the penalty scoring must not.
 * @param {number} version
 * @param {number[]} stream
 */
function layout(version, stream) {
  const size = version * 4 + 17;
  /** @type {Int8Array[]} */
  const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

  // Finder patterns and their separators. The -1..7 sweep draws the 7x7 eye and
  // the one-module light border in the same pass; the bounds check discards the
  // border cells that fall off the symbol.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const bar = c >= 0 && c <= 6 && (r === 0 || r === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[row][col] = ring || bar || core ? 1 : 0;
      }
    }
  }

  // Timing patterns: the alternating row and column a decoder uses to work out
  // the module pitch once it has found the three eyes.
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 ? 0 : 1;
    m[6][i] = on;
    m[i][6] = on;
  }

  // Alignment patterns. See VERSION_NOTE — closed form, valid to v13 only.
  const last = 4 * version + 10;
  const centres = version === 1 ? [] : version < 7 ? [6, last] : [6, 2 * version + 8, last];
  for (const cr of centres) {
    for (const cc of centres) {
      // The three positions that collide with a finder eye are skipped.
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === last) || (cr === last && cc === 6)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = Math.abs(r) === 2 || Math.abs(c) === 2 || (!r && !c);
          m[cr + r][cc + c] = on ? 1 : 0;
        }
      }
    }
  }

  // Reserve the two format-information strips so data placement skips them.
  // Written as 0 for now; the real bits depend on the mask we have not chosen.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    m[8][size - 1 - i] = 0;
    m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1; // the "dark module", always set, always here

  // Version information blocks, v7 and up only.
  if (version >= 7) {
    const info = VERSION_INFO[version - 7];
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  // Freeze which cells are function patterns before any data lands.
  const fixed = m.map((row) => Int8Array.from(row, (v) => (v === -1 ? 0 : 1)));

  // Data placement: two-module-wide columns walked right to left, alternating
  // up and down. Column 6 is skipped wholesale because the vertical timing
  // pattern owns it — decrementing past it keeps every later column paired.
  let bit = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fixed[row][c]) continue;
        // Symbols have a few remainder bits past the last codeword; reading off
        // the end yields undefined, which is spec-correct as light modules.
        const byte = stream[bit >> 3];
        m[row][c] = byte === undefined ? 0 : (byte >> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
    up = !up;
  }
  return { m, fixed, size };
}

/**
 * The eight mask conditions. A mask exists to break up runs and blank fields
 * that a payload might otherwise produce — a scanner needs edges to lock onto,
 * and a QR full of one colour has none.
 * @type {Array<(r: number, c: number) => boolean>}
 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * The spec's four penalty rules, scored on the fully masked symbol.
 *
 * We keep all four rather than fixing a mask. Fixing one is defensible on size
 * — the rules are the single biggest function here — but a fixed mask is a bet
 * that no payload ever lands badly under it, and the payload varies: addresses
 * are effectively random bytes, but the URI forms share long literal prefixes
 * (`solana:`, `?amount=`, `&spl-token=`) that make some codeword streams far
 * more structured than others. Rule 3 in particular is the one that stops a
 * mask from manufacturing a false finder pattern inside the data region, which
 * is the failure that makes a scanner mis-locate the symbol rather than merely
 * work harder. That is not a risk worth trading for a few hundred bytes.
 * @param {Int8Array[]} m
 * @param {number} size
 */
function penalty(m, size) {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const rowwise of [true, false]) {
      let run = 1;
      let prev = -1;
      for (let j = 0; j < size; j++) {
        const v = rowwise ? m[i][j] : m[j][i];
        if (v === prev) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
          prev = v;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: every 2x2 block of one colour. Solid areas cost 3 each.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const sum = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
      if (sum === 0 || sum === 4) score += 3;
    }
  }

  // Rule 3: the 1:1:3:1:1 finder signature plus four light modules, in either
  // orientation. Heavily penalised (40) because a decoder that mistakes one of
  // these for a real eye mis-locates the whole symbol.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size - 10; j++) {
      for (const rowwise of [true, false]) {
        let hitA = true;
        let hitB = true;
        for (let k = 0; k < 11; k++) {
          const v = rowwise ? m[i][j + k] : m[j + k][i];
          if (v !== A[k]) hitA = false;
          if (v !== B[k]) hitB = false;
        }
        if (hitA) score += 40;
        if (hitB) score += 40;
      }
    }
  }

  // Rule 4: drift away from a 50/50 dark ratio, in 5% steps. An unbalanced
  // symbol is one a camera's auto-threshold can misjudge.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Apply one mask and stamp in the matching format information.
 *
 * The format bits are written twice — once around the top-left eye, once split
 * across the other two — so the symbol is still readable with a corner lost.
 * Both strips step over the timing modules, which is what the index arithmetic
 * below is doing.
 * @param {Int8Array[]} base
 * @param {Int8Array[]} fixed
 * @param {number} size
 * @param {number} mask
 */
function applyMask(base, fixed, size, mask) {
  const m = base.map((row) => Int8Array.from(row));
  const condition = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && condition(r, c)) m[r][c] ^= 1;
    }
  }
  const format = FORMAT_M[mask];
  for (let i = 0; i < 15; i++) {
    const bit = (format >> i) & 1;
    // Vertical copy: down column 8, skipping row 6, then the bottom-left tail.
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
    // Horizontal copy: in from the right edge, then across to the left, again
    // skipping column 6.
    if (i < 8) m[8][size - 1 - i] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
  }
  return m;
}

/**
 * Encode `text` into a QR module matrix at ECC M.
 *
 * Exported mainly so tests can decode the raw modules; callers in the app want
 * `qrSvg` below.
 * @param {string} text
 * @returns {{ version: number, size: number, modules: Int8Array[] }}
 */
export function encode(text) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const { m, fixed, size } = layout(version, codewords(bytes, version));
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(m, fixed, size, mask);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { version, size, modules: /** @type {Int8Array[]} */ (best) };
}

/**
 * Render `text` as a self-contained SVG string.
 *
 * SVG rather than canvas: the panel already inlines SVG, the markup scales to
 * whatever box CSS gives it without a devicePixelRatio dance, and a canvas
 * would mean holding a raster of the code in memory for a dialog that is mostly
 * closed.
 *
 * Dark modules are emitted as a single `<path>` with horizontal runs merged, so
 * a v7 symbol is a few hundred bytes of `d` rather than one rect per module.
 * `shape-rendering="crispEdges"` turns off antialiasing: a half-lit module edge
 * is exactly the grey a camera's threshold has to guess at.
 *
 * Colours are hard-coded black on white and deliberately not themed. Inverted
 * QR — light modules on a dark field — is outside the spec, and while many
 * scanners cope, some do not; a code someone is already squinting at is not the
 * place to discover which phone they brought. The white background is drawn
 * explicitly so the quiet zone survives being dropped onto a dark panel.
 *
 * Both fills are stated rather than left to the SVG default, because the app
 * stylesheet carries `.tk-c path + path { fill: none; stroke: currentColor }`
 * for the sparklines on the price cards (app.css). A bare second `<path>` is
 * exactly the shape that rule selects, and a QR that renders as an outline is a
 * QR that does not scan.
 *
 * @param {string} text
 * @param {number} [quiet] quiet-zone width in modules; 4 is the spec minimum
 *   and the reason it exists is that a scanner needs blank margin to find the
 *   symbol edge at all.
 */
export function qrSvg(text, quiet = 4) {
  const { size, modules } = encode(text);
  const dim = size + quiet * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      let run = 1;
      while (c + run < size && modules[r][c + run]) run++;
      d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${dim}v${dim}H0z"/><path fill="#000" d="${d}"/></svg>`;
}
