/**
 * Seed data for Social, for trying the timeline on a dev database.
 *
 *   npm run seed                  fourteen accounts, a few days of posts,
 *                                 re-posts, comments, saves and friends. Run
 *                                 again after adding people here, it adds just
 *                                 them, and what touches them
 *   npm run seed -- --me <name>   also: your account adds three of them and
 *                                 saves four posts, so Friends and Saved have
 *                                 something in them
 *   npm run seed -- --reset       take the seed out and put it back, dated
 *                                 from now (combine with --me)
 *   npm run seed -- --remove      take the seed out
 *
 * Every account's password is SEED_PASSWORD, so any of them can be signed in
 * as. Their recovery phrases come from their names, so an account the seed
 * did not make is never mistaken for one it did, whatever it is called. That
 * also makes their wallets derivable from this file: they are for a dev
 * database, never for one that holds anything.
 *
 * It goes through the same functions the routes use, so rows, files and
 * notifications land as a real post, comment or save would. Photos are
 * drawn here, and each account gets the picture sign-up draws; the voice
 * memos are recordings in assets/seed.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { Client } from "pg";
import sharp from "sharp";
import { TERMS_VERSION } from "../config";
import { newPassword, sealForServer, sealPhrase } from "./auth";
import type { AudioKind } from "./audio";
import { drawAvatar } from "./avatar";
import {
  addComment,
  addFriend,
  closePool,
  createPost,
  databaseUrl,
  ensureSchema,
  getUser,
  insertUser,
  repost,
  toggleSave,
} from "./db";
import { mnemonicFromEntropy, solanaAddress } from "./keys";
import { PHOTO_BYTES, PHOTO_SMALL_BYTES } from "./limits";
import { removePostAudio, removePostPhotos, writeAvatar } from "./store";

const SEED_PASSWORD = "seed-password";

const MINUTE = 60_000;
const ASSETS = path.join(__dirname, "..", "..", "assets", "seed");

type Person = { name: string; bio: string; loc: string };

const PEOPLE: Person[] = [
  { name: "mara", bio: "Photos, mostly. Film when I can afford it.", loc: "Lisbon" },
  { name: "tobi_k", bio: "Builds things on Solana. Breaks them on Fridays.", loc: "Lagos" },
  { name: "ines", bio: "Voice notes, bike rides, too much coffee.", loc: "Berlin" },
  { name: "rajiv", bio: "Product, cricket, and very long walks.", loc: "Bangalore" },
  { name: "yuki", bio: "Ramen cartographer.", loc: "Osaka" },
  { name: "oskar", bio: "Weather watcher. Occasional sunsets.", loc: "Oslo" },
  // Picked so their pictures' colours cover the wheel the six above leave open.
  { name: "mei", bio: "Illustrator. Mostly cats, sometimes buildings.", loc: "Taipei" },
  { name: "sanne", bio: "Cycling, stroopwafels, and spreadsheets.", loc: "Utrecht" },
  { name: "kwame", bio: "Music producer. Loops in progress.", loc: "Accra" },
  { name: "lena", bio: "Sailing when the wind allows.", loc: "Hamburg" },
  { name: "theo", bio: "Maths teacher by day, chess by night.", loc: "Athens" },
  { name: "elif", bio: "Tea, typography, and tram rides.", loc: "Istanbul" },
  { name: "ayla", bio: "Night-sky photographer.", loc: "Reykjavík" },
  { name: "chidi", bio: "Backend engineer. Jollof rankings on request.", loc: "Enugu" },
];

/** Recorded with macOS `say`; the length and shape as the recorder would have measured them. */
const MEMOS: Record<string, { file: string; kind: AudioKind; ms: number; wave: string }> = {
  ines: { file: "ines.webm", kind: "webm", ms: 9105, wave: "A878765J8996868--667999-6775m_-98-7675AA" },
  rajiv: { file: "rajiv.webm", kind: "webm", ms: 8580, wave: "A6889-999n97k_45_90_9699972Y996777878mAA" },
  yuki: { file: "yuki.webm", kind: "webm", ms: 7394, wave: "AU9_--885q77_-85A799968-_-87e8--8-975JAA" },
  oskar: { file: "oskar.m4a", kind: "m4a", ms: 4889, wave: "AAO4-4-96Ar8---6-_599--97ME0---v9_7zAAAA" },
};

