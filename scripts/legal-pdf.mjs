#!/usr/bin/env node
/**
 * client/legal/*.html → public/*.pdf
 *
 * The documents are published as PDFs, but the source stays the readable HTML
 * under client/legal/ so there is one copy of the text to edit.
 *
 * Why generate rather than ship the PDFs the policies were drafted as: those
 * embed subsetted Arial (two FontFile2 streams) and weigh 95–108 KB, and
 * nothing short of re-typesetting takes that out. These use the base-14
 * fonts — Helvetica and Helvetica-Bold, which every PDF reader already has, so
 * nothing is embedded and the file is the text plus about a kilobyte of
 * structure. Both come out around 5 KB.
 *
 * The subset of HTML understood is exactly what those two files use: h1, h2,
 * p, p.dt, ul/li, b, a, br, and the handful of named entities below. Anything
 * else is a build error rather than something silently dropped from a legal
 * document.
 */
import { deflateSync } from "zlib";

// —— Page ——

/** US Letter, matching the PDFs these were drafted as. */
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const TEXT_W = PAGE_W - MARGIN * 2;

/** Type scale, in points: [size, leading, spaceBefore, spaceAfter, bold]. */
const STYLE = {
  h1: { size: 20, lead: 24, before: 0, after: 4, bold: true },
  h2: { size: 12, lead: 16, before: 20, after: 5, bold: true },
  dt: { size: 9, lead: 13, before: 0, after: 18, bold: false, gray: 0.45 },
  p: { size: 10, lead: 14, before: 0, after: 10, bold: false },
  li: { size: 10, lead: 14, before: 0, after: 6, bold: false, indent: 18 },
};

// —— Metrics ——

/*
 * Advance widths, in 1/1000 em, for the two base-14 faces. Only the codes
 * these documents actually set: printable ASCII, plus the CP1252 punctuation
 * the text uses. Wrapping is the only thing they feed, so a wrong entry costs
 * a ragged line rather than a wrong character.
 */
const ASCII_HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

/** CP1252 punctuation, by byte. */
const HIGH_HELV = { 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xa7: 556, 0xb7: 278 };
const HIGH_BOLD = { 0x91: 278, 0x92: 278, 0x93: 500, 0x94: 500, 0x95: 350, 0x96: 556, 0x97: 1000, 0xa7: 556, 0xb7: 278 };

/** Width of one CP1252 byte at 1pt. */
function charWidth(byte, bold) {
  if (byte >= 32 && byte <= 126) {
    return (bold ? ASCII_BOLD : ASCII_HELV)[byte - 32] / 1000;
  }
  const high = (bold ? HIGH_BOLD : HIGH_HELV)[byte];
  if (high === undefined) throw new Error(`legal-pdf: no width for byte 0x${byte.toString(16)}`);
  return high / 1000;
}

/** @param {number[]} bytes */
function textWidth(bytes, bold, size) {
  let w = 0;
  for (const b of bytes) w += charWidth(b, bold);
  return w * size;
}

// —— Text encoding ——

/** Unicode → WinAnsi (CP1252), for the characters these documents contain. */
const CP1252 = new Map([
  ["‘", 0x91], ["’", 0x92], ["“", 0x93], ["”", 0x94],
  ["•", 0x95], ["–", 0x96], ["—", 0x97], ["§", 0xa7],
  ["·", 0xb7], [" ", 0x20],
]);

/**
 * @param {string} str
 * @returns {number[]} WinAnsi bytes
 */
function encode(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) out.push(code);
    else if (CP1252.has(ch)) out.push(CP1252.get(ch));
    else throw new Error(`legal-pdf: ${JSON.stringify(ch)} has no WinAnsi code — add it to CP1252`);
  }
  return out;
}

/** Bytes → a PDF literal string, octal-escaping what the syntax reserves. */
function pdfString(bytes) {
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + ")";
}

// —— Source ——

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ",
  mdash: "—", ndash: "–", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", middot: "·", sect: "§",
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name.toLowerCase()];
    if (value === undefined) throw new Error(`legal-pdf: unknown entity &${name};`);
    return value;
  });
}

/**
 * Inline markup → styled runs. <b> turns bold on, <a> and <br> contribute
 * their text and a break; anything else is a build error.
 *
 * @returns {Array<{ text: string, bold: boolean } | { br: true }>}
 */
