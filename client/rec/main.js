/**
 * The voice memo recorder: a dialog with one round button.
 *
 * Its own bundle, fetched the first time someone presses the composer's
 * microphone, so a timeline that is only read never carries it. It records,
 * and hands back the recording; the composer shows it, plays it, and posts it.
 *
 * The browser does the encoding. WebM (Opus) where it can write it, which is
 * every current browser, and MP4 (AAC) on a Safari older than 18.4; both play
 * everywhere the site runs. While it records, an analyser samples how loud the
 * microphone is, and that becomes the memo's shape: forty bars the timeline
 * draws without fetching a byte of audio.
 */
import { el } from "../js/dom.js";
import { dismissible } from "../js/sheet.js";
import { injectStyles } from "../js/ui.js";

/** Match MAX_AUDIO_MS, AUDIO_BYTES and WAVE_BARS in src/social/limits.ts. */
const MAX_MS = 3 * 60_000;
const MAX_BYTES = 640 * 1024;
const BARS = 40;
const TYPES = ["audio/webm;codecs=opus", "audio/mp4"];
/** Voice, not music: Opus is clear at this rate, and three minutes are about 540KB. */
const BITRATE = 24_000;
/** Shorter than this is a slip of the finger, not a memo. */
const MIN_MS = 1000;

const CSS = `
.rc{text-align:center}
.rc.dlg h2{margin-left:36px}
.rc-bars{display:flex;align-items:center;justify-content:center;gap:3px;height:56px;margin-top:18px}
.rc-bars i{flex:none;width:3px;height:6%;border-radius:2px;background:var(--f);opacity:.5}
.rc.on .rc-bars i{background:var(--go);opacity:1}
.rc-time{margin:10px 0 0;font:600 20px/1.2 var(--ff);font-variant-numeric:tabular-nums}
.rc.on .rc-time{color:var(--dn)}
.rc-go{position:relative;display:block;width:68px;height:68px;margin:14px auto 0;padding:0;
 border:3px solid var(--b);border-radius:50%;background:none;cursor:pointer}
.rc-go::after{content:"";position:absolute;inset:6px;border-radius:50%;background:var(--dn);
 transition:inset .15s ease-out,border-radius .15s ease-out}
.rc.on .rc-go::after{inset:19px;border-radius:5px}
.rc-go:focus-visible{outline:2px solid var(--go);outline-offset:3px}
.rc-go:disabled{opacity:.6;cursor:progress}
.rc .hint{margin-top:10px;font-size:13px}
@media (prefers-reduced-motion:reduce){.rc-go::after{transition:none}}
`;

/** Loudness from 0 to 1: -60 dB is silence, -10 dB is as loud as a bar gets. */
function loudness(samples) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/**
 * Forty bars from every sample taken, each bar the loudest moment in its
 * stretch of time. Scaled so the loudest bar is full height: a quiet voice
 * and a loud one both draw a shape, not a flat line. Not past the floor,
 * though, or a memo of nothing but a room's hum would draw as shouting.
 * @param {[number, number][]} samples [ms, loudness]
 */
function shape(samples, ms, b64) {
  const bars = new Array(BARS).fill(-1);
  for (const [at, v] of samples) {
    const i = Math.min(BARS - 1, Math.floor((at / ms) * BARS));
    bars[i] = Math.max(bars[i], v);
  }
  // A stretch with no sample (a tab put away slows the timer) takes its neighbour's.
  for (let i = 0; i < BARS; i++) if (bars[i] < 0) bars[i] = i ? bars[i - 1] : 0;
  const top = Math.max(...bars, 0.4);
  return bars.map((v) => b64[Math.round((v / top) * 63)]).join("");
}

function micError(cause) {
  if (cause?.name === "NotAllowedError") return "Microphone access is off. Allow it for this site to record.";
  if (cause?.name === "NotFoundError") return "No microphone found.";
  return "Could not start the microphone.";
}

/** @type {null | {dialog: HTMLDialogElement, bars: HTMLElement, time: HTMLElement, go: HTMLButtonElement, hint: HTMLElement, err: HTMLElement}} */
let ui = null;
/** Counts openings, so a microphone granted after its dialog was closed and opened again is let go. */
let opened = 0;

