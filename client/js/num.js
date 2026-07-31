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