function runs(html) {
  const out = [];
  let bold = 0;
  let last = 0;
  const tag = /<\/?([a-z0-9]+)\b[^>]*>/gi;
  const push = (text) => {
    if (!text) return;
    out.push({ text: decodeEntities(text), bold: bold > 0 });
  };
  let m;
  while ((m = tag.exec(html))) {
    push(html.slice(last, m.index));
    last = tag.lastIndex;
    const name = m[1].toLowerCase();
    const close = m[0][1] === "/";
    if (name === "b" || name === "strong") bold += close ? -1 : 1;
    else if (name === "br") out.push({ br: true });
    else if (name !== "a") throw new Error(`legal-pdf: unexpected <${name}> in ${html.slice(0, 60)}`);
  }
  push(html.slice(last));
  return out;
}

/**
 * A document fragment → an ordered list of blocks.
 *
 * @returns {Array<{ style: keyof STYLE, runs: ReturnType<typeof runs> }>}
 */
function parse(html) {
  const blocks = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const block = /<(h1|h2|p|ul)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  let consumed = 0;
  while ((m = block.exec(source))) {
    const between = source.slice(consumed, m.index).trim();
    if (between) throw new Error(`legal-pdf: stray content outside a block: ${between.slice(0, 60)}`);
    consumed = block.lastIndex;

    const [, tag, attrs, inner] = m;
    if (tag.toLowerCase() === "ul") {
      for (const li of inner.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
        blocks.push({ style: "li", runs: runs(li[1]) });
      }
      continue;
    }
    const style = tag.toLowerCase() === "p" && /class="dt"/.test(attrs)
      ? "dt"
      : /** @type {keyof STYLE} */ (tag.toLowerCase());
    blocks.push({ style, runs: runs(inner) });
  }
  const tail = source.slice(consumed).trim();
  if (tail) throw new Error(`legal-pdf: stray content after the last block: ${tail.slice(0, 60)}`);
  if (!blocks.length) throw new Error("legal-pdf: no blocks parsed");
  return blocks;
}

// —— Layout ——

/**
 * Break a block's runs into lines that fit `width`, keeping each word's face.
 *
 * `base` is the block's own weight — a heading is set bold throughout, and
 * inline <b> can only add to that, never take it away.
 *
 * @returns {Array<Array<{ bytes: number[], bold: boolean }>>}
 */
function wrap(blockRuns, width, size, base) {
  /** @type {Array<Array<{bytes: number[], bold: boolean}>>} */
  const lines = [];
  let line = [];
  let used = 0;

  const flush = () => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const raw of blockRuns) {
    if ("br" in raw) {
      flush();
      continue;
    }
    const run = { text: raw.text, bold: base || raw.bold };
    // Split on whitespace but keep the separators' effect: a run boundary is
    // not a word boundary, so "<b>Terms</b>:" stays one word across two faces.
    const parts = run.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (line.length) {
          const space = { bytes: encode(" "), bold: run.bold };
          line.push(space);
          used += textWidth(space.bytes, space.bold, size);
        }
        continue;
      }
      const bytes = encode(part);
      const w = textWidth(bytes, run.bold, size);
      if (used + w > width && line.length) {
        // Drop the trailing space this word would have wrapped after.
        while (line.length && line[line.length - 1].bytes[0] === 0x20) line.pop();
        flush();
      }
      line.push({ bytes, bold: run.bold });
      used += w;
    }
  }
  while (line.length && line[line.length - 1].bytes[0] === 0x20) line.pop();
  if (line.length) flush();
  return lines.filter((l) => l.length);
}

/**
 * Blocks → pages of positioned lines.
 *
 * Headings are kept with what follows them: a section title alone at the foot
 * of a page reads as a missing section.
 */