type Scene = "sunset" | "mountains" | "city" | "blobs" | "field";
/** A scene, and the pixel size of its desktop file. */
type Shot = [Scene, number, number];

/** `ago` is minutes before the seed runs. One author's posts sit ten minutes apart at least, as the route requires. */
type SeedPost = { key: string; by: string; ago: number; text?: string; photos?: Shot[]; memo?: keyof typeof MEMOS };

const POSTS: SeedPost[] = [
  { key: "m1", by: "mara", ago: 25, text: "Golden hour over the Tagus. No filter, just luck.", photos: [["sunset", 960, 640]] },
  { key: "m2", by: "mara", ago: 290, text: "Alfama after dark.", photos: [["city", 720, 960]] },
  { key: "m8", by: "mara", ago: 800, text: "Anyone know a lab in Lisbon that still develops 120 the same day?" },
  {
    key: "m3",
    by: "mara",
    ago: 1500,
    text: "Three days in the Serra da Estrela. Legs are gone, camera roll is full.",
    photos: [["mountains", 960, 640], ["mountains", 960, 720], ["field", 960, 640]],
  },
  {
    key: "m4",
    by: "mara",
    ago: 2900,
    text: "Film or digital? I keep going back and forth. Film makes me slow down, digital makes me brave. @oskar you shoot both, right?",
  },
  { key: "m5", by: "mara", ago: 4300, photos: [["blobs", 960, 960], ["blobs", 960, 960], ["blobs", 960, 960], ["blobs", 960, 960]] },
  { key: "m6", by: "mara", ago: 5800, text: "Rent a 50mm for a week before you buy one. Best advice I ever got." },
  { key: "m7", by: "mara", ago: 7000, text: "First light.", photos: [["field", 960, 540]] },

  { key: "t1", by: "tobi_k", ago: 55, text: "Shipped the fix. It was a missing await. It is always a missing await." },
  { key: "t8", by: "tobi_k", ago: 150, text: "www.jup.ag has the cleanest swap screen I've used, fight me." },
  {
    key: "t2",
    by: "tobi_k",
    ago: 400,
    text: "Reading https://solana.com/docs/core/fees again. Priority fees make a lot more sense once you've watched a transaction sit in the queue.",
  },
  { key: "t3", by: "tobi_k", ago: 1200, text: "Hot take: the best dev tool is a notebook and a pen. The second best is console.log." },
  { key: "t4", by: "tobi_k", ago: 2100, text: "@rajiv how did the demo go?" },
  {
    key: "t5",
    by: "tobi_k",
    ago: 3600,
    text: "Lagos from the 14th floor. The traffic looks peaceful from up here, which is a lie.",
    photos: [["city", 960, 640]],
  },
  { key: "t6", by: "tobi_k", ago: 5000, text: "Weekend project: a tiny wallet that only holds snack money. Guardrails are a feature." },
  {
    key: "t7",
    by: "tobi_k",
    ago: 6500,
    // Exactly MAX_POST characters, to see the longest a post can be.
    text: "Things I wish someone told me before my first mainnet deploy: simulate everything, then simulate it again. Keep the upgrade authority somewhere boring. Write down every address. Log more than you think you need. Sleep before you ship, not after. Tea helps.",
  },

  { key: "i1", by: "ines", ago: 12, memo: "ines" },
  { key: "i2", by: "ines", ago: 700, text: "The cardamom bun place is back!! (https://en.wikipedia.org/wiki/Cardamom_bun)." },
  { key: "i5", by: "ines", ago: 1400, text: "@mara your Serra photos made me book a train ticket. Thanks, I think." },
  { key: "i3", by: "ines", ago: 1800, text: "Tempelhofer Feld on a Sunday.", photos: [["field", 960, 720], ["sunset", 960, 720]] },
  {
    key: "i4",
    by: "ines",
    ago: 3000,
    text: "Bike got a flat halfway to work. Walked the rest, heard three different birds I can't name. Net positive.",
  },
  { key: "i6", by: "ines", ago: 6000, text: "New week, new notebook." },

  { key: "r1", by: "rajiv", ago: 95, text: "First voice memo, go easy on me.", memo: "rajiv" },
  { key: "r7", by: "rajiv", ago: 500, text: "Product lesson of the week: if you have to explain the button, the button is wrong." },
  { key: "r2", by: "rajiv", ago: 1000, text: "Demo went well! @tobi_k thanks for the late-night debugging." },
  { key: "r3", by: "rajiv", ago: 2400, text: "Long walk, no podcast. Recommend." },
  { key: "r4", by: "rajiv", ago: 3300, text: "Nandi Hills at 5am. Worth every yawn.", photos: [["mountains", 720, 960]] },
  { key: "r5", by: "rajiv", ago: 4500, text: "Cricket on the radio, chai on the stove. Perfect Sunday." },
  { key: "r6", by: "rajiv", ago: 6200, text: "What's one app you'd pay for twice?" },

  { key: "y1", by: "yuki", ago: 40, text: "Noodle day, as promised.", memo: "yuki", photos: [["blobs", 960, 720]] },
  {
    key: "y2",
    by: "yuki",
    ago: 600,
    text: "Every ramen shop I've tried this year: www.openstreetmap.org/#map=13/34.6937/135.5023 (the pins are in my head).",
  },
  { key: "y3", by: "yuki", ago: 1900, text: "Dotonbori, ten minutes before the rain.", photos: [["city", 960, 960], ["city", 960, 960]] },
  { key: "y4", by: "yuki", ago: 3900, text: "Rainy season playlist suggestions? Bonus points for anything with a cello." },
  { key: "y5", by: "yuki", ago: 5500, text: "ラーメン is a food group." },
  { key: "y6", by: "yuki", ago: 7100, text: "Hello from Osaka 👋" },

  { key: "o2", by: "oskar", ago: 185, text: "As promised.", photos: [["sunset", 960, 640], ["sunset", 960, 640], ["sunset", 640, 960]] },
  { key: "o1", by: "oskar", ago: 200, memo: "oskar" },
  { key: "o3", by: "oskar", ago: 2600, text: "It snowed. In September. Oslo, please." },
  { key: "o4", by: "oskar", ago: 5200, text: "Weather app says 12°. My hands say 4." },

  { key: "n1", by: "mei", ago: 8, text: "Drew my neighbour's cat again. He did not consent.", photos: [["blobs", 960, 960]] },
  { key: "n9", by: "mei", ago: 400, text: "Sketchbook number twelve, first page." },
  { key: "n2", by: "sanne", ago: 16, text: "37 km before breakfast. Now it's stroopwafel o'clock." },
  { key: "n3", by: "kwame", ago: 33, text: "Anyone else make beats on the bus? Asking for me." },
  { key: "n4", by: "lena", ago: 47, text: "Wind finally came back.", photos: [["sunset", 960, 640]] },
  {
    key: "n5",
    by: "theo",
    ago: 65,
    text: "Puzzle of the day: can a knight visit every square of a 5×5 board exactly once? (Yes. Now find it.)",
  },
  { key: "n10", by: "theo", ago: 600, text: "Students asked if maths is used in real life. I showed them a bus timetable." },
  { key: "n6", by: "elif", ago: 90, text: "The 7am tram to Kadıköy is the best seat in the city.", photos: [["city", 960, 720]] },
  { key: "n7", by: "ayla", ago: 120, text: "Aurora forecast says 6 out of 9 tonight. Staying up.", photos: [["mountains", 960, 640]] },
  { key: "n8", by: "chidi", ago: 140, text: "Ranking jollof is a serious matter and I will not be taking questions." },
];

