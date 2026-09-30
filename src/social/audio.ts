/**
 * Just enough of a voice memo to know which file it is.
 *
 * A browser's MediaRecorder writes one of two containers: WebM (Opus) almost
 * everywhere, MP4 (AAC) on a Safari older than 18.4. Every browser the site
 * supports plays both, so those two are all a post may carry, and the kind
 * becomes the extension the file is stored and served under. As with a JPEG's
 * SOF marker, the header is the whole parser — nothing is decoded.
 */

export type AudioKind = "webm" | "m4a";

export const AUDIO_TYPES: Record<AudioKind, string> = { webm: "audio/webm", m4a: "audio/mp4" };

export function audioKind(buf: Buffer): AudioKind | null {
  if (buf.length < 12) return null;
  // The EBML magic, then a DocType of "webm" among the header's first fields.
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return buf.subarray(4, 64).includes("webm") ? "webm" : null;
  // An ISO media file opens with its ftyp box.
  if (buf.toString("latin1", 4, 8) === "ftyp") return "m4a";
  return null;
}
