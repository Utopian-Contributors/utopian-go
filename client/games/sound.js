/** Short synthesized effects for the games, once a press has allowed audio. */

/** @type {AudioContext | null} */
let audio = null;

export function wakeAudio() {
  if (audio) return;
  try {
    audio = new AudioContext();
  } catch {
    audio = null;
  }
}

/** @param {number} freq @param {number} dur @param {OscillatorType} type @param {number} [to] @param {number} [vol] @param {number} [at] */
export function tone(freq, dur, type, to = freq * 0.5, vol = 0.05, at = 0) {
  if (!audio) return;
  const t = audio.currentTime + at;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  amp.gain.setValueAtTime(vol, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur);
}