/** [who, post, minutes ago] */
const REPOSTS: [string, string, number][] = [
  ["ines", "m1", 20],
  ["tobi_k", "r1", 80],
  ["yuki", "o2", 150],
  ["rajiv", "t2", 350],
  ["mara", "y2", 500],
  ["oskar", "m3", 1300],
  ["lena", "n7", 100],
  ["elif", "n5", 50],
];

/** [who, post, minutes ago, text] */
const COMMENTS: [string, string, number, string][] = [
  ["ines", "m1", 22, "This is unreal."],
  ["oskar", "m1", 18, "The Tagus showing off again."],
  ["yuki", "m1", 10, "Wallpaper, thanks."],
  ["rajiv", "t1", 50, "The await always gets you."],
  ["tobi_k", "r1", 85, "Sounds great! More of these."],
  ["ines", "r1", 60, "Welcome to the voice memo club."],
  ["mara", "y1", 30, "Which shop??"],
  ["yuki", "y1", 28, "The tiny one behind the station. No sign, just a queue."],
  ["ines", "m3", 1450, "Booking a train, brb."],
  ["mara", "o3", 2500, "Stay warm!"],
  ["rajiv", "t4", 2050, "Tomorrow! Nervous."],
  ["oskar", "m8", 700, "Try the one near Cais do Sodré, they did mine in a few hours."],
  ["yuki", "i2", 650, "Save me one."],
  ["rajiv", "y4", 3800, "Anything with Yo-Yo Ma, obviously."],
  ["tobi_k", "r6", 6100, "A good password manager."],
  ["mara", "r6", 6000, "Lightroom, sadly."],
  ["sanne", "n1", 5, "The cat looks thrilled."],
  ["kwame", "n2", 12, "Respect."],
  ["ayla", "n4", 40, "That sky though."],
  ["theo", "n6", 80, "Saving this for my next trip."],
  ["mara", "n7", 110, "Jealous. Post the photos!"],
  ["chidi", "n8", 128, "No questions, I said."],
  ["tobi_k", "n8", 130, "Nigerian jollof, obviously."],
];

