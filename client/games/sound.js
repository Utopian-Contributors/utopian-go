/**
 * Short synthesized effects for the games, once a press has allowed audio:
 * tones, filtered noise and struck bells. Everything goes through one
 * compressor, so a pile of sounds at once does not clip, and what should ring
 * on can send some of itself into a shared room.
 */

/** @type {AudioContext | null} */
let audio = null;
/** @type {AudioNode} The compressor in front of the speakers. */
let bus;
/** @type {ConvolverNode | null} The room, made the first time something rings in it. */
let room = null;
/** @type {AudioBuffer | null} A second of white noise, shared by every noise. */
let white = null;

export function wakeAudio() {
  if (audio) {
    // A phone suspends it on a call or a lock; the next press brings it back.
    if (audio.state === "suspended") audio.resume().catch(() => {});
    return;
  }
  try {
    audio = new AudioContext();
    const c = audio.createDynamicsCompressor();
    c.threshold.value = -16;
    c.knee.value = 12;
    c.ratio.value = 5;
    c.attack.value = 0.002;
    c.release.value = 0.25;
    // The compressor lifts quiet sounds by its own makeup gain: taken back
    // off, so what was quiet before stays as quiet.
    const trim = audio.createGain();
    trim.gain.value = 0.6;
    c.connect(trim).connect(audio.destination);
    bus = c;
  } catch {
    audio = null;
  }
}

/** A stereo tail of fading noise: about two and a half seconds of hall. */
function hall() {
  if (!room && audio) {
    const len = Math.floor(audio.sampleRate * 2.5);
    const buf = audio.createBuffer(2, len, audio.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    room = audio.createConvolver();
    room.buffer = buf;
    const back = audio.createGain();
    back.gain.value = 0.5;
    room.connect(back).connect(bus);
  }
  return /** @type {ConvolverNode} */ (room);
}

/**
 * A gain that rises over `attack` and dies away by `dur`, connected out (and,
 * with `wet`, into the room as well).
 * @param {number} t @param {number} vol @param {number} attack @param {number} dur @param {number} wet
 */
function env(t, vol, attack, dur, wet) {
  const a = /** @type {AudioContext} */ (audio);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + Math.min(attack, dur * 0.9));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(bus);
  if (wet) {
    const send = a.createGain();
    send.gain.value = wet;
    g.connect(send).connect(hall());
  }
  return g;
}

/**
 * A tone gliding from `freq` to `to`.
 * @param {number} freq @param {number} dur @param {OscillatorType} type @param {number} [to]
 * @param {number} [vol] @param {number} [at] seconds from now @param {number} [wet] how much rings in the room
 */
export function tone(freq, dur, type, to = freq * 0.5, vol = 0.05, at = 0, wet = 0) {
  if (!audio) return;
  const t = audio.currentTime + at;
  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  osc.connect(env(t, vol, 0.004, dur, wet));
  osc.start(t);
  osc.stop(t + dur);
}

/**
 * Filtered noise, its filter sweeping from `freq` to `to`: a hiss, a crack,
 * a thump or a whoosh, by the filter and the length.
 * @param {number} dur @param {number} freq @param {number} [to] @param {number} [vol] @param {number} [at]
 * @param {BiquadFilterType} [type] @param {number} [q] @param {number} [attack] @param {number} [wet]
 */
export function noise(dur, freq, to = freq, vol = 0.2, at = 0, type = "bandpass", q = 1, attack = 0.002, wet = 0) {
  if (!audio) return;
  if (!white) {
    white = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const d = white.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = audio.currentTime + at;
  const src = audio.createBufferSource();
  src.buffer = white;
  src.loop = true;
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(freq, t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  src.connect(filter).connect(env(t, vol, attack, dur, wet));
  src.start(t, Math.random() * 0.9);
  src.stop(t + dur);
}

/**
 * A cast bell's partials, as ratios of its prime: the hum an octave under,
 * the minor-third tierce that makes it sound like a church, the nominal an
 * octave over, and a few clangy ones high up. Each with its level and how
 * much of the ring it lasts; the low ones last longest.
 */
const PARTIALS = [
  [0.5, 0.7, 1],
  [1, 0.55, 0.8],
  [1.19, 0.4, 0.6],
  [1.5, 0.2, 0.4],
  [2, 0.45, 0.5],
  [2.52, 0.14, 0.28],
  [2.67, 0.16, 0.25],
  [3.01, 0.12, 0.2],
  [4.07, 0.08, 0.13],
  [5.43, 0.05, 0.09],
  [6.8, 0.03, 0.06],
];

/**
 * A bell struck once, ringing for `dur`. The hum and the prime are each two
 * slightly apart, so the ring slowly beats as a real bell's does.
 * @param {number} prime @param {number} [vol] @param {number} [at] @param {number} [dur]
 */
export function bell(prime, vol = 0.1, at = 0, dur = 5) {
  if (!audio) return;
  const t = audio.currentTime + at;
  for (const [r, level, last] of PARTIALS) {
    for (const beat of r < 1.1 ? [-0.7, 0.7] : [0]) {
      const osc = audio.createOscillator();
      osc.frequency.value = prime * r + beat;
      osc.connect(env(t, vol * level * (beat ? 0.7 : 1), 0.003, dur * last, 0.6));
      osc.start(t);
      osc.stop(t + dur * last);
    }
  }
  // The clapper's knock on the bronze.
  noise(0.09, 2200, 900, vol * 1.6, at, "bandpass", 1.2, 0.001, 0.4);
  tone(prime * 2, 0.12, "triangle", prime, vol * 0.4, at);
}

/**
 * A tune: each note `[semitones from A4, beats]`, a `null` pitch resting.
 * @param {Array<[number | null, number]>} notes @param {number} beat seconds @param {OscillatorType} type
 * @param {number} vol @param {number} [at] @param {number} [wet]
 */
export function melody(notes, beat, type, vol, at = 0, wet = 0.2) {
  let when = at;
  for (const [semi, beats] of notes) {
    const len = beats * beat;
    if (semi !== null) {
      const f = 440 * 2 ** (semi / 12);
      tone(f, len * 0.95 + 0.06, type, f, vol, when, wet);
    }
    when += len;
  }
}
