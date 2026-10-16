/**
 * Number display for crypto values (display only — never for math).
 *
 * Follows the project number-formatting spec: no scientific notation, no
 * truncation, no signed zero, `--` for anything invalid, and zero-subscript
 * notation for sub-milli prices so BONK doesn't render as "$0.00".
 */

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

/** @param {number} n */
function subscript(n) {
  let out = "";
  for (const digit of String(n)) out += SUBSCRIPTS[Number(digit)];
  return out;
}

/** @param {unknown} v */
function invalid(v) {
  return typeof v !== "number" || !Number.isFinite(v);
}

/**
 * Full-precision decimal string — never exponential. Used for aria-label and
 * hover so the exact value is always recoverable from an abbreviated display.
 * @param {number} v
 */
export function plain(v) {
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/** Leading zeros between the decimal point and the first significant digit. */
function leadingZeros(a) {
  return Math.max(0, -Math.floor(Math.log10(a)) - 1);
}

/**
 * Spec rounding is half away from zero, but 0.1235 is stored as
 * 0.12349999… so the built-ins round it down. Nudging by one ULP restores the
 * decimal behaviour without affecting any value that isn't already on the
 * boundary.
 */
function halfUp(a) {
  return a * (1 + Number.EPSILON);
}

/**
 * Price of one token, compact context. Never abbreviated — "$1.2K per SOL"
 * would be a lie about precision people trade on.
 *
 * @param {number | null | undefined} v
 * @returns {{ text: string, title?: string, label?: string }}
 */
export function tokenPrice(v) {
  if (invalid(v)) return { text: "--" };
  const a = Math.abs(v);
  if (a === 0) return { text: "$0.00" };

  const sign = v < 0 ? "-" : "";
  const title = `$${plain(v)}`;

  if (a >= 1000) {
    const core = a.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return { text: `${sign}$${core}`, title };
  }
  // >= $100 reaches 3 significant digits on the integer part alone.
  if (a >= 100) return { text: `${sign}$${halfUp(a).toFixed(0)}`, title };
  if (a >= 1) return { text: `${sign}$${halfUp(a).toFixed(1)}`, title };

  let zeros = leadingZeros(a);
  if (zeros < 3) {
    const rounded = Number(halfUp(a).toPrecision(3));
    // Rounding can cross $1 (0.9997 → 1.00); use the band it landed in so a
    // near-peg stablecoin reads "$1.0", not "$1.000".
    if (rounded >= 1) return { text: `${sign}$${rounded.toFixed(1)}`, title };
    return { text: `${sign}$${rounded.toFixed(Math.min(8, zeros + 3))}`, title };
  }

  // 0.00005835 → $0.0₄58 (two significant digits in compact context)
  let digits = String(Math.round(halfUp(a) * 10 ** (zeros + 2)));
  // Rounding can carry (0.0000999 → "100"), which is one zero shallower.
  if (digits.length > 2) {
    zeros -= 1;
    digits = digits.slice(0, 2);
  }
  return {
    text: `${sign}$0.0${subscript(zeros)}${digits}`,
    title,
    label: `${sign}$0.${"0".repeat(zeros)}${digits}`,
  };
}

/**
 * Percentage. `signed` marks it as a delta, which gets an explicit `+`.
 * @param {number | null | undefined} v
 * @param {boolean} [signed]
 */
export function percent(v, signed = false) {
  if (invalid(v)) return "--";
  const a = Math.abs(v);
  if (a === 0) return "0.00%";

  const sign = v < 0 ? "-" : signed ? "+" : "";
  let core;
  if (a >= 1000) core = a.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (a >= 100) core = halfUp(a).toFixed(1);
  else core = halfUp(a).toFixed(2);

  // Non-zero that rounds away — say so rather than claiming zero movement.
  if (Number(core.replace(/,/g, "")) === 0) return `${sign}<0.01%`;
  return `${sign}${core}%`;
}

/**
 * USD value, stated exactly — grouped, two decimals, never abbreviated.
 *
 * The counterpart to `fiat` below, and the difference is who the number
 * belongs to. A market cap is context: "$1.3B" tells you what you need and
 * nobody reads the units digit. A balance is someone's money, and rounding
 * $1,250.45 to "$1.3K" on the page they opened to check it is the one place
 * abbreviation actively removes the information they came for.
 *
 * Sub-cent amounts state themselves as a bound rather than as $0.00, which
 * reads as free.
 *
 * @param {number | null | undefined} v
 */
export function dollars(v) {
  if (invalid(v)) return "—";
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A token amount, compact: "12K", "1.5M", and below a thousand to as many
 * places as are worth a cent at today's price (four without one). Under a
 * thousandth it is zero-subscript, as prices are.
 *
 * Cut rather than rounded, as utccShort is, so a balance never reads as more
 * than is there. Worked on the base-unit digits rather than on a float, which
 * would cut 1.15 to 1.14.
 *
 * @param {string | bigint} units base units, signed
 * @param {number} decimals
 * @param {number} [price] USD per token
 * @returns {{ text: string, title?: string, label?: string }} title is the exact amount
 */
export function amount(units, decimals, price) {
  let raw;
  try {
    raw = BigInt(units);
  } catch {
    return { text: "--" };
  }
  if (raw === 0n) return { text: "0" };

  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0");
  const title = `${sign}${whole.toLocaleString("en-US")}${frac.replace(/0+$/, "") ? `.${frac.replace(/0+$/, "")}` : ""}`;

  for (const [factor, suffix] of /** @type {[bigint, string][]} */ ([
    [10n ** 12n, "T"],
    [10n ** 9n, "B"],
    [10n ** 6n, "M"],
    [10n ** 3n, "K"],
  ])) {
    if (whole >= factor) {
      const tenths = (whole * 10n) / factor;
      const rest = tenths % 10n;
      return { text: `${sign}${tenths / 10n}${rest ? `.${rest}` : ""}${suffix}`, title };
    }
  }

  if (!whole) {
    const zeros = frac.length - frac.replace(/^0+/, "").length;
    if (zeros >= 3) {
      const digits = frac.slice(zeros, zeros + 2).replace(/0+$/, "");
      return { text: `${sign}0.0${subscript(zeros)}${digits}`, title, label: `${sign}0.${"0".repeat(zeros)}${digits}` };
    }
  }

  const worth = typeof price === "number" && price > 0 ? Math.ceil(-Math.log10(0.01 / price)) : 4;
  const places = Math.min(6, Math.max(0, worth));
  const shown = frac.slice(0, places).replace(/0+$/, "");
  // Something there, but less than the last place shown: say so, not zero.
  if (!whole && !shown) return { text: `${sign}<${places ? `0.${"0".repeat(places - 1)}1` : "1"}`, title };
  return { text: `${sign}${whole.toLocaleString("en-US")}${shown ? `.${shown}` : ""}`, title };
}

/**
 * USD value, compact context — abbreviates at 1K and above.
 * @param {number | null | undefined} v
 */
export function fiat(v) {
  if (invalid(v)) return "--";
  const a = Math.abs(v);
  if (a === 0) return "$0.00";

  const sign = v < 0 ? "-" : "";
  for (const [factor, suffix] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]) {
    if (a >= /** @type {number} */ (factor)) {
      const core = halfUp(a / /** @type {number} */ (factor))
        .toFixed(1)
        .replace(/\.0$/, "");
      return `${sign}$${core}${suffix}`;
    }
  }

  const core = halfUp(a).toFixed(2);
  if (Number(core) === 0) return `${sign}<$0.01`;
  return `${sign}$${core}`;
}