function paginate(blocks) {
  const pages = [];
  let page = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    if (page.length) pages.push(page);
    page = [];
    y = PAGE_H - MARGIN;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const st = STYLE[b.style];
    const indent = st.indent || 0;
    const lines = wrap(b.runs, TEXT_W - indent, st.size, st.bold);
    const height = st.before + lines.length * st.lead + st.after;

    // A heading needs its first two lines of body under it to stay put.
    let need = height;
    if (b.style === "h2" && blocks[i + 1]) {
      need += STYLE[blocks[i + 1].style].lead * 2;
    }
    if (y - need < MARGIN && page.length) newPage();

    y -= st.before;
    for (let j = 0; j < lines.length; j++) {
      if (y - st.lead < MARGIN) {
        newPage();
      }
      y -= st.lead;
      page.push({
        x: MARGIN + indent,
        y,
        size: st.size,
        gray: st.gray,
        bullet: b.style === "li" && j === 0 ? MARGIN : null,
        parts: lines[j],
      });
    }
    y -= st.after;
  }
  if (page.length) pages.push(page);
  return pages;
}

// —— PDF ——

/**
 * One page's positioned lines → a content stream.
 *
 * Written as a single text object, because the alternative is most of the
 * file. Every word arrives here as its own part, and wrapping each in its own
 * BT/Tf/Tm/Tj/ET ran about seventy bytes of operators per word — four times
 * the text it was setting. So: adjacent parts in the same face are coalesced
 * into one Tj (the pen advances on its own, no repositioning between them),
 * the face is only restated when it changes, and lines move by a relative Td
 * from the previous line's origin rather than a fresh matrix each time.
 */
function contentStream(lines) {
  const ops = ["BT"];
  let gray = 0;
  let font = "";
  let size = 0;
  // The current line matrix origin — what Td is relative to.
  let lx = 0;
  let ly = 0;

  const setFont = (name, at) => {
    if (name === font && at === size) return;
    ops.push(`/${name} ${at} Tf`);
    font = name;
    size = at;
  };
  const moveTo = (x, y) => {
    ops.push(`${x - lx} ${y - ly} Td`);
    lx = x;
    ly = y;
  };

  for (const line of lines) {
    const want = line.gray ?? 0;
    if (want !== gray) {
      ops.push(`${want} g`);
      gray = want;
    }
    if (line.bullet !== null) {
      setFont("F1", line.size);
      moveTo(line.bullet, line.y);
      ops.push(`${pdfString(encode("•"))} Tj`);
    }
    moveTo(line.x, line.y);
    for (const part of coalesce(line.parts)) {
      setFont(part.bold ? "F2" : "F1", line.size);
      ops.push(`${pdfString(part.bytes)} Tj`);
    }
  }
  if (gray !== 0) ops.push("0 g");
  ops.push("ET");
  return ops.join("\n");
}

/** Merge neighbouring parts set in the same face. */
function coalesce(parts) {
  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.bold === part.bold) last.bytes = last.bytes.concat(part.bytes);
    else out.push({ bytes: part.bytes.slice(), bold: part.bold });
  }
  return out;
}

/**
 * Assemble the object graph and serialise it with a cross-reference table.
 *
 * @param {ReturnType<typeof paginate>} pages
 * @param {string} title
 */
function serialise(pages, title) {
  /** @type {Array<string | Buffer>} */
  const objects = [];
  /** Reserve an object number; bodies are filled in below. */
  const add = (body) => (objects.push(body), objects.length);

  const catalog = add(null);
  const pagesObj = add(null);
  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const info = add(`<< /Title ${pdfString(encode(title))} /Producer ${pdfString(encode("utopian-go"))} >>`);

  const pageIds = [];
  for (const lines of pages) {
    const raw = Buffer.from(contentStream(lines), "latin1");
    // Flate: the streams are the whole document, and a reader that cannot
    // inflate cannot read a PDF at all.
    const packed = deflateSync(raw, { level: 9 });
    const stream = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
        packed,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]` +
          ` /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >>` +
          ` /Contents ${stream} 0 R >>`,
      ),
    );
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const xref = [];
  for (let i = 0; i < objects.length; i++) {
    xref.push(offset);
    const body = objects[i];
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    const mid = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
    const obj = Buffer.concat([head, mid, tail]);
    chunks.push(obj);
    offset += obj.length;
  }

  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of xref) table += `${String(at).padStart(10, "0")} 00000 n \n`;
  table +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(table, "latin1"));

  return Buffer.concat(chunks);
}

/**
 * Render one document fragment to PDF bytes.
 *
 * @param {string} html a fragment from client/legal/
 * @param {string} title the PDF's /Title
 */
export function renderPdf(html, title) {
  return serialise(paginate(parse(html)), title);
}
