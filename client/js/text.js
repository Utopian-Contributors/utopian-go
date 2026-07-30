/**
 * Safe text helpers for Brave snippets (entities + optional <strong>).
 */

/** Common named entities; numeric refs cover the rest. */
const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

/**
 * Decode HTML entities (named, decimal, hex). Multiple passes for double-encoding.
 * @param {string} s
 */
export function decodeEntities(s) {
  let out = String(s);
  for (let i = 0; i < 4; i++) {
    const next = out.replace(ENTITY_RE, (match, body) => {
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
      const key = body.toLowerCase();
      return key in NAMED ? NAMED[key] : match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Strip HTML tags while respecting quoted attributes (Parsoid data-mw JSON
 * often embeds nested tags with ">" inside attribute values).
 * @param {string} value
 */
export function stripHtmlTags(value) {
  const s = String(value);
  let out = "";
  let i = 0;

  while (i < s.length) {
    if (s[i] !== "<") {
      out += s[i];
      i += 1;
      continue;
    }

    if (i + 1 >= s.length) {
      out += s[i];
      i += 1;
      continue;
    }

    const next = s[i + 1];
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
    /** @type {'"' | "'" | null} */
    let quote = null;
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

/**
 * Leftover tails when an upstream strip truncated Parsoid data-mw mid-JSON,
 * e.g. married"}]]}'>m. 1976 → married m. 1976
 * @param {string} value
 */
function scrubStripArtifacts(value) {
  return value
    .replace(/"\}\]\]\}['"]?>/g, " ")
    .replace(/["'\]}]+>/g, " ");
}

/**
 * @param {string} s
 * @param {{ trim?: boolean }} [opts]
 */
export function plainText(s, opts = {}) {
  let out = stripHtmlTags(String(s));
  out = decodeEntities(out);
  out = stripHtmlTags(out);
  out = scrubStripArtifacts(out);
  out = out.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  if (opts.trim !== false) out = out.trim();
  return out;
}

/** @param {string} s */
function plainSegment(s) {
  return plainText(s, { trim: false });
}

/**
 * Append snippet text; preserve <strong> highlights and edge spaces.
 * @param {HTMLElement} parent
 * @param {string} raw
 */
export function appendSanitized(parent, raw) {
  const parts = String(raw).split(/(<\/?strong>)/i);
  let strong = false;
  let buffer = "";

  const flush = () => {
    const text = plainSegment(buffer);
    buffer = "";
    if (!text) return;
    if (strong) {
      const s = document.createElement("strong");
      s.textContent = text;
      parent.append(s);
    } else {
      parent.append(text);
    }
  };

  for (const part of parts) {
    if (/^<strong>$/i.test(part)) {
      flush();
      strong = true;
    } else if (/^<\/strong>$/i.test(part)) {
      flush();
      strong = false;
    } else {
      buffer += part;
    }
  }
  flush();
}

/** @param {string | undefined} s */
export function host(s) {
  try {
    return new URL(s || "").hostname.replace(/^www\./, "");
  } catch {
    return s || "";
  }
}

/** @param {{ url?: string, meta_url?: { netloc?: string, path?: string } }} item */
export function displayPath(item) {
  const m = item.meta_url;
  if (m?.netloc) {
    const path = m.path ? ` ${String(m.path).replace(/\s*›\s*/g, " › ")}` : "";
    return m.netloc + path;
  }
  try {
    const u = new URL(item.url || "");
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
  } catch {
    return item.url || "";
  }
}

/** @param {string} a */
export function formatAge(a) {
  const d = Date.parse(a);
  if (Number.isNaN(d)) return String(a).slice(0, 10);
  const days = Math.floor((Date.now() - d) / 864e5);
  return days < 1 ? "Today" : `${days}d ago`;
}
