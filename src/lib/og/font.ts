/**
 * Type for the share cards (lib/og/cards.ts), set as outlines.
 *
 * The cards are SVG rasterised by sharp, and an SVG <text> is set in
 * whatever fontconfig finds: on a server with no fonts installed that is
 * nothing at all, and sharp's own `fontfile` option is ignored by the macOS
 * build, so a card checked here could still come out blank in production.
 * Reading the glyphs out of a TrueType file shipped with the server
 * (assets/fonts) and writing them as paths makes a card the same on every
 * machine. TrueType outlines only (`glyf`), which Inter's static TTFs are;
 * no kerning, which at these sizes nobody misses.
 */
import { readFileSync } from "fs";

type Cmd = (string | number)[];

export interface Font {
  /** Whether every character of `text` has a glyph (spaces aside). */
  covers(text: string): boolean;
  /** Advance width of `text` at `size` px, with `track` em between letters. */
  width(text: string, size: number, track?: number): number;
  /** `text` as one path's `d`, its baseline starting at (x, y). */
  path(text: string, x: number, y: number, size: number, track?: number): string;
}

export function loadFont(file: string): Font {
  const buf = readFileSync(file);
  const u16 = (o: number) => buf.readUInt16BE(o);
  const i16 = (o: number) => buf.readInt16BE(o);
  const u32 = (o: number) => buf.readUInt32BE(o);

  const tables = new Map<string, number>();
  for (let i = 0, n = u16(4); i < n; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString("latin1", rec, rec + 4), u32(rec + 8));
  }
  const at = (tag: string) => {
    const o = tables.get(tag);
    if (o == null) throw new Error(`${file}: no ${tag} table`);
    return o;
  };

  const head = at("head");
  const upm = u16(head + 18);
  const longLoca = i16(head + 50) === 1;
  const numGlyphs = u16(at("maxp") + 4);
  const numMetrics = u16(at("hhea") + 34);
  const hmtx = at("hmtx");
  const loca = at("loca");
  const glyf = at("glyf");

  const advance = (g: number) => u16(hmtx + 4 * Math.min(g, numMetrics - 1));
  const glyphAt = (g: number): [number, number] =>
    longLoca ? [glyf + u32(loca + 4 * g), glyf + u32(loca + 4 * g + 4)] : [glyf + 2 * u16(loca + 2 * g), glyf + 2 * u16(loca + 2 * g + 2)];

  // —— Characters to glyphs: format 12 where the font has it, else format 4 ——
  const cmap = at("cmap");
  let sub12 = -1;
  let sub4 = -1;
  for (let i = 0, n = u16(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = u16(rec);
    const encoding = u16(rec + 2);
    const sub = cmap + u32(rec + 4);
    const format = u16(sub);
    if (format === 12 && (platform === 0 || (platform === 3 && encoding === 10))) sub12 = sub;
    if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) sub4 = sub;
  }
  const glyphOf = (c: number): number => {
    if (sub12 >= 0) {
      let lo = 0;
      let hi = u32(sub12 + 12) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = sub12 + 16 + mid * 12;
        if (c < u32(g)) hi = mid - 1;
        else if (c > u32(g + 4)) lo = mid + 1;
        else return u32(g + 8) + c - u32(g);
      }
      return 0;
    }
    if (sub4 < 0 || c > 0xffff) return 0;
    const segs = u16(sub4 + 6) / 2;
    const ends = sub4 + 14;
    const starts = ends + 2 * segs + 2;
    const deltas = starts + 2 * segs;
    const ranges = deltas + 2 * segs;
    for (let i = 0; i < segs; i++) {
      if (c > u16(ends + 2 * i)) continue;
      const start = u16(starts + 2 * i);
      if (c < start) return 0;
      const delta = i16(deltas + 2 * i);
      const ro = u16(ranges + 2 * i);
      if (!ro) return (c + delta) & 0xffff;
      const g = u16(ranges + 2 * i + ro + 2 * (c - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };

  // —— Outlines, in font units, y up ——
  const outlines = new Map<number, Cmd[]>();

  function outline(g: number, depth = 0): Cmd[] {
    const held = outlines.get(g);
    if (held) return held;
    const cmds: Cmd[] = [];
    const [start, end] = g < numGlyphs ? glyphAt(g) : [0, 0];
    if (end > start && depth < 8) {
      const contours = i16(start);
      if (contours >= 0) simple(start, contours, cmds);
      else composite(start, cmds, depth);
    }
    outlines.set(g, cmds);
    return cmds;
  }

  function simple(o: number, contours: number, cmds: Cmd[]): void {
    const ends: number[] = [];
    for (let i = 0; i < contours; i++) ends.push(u16(o + 10 + 2 * i));
    const count = contours ? ends[contours - 1] + 1 : 0;
    let p = o + 10 + 2 * contours;
    p += 2 + u16(p);
    const flags: number[] = [];
    while (flags.length < count) {
      const f = buf[p++];
      flags.push(f);
      if (f & 8) for (let r = buf[p++]; r > 0; r--) flags.push(f);
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [short, same, out] of [
      [2, 16, xs],
      [4, 32, ys],
    ] as const) {
      let v = 0;
      for (const f of flags) {
        if (f & short) v += f & same ? buf[p++] : -buf[p++];
        else if (!(f & same)) {
          v += i16(p);
          p += 2;
        }
        out.push(v);
      }
    }
    let first = 0;
    for (const last of ends) {
      contour(xs.slice(first, last + 1), ys.slice(first, last + 1), flags.slice(first, last + 1), cmds);
      first = last + 1;
    }
  }

  /** One closed contour, on- and off-curve points to M/Q/L, implied points filled in. */
  function contour(xs: number[], ys: number[], flags: number[], cmds: Cmd[]): void {
    const n = xs.length;
    if (n < 2) return;
    const on = (i: number) => (flags[i % n] & 1) === 1;
    const pt = (i: number): [number, number] => [xs[i % n], ys[i % n]];
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // Start on a point that is on the curve, implied if need be.
    let s = 0;
    while (s < n && !on(s)) s++;
    let startPt: [number, number];
    if (s === n) {
      startPt = mid(pt(0), pt(1));
      s = 0;
    } else startPt = pt(s);
    cmds.push(["M", ...startPt]);
    let ctrl: [number, number] | null = null;
    for (let k = 1; k <= n; k++) {
      const i = s + k;
      const p = pt(i);
      if (on(i)) {
        cmds.push(ctrl ? ["Q", ...ctrl, ...p] : ["L", ...p]);
        ctrl = null;
      } else {
        if (ctrl) cmds.push(["Q", ...ctrl, ...mid(ctrl, p)]);
        ctrl = p;
      }
    }
    if (ctrl) cmds.push(["Q", ...ctrl, ...startPt]);
    cmds.push(["Z"]);
  }

  function composite(o: number, cmds: Cmd[], depth: number): void {
    let p = o + 10;
    for (;;) {
      const f = u16(p);
      const g = u16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (f & 1) {
        dx = i16(p);
        dy = i16(p + 2);
        p += 4;
      } else {
        dx = buf.readInt8(p);
        dy = buf.readInt8(p + 1);
        p += 2;
      }
      if (!(f & 2)) dx = dy = 0; // Point-matched placement: not in the fonts this reads.
      const f2 = (q: number) => i16(q) / 16384;
      let [a, b, c, d] = [1, 0, 0, 1];
      if (f & 8) {
        a = d = f2(p);
        p += 2;
      } else if (f & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (f & 0x80) {
        [a, b, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
        p += 8;
      }
      for (const cmd of outline(g, depth + 1)) {
        const out: Cmd = [cmd[0]];
        for (let i = 1; i < cmd.length; i += 2) {
          const x = cmd[i] as number;
          const y = cmd[i + 1] as number;
          out.push(a * x + c * y + dx, b * x + d * y + dy);
        }
        cmds.push(out);
      }
      if (!(f & 0x20)) break;
    }
  }

  const chars = (text: string) => Array.from(text, (ch) => ch.codePointAt(0)!);
  const r = (v: number) => Math.round(v * 10) / 10;

  return {
    covers(text) {
      return chars(text).every((c) => c === 32 || glyphOf(c) !== 0);
    },
    width(text, size, track = 0) {
      const cs = chars(text);
      const units = cs.reduce((w, c) => w + advance(glyphOf(c)), 0);
      return (units * size) / upm + Math.max(0, cs.length - 1) * track * size;
    },
    path(text, x, y, size, track = 0) {
      const k = size / upm;
      let pen = x;
      let d = "";
      for (const c of chars(text)) {
        const g = glyphOf(c);
        for (const cmd of outline(g)) {
          d += cmd[0];
          for (let i = 1; i < cmd.length; i += 2) d += `${r(pen + (cmd[i] as number) * k)} ${r(y - (cmd[i + 1] as number) * k)} `;
        }
        pen += advance(g) * k + track * size;
      }
      return d;
    },
  };
}