function build() {
  const bars = el("div", { class: "rc-bars", "aria-hidden": "true" });
  for (let i = 0; i < BARS; i++) bars.append(el("i"));
  const time = el("p", { class: "rc-time", text: "0:00" });
  const go = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "rc-go" }));
  const hint = el("p", { class: "hint" });
  const err = el("p", { class: "err", role: "alert" });
  const dialog = /** @type {HTMLDialogElement} */ (
    el("dialog", { class: "rc", "aria-labelledby": "rct" }, el("h2", { id: "rct", text: "Voice memo" }), bars, time, go, hint, err)
  );
  document.body.append(dialog);
  dismissible(dialog);
  return { dialog, bars, time, go, hint, err };
}

/** The last forty moments, newest on the right, while the microphone is open. */
function meter(levels) {
  const bars = /** @type {HTMLElement[]} */ ([...ui.bars.children]);
  const from = levels.length - bars.length;
  bars.forEach((bar, i) => {
    const v = levels[from + i]?.[1] ?? 0;
    bar.style.height = `${6 + Math.round(v * 94)}%`;
  });
}

/**
 * Open the recorder. Resolves with the memo once it is stopped, or with null
 * when the dialog is closed first, which throws away anything recorded.
 *
 * `ctx` is social.js's own clock and bar alphabet, handed over so this
 * bundle carries no copies and the memo is spelled the way it will be read.
 * @param {{clock: (ms: number) => string, B64: string}} ctx
 * @returns {Promise<null | {blob: Blob, ms: number, wave: string}>}
 */
export function record({ clock, B64 }) {
  injectStyles("rc-css", CSS);
  ui ??= build();
  const { dialog, time, go, hint, err } = ui;
  const opening = ++opened;

  /** The open recording, or null while the dialog waits for the button. */
  let take = null;
  let settle;

  function idle(message) {
    take = null;
    dialog.classList.remove("on");
    go.disabled = false;
    go.setAttribute("aria-label", "Record");
    time.textContent = "0:00";
    hint.textContent = "Tap to record. Up to 3 minutes.";
    err.textContent = message || "";
    meter([]);
  }

  async function start() {
    go.disabled = true;
    err.textContent = "";
    // Made inside the tap, so iOS lets it run; the microphone prompt comes after.
    const context = new AudioContext();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (cause) {
      context.close();
      idle(micError(cause));
      return;
    }
    const release = () => {
      for (const track of stream.getTracks()) track.stop();
      context.close();
    };
    if (!dialog.open || opening !== opened) return release();
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    let recorder;
    let analyser;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: BITRATE } : { audioBitsPerSecond: BITRATE });
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
    } catch {
      release();
      idle("This browser cannot record audio.");
      return;
    }
    context.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    /** @type {[number, number][]} */
    const levels = [];
    const chunks = [];
    let bytes = 0;
    let began = 0;
    let tick = 0;

    const current = {
      /** Stop the microphone. `keep` hands the recording to the composer; otherwise it is dropped. */
      stop(keep) {
        if (take !== current) return;
        take = null;
        clearInterval(tick);
        const ms = began ? Math.round(performance.now() - began) : 0;
        recorder.onstop = () => {
          release();
          if (!keep) return;
          if (ms < MIN_MS) return idle("Too short. Hold on a little longer.");
          const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
          settle({ blob, ms: Math.min(ms, MAX_MS), wave: shape(levels, ms, B64) });
          dialog.close();
        };
        if (recorder.state !== "inactive") recorder.stop();
        else recorder.onstop();
      },
    };
    take = current;

    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      // A browser that encodes heavier than asked reaches the ceiling before three minutes.
      if (bytes > MAX_BYTES - 16 * 1024) current.stop(true);
    };
    recorder.onstart = () => {
      began = performance.now();
      dialog.classList.add("on");
      go.disabled = false;
      go.setAttribute("aria-label", "Stop");
      hint.textContent = "Recording. Tap to stop.";
      tick = window.setInterval(() => {
        const at = performance.now() - began;
        analyser.getFloatTimeDomainData(samples);
        levels.push([at, loudness(samples)]);
        meter(levels);
        time.textContent = clock(at);
        if (at >= MAX_MS) current.stop(true);
      }, 50);
    };
    recorder.onerror = () => {
      current.stop(false);
      idle("Recording stopped unexpectedly.");
    };
    // A chunk a second, so the byte ceiling is watched while recording, not after.
    recorder.start(1000);
  }

  go.onclick = () => {
    if (take) take.stop(true);
    else if (!go.disabled) start();
  };

  idle();
  dialog.showModal();
  return new Promise((resolve) => {
    settle = resolve;
    // Closed with the X, a tap outside, or Escape: whatever was recording goes.
    dialog.addEventListener(
      "close",
      () => {
        take?.stop(false);
        resolve(null);
      },
      { once: true },
    );
  });
}

window.__rec = { record };