/** [who, post] */
const SAVES: [string, string][] = [
  ["mara", "y3"],
  ["mara", "i3"],
  ["mara", "t2"],
  ["ines", "m1"],
  ["ines", "m3"],
  ["ines", "y1"],
  ["ines", "r1"],
  ["ines", "o2"],
  ["tobi_k", "r7"],
  ["tobi_k", "i2"],
  ["rajiv", "t2"],
  ["rajiv", "t7"],
  ["rajiv", "m6"],
  ["yuki", "m5"],
  ["yuki", "o1"],
  ["oskar", "m3"],
  ["ines", "n7"],
  ["ayla", "n6"],
  ["mara", "n1"],
];

/** [who, whom]. Adding is one way. */
const FRIENDS: [string, string][] = [
  ["mara", "ines"],
  ["mara", "yuki"],
  ["mara", "oskar"],
  ["tobi_k", "rajiv"],
  ["tobi_k", "mara"],
  ["ines", "mara"],
  ["ines", "rajiv"],
  ["ines", "yuki"],
  ["rajiv", "tobi_k"],
  ["rajiv", "ines"],
  ["yuki", "mara"],
  ["yuki", "ines"],
  ["yuki", "oskar"],
  ["oskar", "mara"],
  ["mei", "elif"],
  ["elif", "mei"],
  ["theo", "sanne"],
  ["sanne", "theo"],
  ["ayla", "lena"],
  ["lena", "ayla"],
  ["kwame", "chidi"],
  ["chidi", "kwame"],
  ["mara", "ayla"],
];

/** What --me adds for your account: people, then posts to save. */
const FOR_ME = { friends: ["mara", "ines", "rajiv"], saves: ["m1", "y1", "t2", "o1"] };

// —— Pictures ——

/** mulberry32: the same pictures every run. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h) % 360} ${s}% ${l}%)`;

function gradient(id: string, stops: string[]): string {
  const step = 1 / (stops.length - 1);
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops
    .map((color, i) => `<stop offset="${(i * step).toFixed(2)}" stop-color="${color}"/>`)
    .join("")}</linearGradient>`;
}

/** A ridge line across the width, `y` down from the top, as a filled polygon. */
function ridge(w: number, h: number, y: number, rough: number, r: () => number): string {
  const points = [`0,${h}`];
  let at = y;
  for (let x = 0; x <= w; x += w / 24) {
    at += (r() - 0.5) * rough;
    points.push(`${x.toFixed(0)},${at.toFixed(0)}`);
  }
  points.push(`${w},${h}`);
  return points.join(" ");
}

