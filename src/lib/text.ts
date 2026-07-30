/**
 * Decode HTML entities and strip tags for Brave/Wikipedia-derived text.
 *
 * Infobox attributes often ship Parsoid-style HTML where attribute values
 * contain JSON with nested tags, e.g.:
 *   <span data-mw='{"html":"<i>y</i>"}'>m.</span>
 * A naive /<[^>]+>/ regex stops at the first ">" inside the attribute and
 * leaves garbage like:  "}]]}'>m.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  bull: "\u2022",
  middot: "\u00b7",
};

/** Match &name; &#123; &#x1f; (case-insensitive hex). */
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

/**
 * Decode HTML character entities. Runs multiple passes for double-encoding
 * (e.g. &amp;#x27; → &#x27; → ').
 */
export function decodeHtmlEntities(value: string = ""): string {
  let s = String(value);
  for (let pass = 0; pass < 4; pass++) {
    const next = s.replace(ENTITY_RE, (match, body: string) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const code = hex
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const mapped = NAMED[body.toLowerCase()];
      return mapped !== undefined ? mapped : match;
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Strip HTML tags while respecting quoted attribute values (so ">" inside
 * data-mw JSON / title attributes does not truncate the tag early).
 * <br> and </p> become spaces.
 */
export function stripHtmlTags(value: string = ""): string {
  const s = String(value);
  let out = "";
  let i = 0;

  while (i < s.length) {
    if (s[i] !== "<") {
      out += s[i];
      i += 1;
      continue;
    }

    // Incomplete trailing "<..." — keep as text
    if (i + 1 >= s.length) {
      out += s[i];
      i += 1;
      continue;
    }

    const next = s[i + 1];
    // Only treat as a tag if it looks like one: <tag, </tag, <!..., <?...
    if (
      next !== "/" &&
      next !== "!" &&
      next !== "?" &&
      !/[a-zA-Z]/.test(next)
    ) {
      out += s[i];
      i += 1;
      continue;
    }

    let j = i + 1;
    let quote: '"' | "'" | null = null;
    while (j < s.length) {
      const c = s[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        j += 1;
        break;
      }
      j += 1;
    }

    const tag = s.slice(i, j);
    if (/^<br\b/i.test(tag) || /^<\/p\b/i.test(tag) || /^<p\b/i.test(tag)) {
      out += " ";
    }
    i = j;
  }

  return out;
}

export type PlainTextOptions = {
  /**
   * Trim leading/trailing whitespace (default true).
   * Set false when cleaning segments around <strong> so spaces
   * next to highlighted words are not eaten.
   */
  trim?: boolean;
};

/**
 * Leftover tails when an upstream strip truncated Parsoid data-mw mid-JSON,
 * e.g. married"}]]}'>m. 1976 → married m. 1976
 */
function scrubStripArtifacts(value: string): string {
  return value
    .replace(/"\}\]\]\}['"]?>/g, " ")
    .replace(/["'\]}]+>/g, " ");
}

/**
 * Strip HTML tags, decode entities, collapse whitespace — safe plain text.
 * Runs a second strip after entity decode to catch entity-encoded tags.
 */
export function plainText(
  value: string = "",
  { trim = true }: PlainTextOptions = {},
): string {
  let s = stripHtmlTags(String(value));
  s = decodeHtmlEntities(s);
  // Entity-encoded tags become real after decode — strip again
  s = stripHtmlTags(s);
  s = scrubStripArtifacts(s);
  s = s.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  if (trim) s = s.trim();
  return s;
}
