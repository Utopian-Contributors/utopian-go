/**
 * $UTCC, the project's own coin, and the one thing people pay each other in on
 * Social. The server pins the same mint into the token index
 * (TOKEN_PINNED_MINTS in src/config.ts).
 *
 * A wallet's holding is POST /api/balances with this mint, read as `token`:
 * base units, and missing when it could not be read, which is not the same as
 * holding none.
 */
export const UTCC = {
  symbol: "UTCC",
  mint: "HGTXnhgyast5fJKhMcE4VgyeEVWhYKEsHxpZtpjhrYqA",
  decimals: 6,
};

const ONE = 10n ** BigInt(UTCC.decimals);

/**
 * Grouped, two places, cut rather than rounded, so a balance never reads as
 * more than is there to send. Under one coin, every place.
 * @param {bigint} units
 */
export function utccText(units) {
  const whole = units / ONE;
  const places = whole ? 2 : UTCC.decimals;
  const frac = (units % ONE).toString().padStart(UTCC.decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/**
 * Abbreviated from 1K, for a column with room for five characters. Cut, as above.
 * @param {bigint} units
 */
export function utccShort(units) {
  const n = Number(units / ONE);
  for (const [factor, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]) {
    if (n >= factor) return `${Math.floor((n / factor) * 10) / 10}${suffix}`;
  }
  if (n >= 1) return String(n);
  return units ? "<1" : "0";
}