function scene(kind: Scene, w: number, h: number, seed: number): string {
  const r = random(seed);
  const hue = r() * 360;
  let body = "";
  let defs = "";
  if (kind === "sunset") {
    const horizon = h * (0.55 + r() * 0.1);
    defs = gradient("sky", [hsl(250 + r() * 30, 45, 22), hsl(12 + r() * 20, 75, 60), hsl(40, 95, 78)]);
    defs += gradient("sea", [hsl(225, 45, 32), hsl(250, 40, 16)]);
    const sx = w * (0.3 + r() * 0.4);
    body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${sx}" cy="${horizon}" r="${Math.min(w, h) * 0.09}" fill="${hsl(45, 100, 85)}"/>
      <rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#sea)"/>`;
    for (let i = 0; i < 9; i++) {
      const y = horizon + 6 + i * ((h - horizon) / 10);
      const half = (w * 0.12 * (1 - i / 12)) * (0.6 + r() * 0.6);
      body += `<rect x="${sx - half}" y="${y}" width="${half * 2}" height="${3 + i * 0.6}" rx="2" fill="${hsl(40, 95, 75)}" opacity="${0.75 - i * 0.07}"/>`;
    }
  } else if (kind === "mountains") {
    defs = gradient("sky", [hsl(205, 60, 62), hsl(200, 55, 88)]);
    body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${w * (0.15 + r() * 0.7)}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.06}" fill="${hsl(50, 100, 95)}"/>`;
    for (let i = 0; i < 4; i++) {
      body += `<polygon points="${ridge(w, h, h * (0.38 + i * 0.13), h * 0.09, r)}" fill="${hsl(hue * 0.2 + 200 + i * 12, 22 + i * 6, 58 - i * 12)}"/>`;
    }
  } else if (kind === "city") {
    defs = gradient("sky", [hsl(235, 50, 12), hsl(265, 35, 30)]);
    body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${w * (0.6 + r() * 0.3)}" cy="${h * 0.16}" r="${Math.min(w, h) * 0.045}" fill="${hsl(50, 60, 88)}"/>`;
    for (let x = -10; x < w; ) {
      const bw = w * (0.07 + r() * 0.08);
      const top = h * (0.35 + r() * 0.35);
      body += `<rect x="${x}" y="${top}" width="${bw}" height="${h - top}" fill="${hsl(240, 18, 10 + r() * 8)}"/>`;
      for (let y = top + 10; y < h - 12; y += 18) {
        for (let wx = x + 6; wx < x + bw - 8; wx += 14) {
          if (r() < 0.32) body += `<rect x="${wx.toFixed(0)}" y="${y.toFixed(0)}" width="6" height="8" fill="${hsl(42, 95, 70)}"/>`;
        }
      }
      x += bw + 2;
    }
  } else if (kind === "blobs") {
    defs = `<filter id="soft"><feGaussianBlur stdDeviation="${Math.min(w, h) / 14}"/></filter>`;
    body = `<rect width="${w}" height="${h}" fill="${hsl(hue, 45, 90)}"/><g filter="url(#soft)">`;
    for (let i = 0; i < 6; i++) {
      body += `<circle cx="${r() * w}" cy="${r() * h}" r="${Math.min(w, h) * (0.15 + r() * 0.2)}" fill="${hsl(hue + i * 40, 70, 60)}" opacity="0.8"/>`;
    }
    body += "</g>";
  } else {
    defs = gradient("sky", [hsl(200, 70, 70), hsl(45, 80, 88)]);
    body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${w * (0.2 + r() * 0.6)}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.07}" fill="${hsl(48, 100, 92)}"/>`;
    for (let i = 0; i < 3; i++) {
      const y = h * (0.55 + i * 0.12);
      body += `<ellipse cx="${w * (0.2 + r() * 0.6)}" cy="${y + h * 0.3}" rx="${w * (0.6 + r() * 0.3)}" ry="${h * 0.32}" fill="${hsl(95 + i * 8 + r() * 10, 40 + i * 5, 48 - i * 8)}"/>`;
    }
    for (let i = 0; i < 5; i++) {
      const x = r() * w;
      const y = h * (0.6 + r() * 0.1);
      body += `<rect x="${x - 2}" y="${y}" width="4" height="${h * 0.06}" fill="${hsl(25, 30, 25)}"/><circle cx="${x}" cy="${y}" r="${h * 0.035}" fill="${hsl(120, 35, 28)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;
}

/** Stepped down in quality until it fits, as the browser's own shrink does. */
async function jpeg(svg: string, w: number, h: number, maxBytes: number): Promise<Buffer> {
  for (let quality = 84; quality >= 30; quality -= 8) {
    const out = await sharp(Buffer.from(svg)).resize(w, h).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= maxBytes) return out;
  }
  throw new Error(`seed: a ${w}×${h} picture does not fit in ${maxBytes} bytes`);
}

/** The desktop file at the shot's size and the phone file at half, drawn from the same scene. */
async function photo([kind, w, h]: Shot, seed: number): Promise<{ full: Buffer; small: Buffer }> {
  const svg = scene(kind, w, h, seed);
  return {
    full: await jpeg(svg, w, h, PHOTO_BYTES),
    small: await jpeg(svg, Math.round(w / 2), Math.round(h / 2), PHOTO_SMALL_BYTES),
  };
}

// —— Accounts ——

/** From the name, so the seed knows its own accounts by address. */
function phraseFor(name: string): string {
  return mnemonicFromEntropy(createHash("sha256").update(`utopian-go seed ${name}`).digest().subarray(0, 16));
}

async function createAccount(person: Person, now: number): Promise<void> {
  const phrase = phraseFor(person.name);
  const [pass, box] = await Promise.all([newPassword(SEED_PASSWORD), sealPhrase(phrase, SEED_PASSWORD)]);
  const inserted = await insertUser({
    name: person.name,
    uid: createHash("sha256").update(`utopian-go seed uid ${person.name}`).digest().subarray(0, 16).toString("base64url"),
    passSalt: pass.salt,
    passHash: pass.hash,
    phraseSalt: box.salt,
    phraseIv: box.iv,
    phraseTag: box.tag,
    phraseCt: box.ct,
    address: solanaAddress(phrase),
    bio: person.bio,
    loc: person.loc,
    avatarRev: 1,
    lastPost: 0,
    passkey: null,
    created: now - 30 * 24 * 60 * MINUTE,
    epoch: 0,
    keyBox: sealForServer(phrase),
    terms: { version: TERMS_VERSION, at: now - 30 * 24 * 60 * MINUTE },
  });
  if (!inserted) throw new Error(`seed: ${person.name} was taken while seeding`);
  // The picture any new account starts with (./avatar.ts), drawn in its name's colours.
  const pic = await drawAvatar(person.name);
  writeAvatar(person.name, pic.full, pic.tiny);
}

/**
 * Everything the seed accounts made, and whatever points at it: anyone's
 * re-posts of their posts go first, since those reference them, then their
 * comments and notes elsewhere, then their posts (taking the comments and
 * saves on them), then the accounts (taking friends, saves, notes to them and
 * Messenger). The files go once the rows are gone.
 */
async function wipe(names: string[]): Promise<number> {
  if (!names.length) return 0;
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  let files: { id: string; photos: number; audio: number }[];
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM posts WHERE repost IN (SELECT id FROM posts WHERE by_name = ANY($1))", [names]);
    await client.query("DELETE FROM comments WHERE by_name = ANY($1)", [names]);
    await client.query("DELETE FROM notes WHERE from_name = ANY($1)", [names]);
    const gone = await client.query<{ id: string; photos: number; audio: number; repost: string | null }>(
      "DELETE FROM posts WHERE by_name = ANY($1) RETURNING id, photos, audio, repost",
      [names],
    );
    await client.query("DELETE FROM users WHERE name = ANY($1)", [names]);
    await client.query("COMMIT");
    // A re-post's counts are its original's; the files are only under the original's id.
    files = gone.rows.filter((row) => !row.repost);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
  for (const post of files) {
    removePostPhotos(post.id, post.photos);
    if (post.audio) removePostAudio(post.id);
  }
  return files.length;
}

// —— The run ——

function refuse(message: string): never {
  console.error(`seed: ${message}`);
  process.exit(1);
}

/** Never production, and never a database elsewhere unless asked by name. */
function guard(args: string[]): void {
  if (process.env.NODE_ENV === "production") refuse("refusing to seed with NODE_ENV=production.");
  const host = new URL(databaseUrl()).hostname;
  const local = ["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  if (!local && !args.includes("--remote")) {
    refuse(`DATABASE_URL points at ${host}, not this machine. Pass --remote if that is really a dev database.`);
  }
}

async function run(args: string[]): Promise<void> {
  guard(args);
  const meAt = args.indexOf("--me");
  const me = meAt >= 0 ? args[meAt + 1]?.toLowerCase() : "";
  if (meAt >= 0 && !me) refuse("--me needs your username.");
  await ensureSchema();

  // A name the seed uses, held by an account it did not make, is left alone and stops the run.
  const ours: string[] = [];
  for (const person of PEOPLE) {
    const user = await getUser(person.name);
    if (!user) continue;
    if (user.address !== solanaAddress(phraseFor(person.name))) {
      refuse(`${person.name} is someone's real account here. Rename that person in PEOPLE (src/social/seed.ts).`);
    }
    ours.push(person.name);
  }
  if (me) {
    if (PEOPLE.some((person) => person.name === me)) refuse(`${me} is a seed account; --me is for yours.`);
    if (!(await getUser(me))) refuse(`there is no account called ${me}. Sign up first, then run this again.`);
  }

  if (args.includes("--remove")) {
    const posts = await wipe(ours);
    console.log(ours.length ? `Removed ${ours.length} seed accounts and ${posts} posts.` : "Nothing seeded to remove.");
    return;
  }
  // Seeded before and not asked to start over: add whoever PEOPLE has gained
  // since, with their posts and what touches them, and leave the rest alone.
  const topUp = ours.length > 0 && !args.includes("--reset");
  const adding = topUp ? PEOPLE.filter((person) => !ours.includes(person.name)) : PEOPLE;
  if (!adding.length) {
    console.log("Already seeded. `npm run seed -- --reset` takes it out and seeds again, dated from now.");
    return;
  }
  if (topUp && me) refuse("--me goes with a whole seed. Add --reset, or leave --me off to add the new people.");
  if (!topUp) await wipe(ours);
  const fresh = new Set(adding.map((person) => person.name));
  // Each keeps its place in POSTS, which is what its pictures are drawn from.
  const posts = POSTS.map((p, n) => ({ ...p, n })).filter((p) => fresh.has(p.by));
  const keys = new Set(posts.map((p) => p.key));
  const reposts = REPOSTS.filter(([, key]) => keys.has(key));
  const comments = COMMENTS.filter(([, key]) => keys.has(key));

  const now = Date.now();
  const at = (ago: number) => now - ago * MINUTE;
  for (const person of adding) await createAccount(person, now);
  for (const [owner, friend] of FRIENDS) if (fresh.has(owner) || fresh.has(friend)) await addFriend(owner, friend);

  // Oldest first, as it would have happened, so each thing exists before anything refers to it.
  const ids = new Map<string, string>();
  const post = (key: string) => {
    const id = ids.get(key);
    if (!id) throw new Error(`seed: ${key} is referred to before it is posted`);
    return id;
  };
  type Step = { ago: number; go: () => Promise<void> };
  const steps: Step[] = [
    ...posts.map((p) => ({
      ago: p.ago,
      go: async () => {
        const photos = await Promise.all((p.photos ?? []).map((shot, i) => photo(shot, p.n * 16 + i + 1)));
        const memo = p.memo ? { ...MEMOS[p.memo], bytes: readFileSync(path.join(ASSETS, MEMOS[p.memo].file)) } : null;
        const made = await createPost(p.by, p.text ?? "", at(p.ago), photos, memo);
        if ("wait" in made) throw new Error(`seed: ${p.key} is under ten minutes after ${p.by}'s post before it`);
        ids.set(p.key, made.id);
      },
    })),
    ...reposts.map(([by, key, ago]) => ({ ago, go: () => repost(by, post(key), at(ago)) })),
    // Every seed account has its drawn picture, revision 1.
    ...comments.map(([by, key, ago, text]) => ({
      ago,
      go: async () => {
        await addComment(by, 1, post(key), text, at(ago));
      },
    })),
  ];
  steps.sort((a, b) => b.ago - a.ago);
  for (const step of steps) await step.go();
  for (const [by, key] of SAVES) if (keys.has(key)) await toggleSave(by, post(key), now);

  if (me) {
    for (const friend of FOR_ME.friends) await addFriend(me, friend);
    for (const key of FOR_ME.saves) await toggleSave(me, post(key), now);
  }

  const width = Math.max(...adding.map((person) => person.name.length));
  console.log(
    `${topUp ? "Added" : "Seeded"} ${adding.length} accounts, ${posts.length} posts, ${reposts.length} re-posts, ` +
      `${comments.length} comments.`,
  );
  if (me) console.log(`${me} added ${FOR_ME.friends.join(", ")} and saved ${FOR_ME.saves.length} posts.`);
  console.log(`\nSign in as ${topUp ? "the new ones" : "any of them"} with the password "${SEED_PASSWORD}":`);
  for (const person of adding) console.log(`  ${person.name.padEnd(width)}  ${person.loc}`);
}

if (require.main === module) {
  run(process.argv.slice(2))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
