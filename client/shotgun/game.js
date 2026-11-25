/**
 * Shotgun's field: the rules and the drawing of the zombie waves.
 *
 * The world is measured in units with the field's middle at the origin, its
 * short side 100 units across, so a phone and a desktop play the same game and
 * a resize mid-wave moves nothing. Zombies come in from the field's edges and
 * walk at the player, who walks the field (`move`) and shoots where they aim. Explosive
 * barrels lie about the field; a shot one blows up everything near it, and the
 * barrels near that. From the second wave on, gun crates drop now and then: a
 * shot crate, or one walked over, is that gun, with its ammo. In the middle
 * stands a square fort, a doorway in each of its four walls: the player starts
 * inside it, and zombies come in through the doorways, as nothing walks or
 * shoots through a wall. A crate may hold a sentry turret instead: taken, it
 * is carried until the player places it (`placeTurret`), and then it turns on
 * the nearest zombie it can see and shoots until its rounds run out. Later
 * waves put heavier guns in the crates: the minigun from the fourth, the
 * railgun from the sixth, the rocket blaster from the eighth and the laser
 * from the tenth, each arriving in a crate of its own; and better turrets,
 * minigun turrets from the fifth and, from the seventh, minigun turrets under
 * a dome that keeps zombies out until they have gnawed through it. From the
 * ninth, a biohazard: placed like a turret, it fires nothing but breathes a
 * cloud of gas, and a zombie that walks into it is infected: it loses health
 * slowly until it dies, and passes the infection to zombies that brush past
 * it. From the fifth wave crates come several at once: a gun, a turret (or
 * biohazard) and a health crate that fills the player's health back up, and
 * from the tenth a second gun.
 */

/** @typedef {"pistol" | "shotgun" | "smg" | "rifle" | "minigun" | "railgun" | "rocket" | "laser"} GunId */

/**
 * @typedef {{name: string, tag: string, every: number, pellets: number, spread: number, dmg: number,
 *   speed: number, life: number, pierce: number, ammo: number, len: number, from: number,
 *   kind?: "spin" | "rail" | "rocket" | "laser"}} Gun
 */

/**
 * The guns. `every` is seconds between shots, `speed` units a second, `life`
 * how long a pellet flies; `pierce` how many zombies one passes through;
 * `from` the wave whose crates first hold it. The heavier tiers each work
 * their own way (`kind`): the minigun spins up while held, the railgun's
 * beam crosses the field at once through every zombie on it, a rocket blows
 * up where it lands, and the laser charges a cell, then burns a beam for as
 * long as it is held, up to the cell's 2.5 seconds; its `ammo` is cells and
 * its `dmg` a second: a railgun's hit, held on.
 * @type {Record<GunId, Gun>}
 */
export const GUNS = {
  pistol: { name: "Pistol", tag: "PISTOL", every: 0.3, pellets: 1, spread: 0.04, dmg: 1, speed: 120, life: 1.3, pierce: 1, ammo: Infinity, len: 3.2, from: 0 },
  shotgun: { name: "Shotgun", tag: "SHOTGUN", every: 0.68, pellets: 7, spread: 0.5, dmg: 1, speed: 105, life: 0.42, pierce: 1, ammo: 24, len: 5.2, from: 2 },
  smg: { name: "SMG", tag: "SMG", every: 0.085, pellets: 1, spread: 0.15, dmg: 1, speed: 130, life: 1, pierce: 1, ammo: 160, len: 4.2, from: 2 },
  rifle: { name: "Rifle", tag: "RIFLE", every: 0.45, pellets: 1, spread: 0, dmg: 5, speed: 190, life: 1, pierce: 4, ammo: 30, len: 6.4, from: 2 },
  minigun: { name: "Minigun", tag: "MINIGUN", every: 0.045, pellets: 1, spread: 0.2, dmg: 1, speed: 140, life: 0.9, pierce: 1, ammo: 320, len: 5.8, from: 4, kind: "spin" },
  railgun: { name: "Railgun", tag: "RAILGUN", every: 0.95, pellets: 1, spread: 0, dmg: 12, speed: 0, life: 0, pierce: Infinity, ammo: 14, len: 7, from: 6, kind: "rail" },
  rocket: { name: "Rocket Blaster", tag: "ROCKETS", every: 0.8, pellets: 1, spread: 0.03, dmg: 14, speed: 72, life: 1.6, pierce: 1, ammo: 12, len: 6, from: 8, kind: "rocket" },
  laser: { name: "Laser", tag: "LASER", every: 0, pellets: 1, spread: 0, dmg: 40, speed: 0, life: 0, pierce: Infinity, ammo: 5, len: 6.2, from: 10, kind: "laser" },
};

/** The guns this wave's crates can hold: every one unlocked by now but the pistol. */
const drops = () => /** @type {GunId[]} */ (Object.keys(GUNS)).filter((id) => id !== "pistol" && GUNS[id].from <= game.wave);
/** A rocket's blast: how far it reaches, and what it takes from the player standing in it. */
const ROCKET_BLAST = 11;
const ROCKET_HURT = 15;
/** The laser: seconds to charge a cell, and seconds of beam a cell holds. */
const LASER = { charge: 1.1, run: 2.5 };
/** The share of crates that hold a turret rather than a gun. */
const TURRET_DROP = 0.25;

/** @typedef {"sentry" | "minigun" | "dome" | "bio"} TurretKind */
/**
 * The turrets: how far one sees, how often it fires, its rounds, the wave
 * whose crates first hold it, and its dome's strength (none but the last).
 * @type {Record<TurretKind, {name: string, tag: string, range: number, every: number, spread: number, dmg: number, speed: number, rounds: number, from: number, dome: number}>}
 */
export const TURRETS = {
  sentry: { name: "Turret", tag: "", range: 34, every: 0.32, spread: 0.05, dmg: 1, speed: 130, rounds: 60, from: 2, dome: 0 },
  minigun: { name: "Minigun turret", tag: "MINIGUN", range: 38, every: 0.075, spread: 0.14, dmg: 1, speed: 150, rounds: 260, from: 5, dome: 0 },
  dome: { name: "Dome turret", tag: "DOME", range: 38, every: 0.075, spread: 0.14, dmg: 1, speed: 150, rounds: 320, from: 7, dome: 150 },
  // Fires nothing: `range` is its gas cloud's reach, and `rounds` the seconds the gas lasts.
  bio: { name: "Biohazard", tag: "BIOHAZARD", range: 15, every: 0, spread: 0, dmg: 0, speed: 0, rounds: 20, from: 9, dome: 0 },
};
/** An infected zombie: the health it loses a second, and how readily it passes it on to one it brushes past (a second). */
const SICK = { dps: 0.55, spread: 1.4, reach: 2.2 };
/** From this wave crates come several at once: a gun, a turret and a health crate; from `extra`, a second gun. */
const BATCH = { from: 5, extra: 10, every: [13, 19] };
/** Every turret: its size, how many stand at once, how many the player can carry, and a dome's reach. */
const TURRET = { r: 2.6, max: 3, carry: 2, domeR: 10 };
/** The turrets this wave's crates can hold. */
const turretDrops = () => /** @type {TurretKind[]} */ (Object.keys(TURRETS)).filter((k) => TURRETS[k].from <= game.wave);

const PLAYER_R = 3;
/** Units a second the player walks. */
const WALK = 24;
const HP = 100;
const BARRELS = 5;
const BARREL_R = 3.2;
const BLAST = 14;
const CRATE_R = 3;
const CRATE_LIFE = 10;
/** The fort: half its side, its walls' thickness, and each doorway's width. */
const FORT = 18;
const WALL_T = 3;
const DOOR = 11;

/** Seconds between a cleared wave and the next. */
const BETWEEN = 2.6;

/**
 * @typedef {{x: number, y: number, r: number, hp: number, max: number, blue: boolean,
 *   speed: number, bite: number, flash: number, face: number, wob: number,
 *   plan: {door: number, side: number, through: boolean} | null, gnaw: number, sick: number}} Zombie
 * @typedef {{x: number, y: number, vx: number, vy: number, life: number, dmg: number, pierce: number, hit: Set<object>,
 *   sentry?: boolean, kind?: "rocket"}} Bullet
 * @typedef {{x1: number, y1: number, x2: number, y2: number, life: number}} Beam
 * @typedef {{x: number, y: number, hp: number, fuse: number}} Barrel
 * @typedef {{x: number, y: number, gun: GunId | "turret" | "health", tier?: TurretKind, life: number}} Crate
 * @typedef {{x: number, y: number, aim: number, cool: number, rounds: number, muzzle: number, kind: TurretKind, shield: number, hitFx: number}} Turret
 * @typedef {{x: number, y: number, vx: number, vy: number, life: number, max: number, color: string, size: number}} Part
 * @typedef {{x: number, y: number, r: number, color: string, a: number, rot: number}} Decal
 * @typedef {{x: number, y: number, life: number, r: number}} Boom
 * @typedef {{gun: GunId | null, ammo: number, mult: number}} Kit
 */

export const game = {
  /** @type {"idle" | "play" | "over"} */
  state: "idle",
  /** Half the field, in units. */
  hw: 50,
  hh: 50,
  aim: -Math.PI / 2,
  firing: false,
  /** Where the player stands. */
  px: 0,
  py: 0,
  /** Which way they are walking, each −1…1 (keys or the thumb-stick). */
  mx: 0,
  my: 0,
  /** @type {{x: number, y: number, dx: number, dy: number} | null} the walking stick, in units, while a thumb is on it */
  stick: null,
  /** @type {{x: number, y: number, dx: number, dy: number} | null} the aiming stick, likewise */
  aimStick: null,
  step: 0,
  hp: HP,
  hurt: 0,
  wave: 0,
  toSpawn: 0,
  spawnIn: 0,
  between: 0,
  crateIn: 0,
  /** Credits earned this game, before the multiplier: the one count the game keeps. */
  earned: 0,
  mult: 1,
  kills: 0,
  /** @type {GunId} */
  gun: "pistol",
  ammo: Infinity,
  cool: 0,
  /** How far the minigun has spun up, 0…1. */
  spool: 0,
  /** The laser: how far the next cell has charged, 0…1, and the seconds of beam left in this one. */
  charge: 0,
  lase: 0,
  /** @type {{x1: number, y1: number, x2: number, y2: number} | null} the laser's beam this frame */
  ray: null,
  muzzle: 0,
  shake: 0,
  /** @type {Zombie[]} */ zombies: [],
  /** @type {Bullet[]} */ bullets: [],
  /** @type {Barrel[]} */ barrels: [],
  /** @type {Crate[]} */ crates: [],
  /** @type {Turret[]} */ turrets: [],
  /** @type {TurretKind[]} turrets taken and not yet placed, the best first */
  carry: [],
  /** @type {{x: number, y: number} | null} where a turret would go, while the player is placing one */
  ghost: null,
  /** @type {Part[]} */ parts: [],
  /** @type {Decal[]} */ decals: [],
  /** @type {Boom[]} */ booms: [],
  /** @type {Beam[]} the railgun's beams, fading */ beams: [],
  /** The screen's bottom safe area, in device pixels, kept clear by the HUD. */
  inset: 0,
  /** @type {{x: number, y: number}[]} where a touch screen's two sticks stand, kept clear of barrels and crates */
  pads: [],
};

/** @typedef {"shot" | "empty" | "kill" | "boom" | "hurt" | "pickup" | "cleared" | "wave" | "over" | "earn" | "turret" | "placed" | "spent" | "unlock" | "lase" | "dome" | "heal"} Event */
/** @type {(type: Event, data?: any) => void} */
let on = () => {};

/** @param {(type: Event, data?: any) => void} fn */
export function listen(fn) {
  on = fn;
}

/** The credits this game has earned so far, multiplied. */
export const credits = () => Math.floor(game.earned * game.mult);

const rand = (a, b) => a + Math.random() * (b - a);

/** @param {number} hw @param {number} hh */
export function size(hw, hh) {
  game.hw = hw;
  game.hh = hh;
  // A field that changed shape (a phone turned) keeps the player on it and out of the wall.
  if (game.state !== "play") return;
  const me = {
    x: Math.max(-hw + PLAYER_R, Math.min(hw - PLAYER_R, game.px)),
    y: Math.max(-hh + PLAYER_R, Math.min(hh - PLAYER_R, game.py)),
  };
  offWall(me, PLAYER_R);
  game.px = me.x;
  game.py = me.y;
}

/**
 * The fort's walls as boxes: each side in two runs, from its corners to its
 * doorway. A box each, so the fort holds still whatever shape the field is.
 */
const FORT_WALLS = (() => {
  const S = FORT;
  const g = DOOR / 2;
  const t = WALL_T;
  return [
    { x0: -S, y0: -S, x1: -g, y1: -S + t },
    { x0: g, y0: -S, x1: S, y1: -S + t },
    { x0: -S, y0: S - t, x1: -g, y1: S },
    { x0: g, y0: S - t, x1: S, y1: S },
    { x0: -S, y0: -S, x1: -S + t, y1: -g },
    { x0: -S, y0: g, x1: -S + t, y1: S },
    { x0: S - t, y0: -S, x1: S, y1: -g },
    { x0: S - t, y0: g, x1: S, y1: S },
  ];
})();
const walls = () => FORT_WALLS;

/** The doorways, as their middles and which way is out. */
const DOORS = [
  { x: 0, y: -FORT, ox: 0, oy: -1 },
  { x: 0, y: FORT, ox: 0, oy: 1 },
  { x: -FORT, y: 0, ox: -1, oy: 0 },
  { x: FORT, y: 0, ox: 1, oy: 0 },
];

/** Whether the fort is inside of a point. @param {number} x @param {number} y */
const inFort = (x, y) => Math.max(Math.abs(x), Math.abs(y)) < FORT - WALL_T / 2;

/**
 * Whether a straight walk of something r wide from one point to another runs
 * into a wall (each box grown by r, a segment against it by slabs).
 */
function walled(x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const w of walls()) {
    let t0 = 0;
    let t1 = 1;
    const slabs = [
      [-dx, x1 - (w.x0 - r)],
      [dx, w.x1 + r - x1],
      [-dy, y1 - (w.y0 - r)],
      [dy, w.y1 + r - y1],
    ];
    let hit = true;
    for (const [pp, q] of slabs) {
      if (pp === 0) {
        if (q < 0) hit = false;
        continue;
      }
      const t = q / pp;
      if (pp < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) hit = false;
    }
    if (hit) return true;
  }
  return false;
}

/** How far each side of a doorway a zombie lines up, and how near a waypoint counts as reached. */
const DOOR_OFF = 7;
const REACHED = 1.5;

/** The way round through doorway i: to it and on past, for a zombie and the player. @param {Zombie} z @param {number} i */
const doorCost = (z, i) => Math.hypot(DOORS[i].x - z.x, DOORS[i].y - z.y) + Math.hypot(game.px - DOORS[i].x, game.py - DOORS[i].y);

/**
 * Where a zombie heads: straight at the player when nothing is in the way,
 * else by a doorway. It commits to the doorway and to which side it came from
 * (`plan`) until it is through: worked out afresh each frame, the side flips
 * as it crosses the wall's line and it would turn back, over and over. It
 * changes doorway only if the player moved so another is clearly shorter.
 * @param {Zombie} z
 */
function waypoint(z) {
  // A little more room asked of the straight way while a plan is under way, so
  // it doesn't drop the plan and take it up again on a wall's corner.
  if (!walled(z.x, z.y, game.px, game.py, z.r * (z.plan ? 1.15 : 0.9))) {
    z.plan = null;
    return { x: game.px, y: game.py };
  }
  let best = 0;
  for (let i = 1; i < DOORS.length; i++) if (doorCost(z, i) < doorCost(z, best)) best = i;
  if (!z.plan || (!z.plan.through && doorCost(z, z.plan.door) > doorCost(z, best) + 12)) {
    z.plan = { door: best, side: inFort(z.x, z.y) ? -1 : 1, through: false };
  }
  const d = DOORS[z.plan.door];
  const off = DOOR_OFF * z.plan.side;
  if (!z.plan.through) {
    const a = { x: d.x + d.ox * off, y: d.y + d.oy * off };
    if (Math.hypot(a.x - z.x, a.y - z.y) > REACHED) return a;
    z.plan.through = true;
  }
  const b = { x: d.x - d.ox * off, y: d.y - d.oy * off };
  if (Math.hypot(b.x - z.x, b.y - z.y) <= REACHED) {
    // Through: from here, afresh.
    z.plan = null;
  }
  return b;
}

/** How far a point is from the wall. @param {number} x @param {number} y */
function wallGap(x, y) {
  let gap = Infinity;
  for (const w of walls()) {
    const dx = Math.max(w.x0 - x, 0, x - w.x1);
    const dy = Math.max(w.y0 - y, 0, y - w.y1);
    gap = Math.min(gap, Math.hypot(dx, dy));
  }
  return gap;
}

/** Push something round out of the wall. @param {{x: number, y: number}} o @param {number} r */
function offWall(o, r) {
  for (const w of walls()) {
    const cx = Math.max(w.x0, Math.min(o.x, w.x1));
    const cy = Math.max(w.y0, Math.min(o.y, w.y1));
    const dx = o.x - cx;
    const dy = o.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= r) continue;
    if (d > 0) {
      o.x = cx + (dx / d) * r;
      o.y = cy + (dy / d) * r;
    } else {
      // Inside it: out by the nearest face.
      const out = [o.x - w.x0, w.x1 - o.x, o.y - w.y0, w.y1 - o.y];
      const k = out.indexOf(Math.min(...out));
      if (k === 0) o.x = w.x0 - r;
      else if (k === 1) o.x = w.x1 + r;
      else if (k === 2) o.y = w.y0 - r;
      else o.y = w.y1 + r;
    }
  }
}

/** Where a game starts: in the middle of the fort. */
function home() {
  game.px = 0;
  game.py = 0;
  game.aim = -Math.PI / 2;
}

/** Before the first game, the field already has its barrels, and the player in their corner, behind the wheel. */
export function scenery() {
  if (game.state !== "idle") return;
  home();
  if (!game.barrels.length) layBarrels();
}

/** A new game, armed as the wheel left the kit. @param {Kit} kit */
export function newGame(kit) {
  Object.assign(game, {
    state: "play",
    aim: -Math.PI / 2,
    firing: false,
    px: 0,
    py: 0,
    mx: 0,
    my: 0,
    stick: null,
    aimStick: null,
    step: 0,
    hp: HP,
    hurt: 0,
    wave: 0,
    toSpawn: 0,
    spawnIn: 0,
    between: 0.9,
    crateIn: 0,
    earned: 0,
    mult: kit.mult,
    kills: 0,
    gun: kit.gun && kit.ammo > 0 ? kit.gun : "pistol",
    ammo: kit.gun && kit.ammo > 0 ? kit.ammo : Infinity,
    cool: 0,
    spool: 0,
    charge: 0,
    lase: 0,
    ray: null,
    muzzle: 0,
    shake: 0,
    zombies: [],
    bullets: [],
    crates: [],
    turrets: [],
    carry: [],
    ghost: null,
    parts: [],
    decals: [],
    booms: [],
    beams: [],
  });
  game.barrels = [];
  home();
  layBarrels();
}

/** Barrels back up to five, clear of the player and of each other, never near enough to hurt. */
function layBarrels() {
  const reach = Math.min(game.hw, game.hh) - 8;
  for (let tries = 0; game.barrels.length < BARRELS && tries < 200; tries++) {
    const a = Math.random() * Math.PI * 2;
    const d = rand(BLAST + PLAYER_R + 3, Math.max(BLAST + PLAYER_R + 4, reach));
    const x = Math.cos(a) * d * (game.hw / Math.min(game.hw, game.hh)) ** 0.5;
    const y = Math.sin(a) * d;
    if (Math.abs(x) > game.hw - 5 || Math.abs(y) > game.hh - 5) continue;
    if (Math.hypot(x - game.px, y - game.py) < BLAST + PLAYER_R + 2) continue;
    if (wallGap(x, y) < 8 || DOORS.some((d) => Math.hypot(d.x - x, d.y - y) < 14)) continue;
    if (game.barrels.some((b) => Math.hypot(b.x - x, b.y - y) < 12) || byPad(x, y, BARREL_R)) continue;
    game.barrels.push({ x, y, hp: 3, fuse: 0 });
  }
}

/** Whether something of radius r at a point would sit on or about a thumb-stick. @param {number} x @param {number} y @param {number} r */
const byPad = (x, y, r) => game.pads.some((p) => Math.hypot(p.x - x, p.y - y) < STICK + 7 + r);

/** How many zombies a wave sends. @param {number} w */
const waveSize = (w) => 5 + w * 3;

/** The share of a wave's zombies that are blue: none before the third, three in four by the seventh. @param {number} w */
export const blueShare = (w) => Math.max(0, Math.min(0.75, (w - 2) * 0.15));

function nextWave() {
  game.wave++;
  game.toSpawn = waveSize(game.wave);
  game.spawnIn = 0.4;
  layBarrels();
  // The second wave unlocks the guns: a crate to greet it, more as it goes.
  if (game.wave === 2) dropCrate();
  if (game.wave >= 2) game.crateIn = rand(9, 15);
  on("wave", game.wave);
  // A heavier gun comes in with its wave, in a crate of its own.
  const fresh = /** @type {GunId[]} */ (Object.keys(GUNS)).find((id) => GUNS[id].from === game.wave && game.wave > 2);
  if (fresh) {
    dropCrate(fresh);
    on("unlock", fresh);
  }
  const tier = /** @type {TurretKind[]} */ (Object.keys(TURRETS)).find((k) => TURRETS[k].from === game.wave && game.wave > 2);
  if (tier) dropCrate("turret", tier);
}

function spawn() {
  const w = game.wave;
  const blue = Math.random() < blueShare(w);
  const side = Math.floor(Math.random() * 4);
  const m = 6;
  const x = side === 0 ? -game.hw - m : side === 1 ? game.hw + m : rand(-game.hw, game.hw);
  const y = side === 2 ? -game.hh - m : side === 3 ? game.hh + m : rand(-game.hh, game.hh);
  const speed = Math.min(13, 6 + w * 0.5) * (blue ? 0.92 : 1) * rand(0.85, 1.15);
  // A blue one's stamina grows with the waves: five shots at the third, a dozen by the fifteenth.
  const hp = blue ? 4 + Math.ceil(w / 2) : 2;
  game.zombies.push({ x, y, r: blue ? 3.6 : 3, hp, max: hp, blue, speed, bite: 0, flash: 0, face: Math.atan2(game.py - y, game.px - x), wob: Math.random() * 6, plan: null, gnaw: 0.5, sick: 0 });
}

/**
 * @param {GunId | "turret" | "health"} [only] what it holds, else one of the wave's guns at random, or a turret
 * @param {TurretKind} [only_tier] which turret, else one of the wave's at random
 */
function dropCrate(only, only_tier) {
  for (let tries = 0; tries < 40; tries++) {
    const x = rand(-game.hw + 8, game.hw - 8);
    const y = rand(-game.hh + 8, game.hh - 8);
    const d = Math.hypot(x - game.px, y - game.py);
    if (d < 12 || wallGap(x, y) < 8 || game.barrels.some((b) => Math.hypot(b.x - x, b.y - y) < 8) || byPad(x, y, CRATE_R)) continue;
    if (game.crates.some((c) => Math.hypot(c.x - x, c.y - y) < 12)) continue;
    const list = drops();
    const gun = only ?? (Math.random() < TURRET_DROP ? "turret" : list[Math.floor(Math.random() * list.length)]);
    const tiers = turretDrops();
    const tier = gun === "turret" ? only_tier ?? tiers[Math.floor(Math.random() * tiers.length)] : undefined;
    game.crates.push({ x, y, gun, tier, life: CRATE_LIFE });
    return;
  }
}

/** Later waves' crates, several at once: a gun, a turret (a biohazard among them, once it is unlocked) and health; later a second gun. */
function dropBatch() {
  const guns = drops();
  const gun = () => guns[Math.floor(Math.random() * guns.length)];
  dropCrate(gun());
  dropCrate("turret");
  dropCrate("health");
  if (game.wave >= BATCH.extra) dropCrate(gun());
}

/* ---------- Damage ---------- */

/** @param {Zombie} z @param {number} dmg @param {number} ax @param {number} ay @param {number} [knock] */
function hurtZombie(z, dmg, ax, ay, knock = 0.8) {
  z.hp -= dmg;
  if (knock) z.flash = 0.08;
  // Knocked back a little along the shot.
  const d = Math.hypot(ax, ay) || 1;
  z.x += (ax / d) * knock;
  z.y += (ay / d) * knock;
  if (z.hp > 0) return;
  const i = game.zombies.indexOf(z);
  if (i < 0) return;
  game.zombies.splice(i, 1);
  game.kills++;
  game.earned += z.blue ? 3 : 1;
  const goo = z.blue ? "#4f7fd8" : "#6f9a38";
  game.decals.push({ x: z.x, y: z.y, r: z.r * rand(1.1, 1.6), color: goo, a: 0.55, rot: Math.random() * 6 });
  if (game.decals.length > 70) game.decals.shift();
  burst(z.x, z.y, 10, goo, 18, 2.2);
  on("kill", z);
}

/** @param {Barrel} b */
function explode(b) {
  const i = game.barrels.indexOf(b);
  if (i < 0) return;
  game.barrels.splice(i, 1);
  blast(b.x, b.y, BLAST, 50, 35);
}

/**
 * A blast, a barrel's or a rocket's: it takes `dmg` from every zombie within
 * `reach`, `hurt` from the player close in, and sets off the barrels it reaches.
 * @param {number} x @param {number} y @param {number} reach @param {number} dmg @param {number} hurt
 */
function blast(x, y, reach, dmg, hurt) {
  game.booms.push({ x, y, life: 0.5, r: reach });
  game.decals.push({ x, y, r: reach * 0.55, color: "#1d1a14", a: 0.5, rot: Math.random() * 6 });
  if (game.decals.length > 70) game.decals.shift();
  burst(x, y, 26, "#ffb02e", reach * 2.8, 3);
  burst(x, y, 14, "#5a5048", reach * 1.6, 4);
  game.shake = Math.min(1.6, game.shake + reach / 14);
  for (const z of [...game.zombies]) {
    if (Math.hypot(z.x - x, z.y - y) < reach + z.r) hurtZombie(z, dmg, z.x - x, z.y - y);
  }
  if (game.state === "play" && Math.hypot(game.px - x, game.py - y) < reach * 0.8 + PLAYER_R) {
    game.hp -= hurt;
    game.hurt = 0.4;
    on("hurt");
  }
  // The barrels it reaches go up a beat after it.
  for (const other of game.barrels) {
    if (!other.fuse && Math.hypot(other.x - x, other.y - y) < reach + BARREL_R) other.fuse = 0.14;
  }
  on("boom");
}

/** @param {number} x @param {number} y @param {number} n @param {string} color @param {number} speed @param {number} size */
function burst(x, y, n, color, speed, size) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = rand(0.3, 1) * speed;
    const life = rand(0.25, 0.6);
    game.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: rand(0.5, 1) * size });
  }
  if (game.parts.length > 400) game.parts.splice(0, game.parts.length - 400);
}

/* ---------- Shooting ---------- */

function fire() {
  if (game.ammo <= 0) {
    game.gun = "pistol";
    game.ammo = Infinity;
    on("empty");
  }
  const gun = GUNS[game.gun];
  const tip = PLAYER_R + gun.len;
  const ox = game.px + Math.cos(game.aim) * tip;
  const oy = game.py + Math.sin(game.aim) * tip;
  const kind = gun.kind === "rocket" ? gun.kind : undefined;
  game.ammo--;
  // The minigun fires slowly until it has spun up.
  game.cool = gun.kind === "spin" ? gun.every / Math.max(0.25, game.spool) : gun.every;
  game.muzzle = 0.06;
  on("shot", game.gun);
  if (gun.kind === "rail") {
    rail(ox, oy, game.aim, gun.dmg);
    return;
  }
  for (let i = 0; i < gun.pellets; i++) {
    const a = game.aim + (Math.random() - 0.5) * gun.spread;
    const v = gun.speed * (gun.pellets > 1 ? rand(0.85, 1.1) : 1);
    const life = gun.life * (gun.pellets > 1 ? rand(0.8, 1.15) : 1);
    game.bullets.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, dmg: gun.dmg, pierce: gun.pierce, hit: new Set(), kind });
  }
}

/**
 * The railgun: a beam straight across the field to the first wall or the
 * edge, through every zombie on it, setting off the barrels it crosses.
 * @param {number} ox @param {number} oy @param {number} a @param {number} dmg
 */
function rail(ox, oy, a, dmg) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const { x: ex, y: ey } = rayEnd(ox, oy, a);
  game.beams.push({ x1: ox, y1: oy, x2: ex, y2: ey, life: 0.3 });
  if (wallGap(ex, ey) === 0) burst(ex, ey, 8, "#b9f3ff", 22, 1.2);
  for (const z of [...game.zombies]) {
    if (cross(ox, oy, ex, ey, z.x, z.y, z.r + 0.6) >= 0) {
      hurtZombie(z, dmg, dx, dy, 1.6);
      burst(z.x, z.y, 4, "#b9f3ff", 16, 1);
    }
  }
  for (const b of [...game.barrels]) {
    if (cross(ox, oy, ex, ey, b.x, b.y, BARREL_R) >= 0) explode(b);
  }
  game.shake = Math.min(1.6, game.shake + 0.35);
}

/** Where a beam from a point along an angle stops: the first wall, or past the field's edge. @param {number} ox @param {number} oy @param {number} a */
function rayEnd(ox, oy, a) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const far = Math.hypot(game.hw, game.hh) * 2 + 10;
  let t = 0;
  while (t < far) {
    const x = ox + dx * t;
    const y = oy + dy * t;
    if (Math.abs(x) > game.hw + 6 || Math.abs(y) > game.hh + 6 || wallGap(x, y) === 0) break;
    t += 0.5;
  }
  return { x: ox + dx * t, y: oy + dy * t };
}

/**
 * The laser, every frame it is out: held, it charges a cell, then burns a
 * beam to the first wall for as long as it stays held, until the cell's
 * seconds run out and the next must charge. Let go, the beam stops and keeps
 * what is left of the cell; a charge half-made drains away.
 * @param {number} dt
 */
function laser(dt) {
  game.ray = null;
  if (!game.firing) {
    game.charge = Math.max(0, game.charge - dt * 0.8);
    return;
  }
  if (game.lase <= 0) {
    if (game.ammo <= 0) {
      toPistol();
      return;
    }
    game.charge += dt / LASER.charge;
    if (game.charge >= 1) {
      game.charge = 0;
      game.ammo--;
      game.lase = LASER.run;
      on("shot", "laser");
    }
    return;
  }
  game.lase = Math.max(0, game.lase - dt);
  const gun = GUNS.laser;
  const tip = PLAYER_R + gun.len;
  const ox = game.px + Math.cos(game.aim) * tip;
  const oy = game.py + Math.sin(game.aim) * tip;
  const end = rayEnd(ox, oy, game.aim);
  game.ray = { x1: ox, y1: oy, x2: end.x, y2: end.y };
  const dx = Math.cos(game.aim);
  const dy = Math.sin(game.aim);
  for (const z of [...game.zombies]) {
    if (cross(ox, oy, end.x, end.y, z.x, z.y, z.r + 1.2) < 0) continue;
    hurtZombie(z, gun.dmg * dt, dx, dy, dt * 10);
    if (Math.random() < dt * 30) burst(z.x - dx * z.r, z.y - dy * z.r, 1, "#ff5a4a", 14, 0.7);
  }
  for (const b of [...game.barrels]) {
    // As the railgun's: a barrel the beam touches goes up.
    if (cross(ox, oy, end.x, end.y, b.x, b.y, BARREL_R) >= 0) explode(b);
  }
  if (wallGap(end.x, end.y) === 0 && Math.random() < dt * 25) burst(end.x, end.y, 1, "#ffb3a8", 12, 0.6);
  on("lase");
  if (game.lase <= 0 && game.ammo <= 0) toPistol();
}

/** Out of ammo: back to the pistol. */
function toPistol() {
  game.gun = "pistol";
  game.ammo = Infinity;
  game.charge = game.lase = 0;
  game.ray = null;
  on("empty");
}

/** @param {Crate} c */
function pickUp(c) {
  game.crates.splice(game.crates.indexOf(c), 1);
  if (c.gun === "health") {
    game.hp = HP;
    burst(c.x, c.y, 14, "#ff6b6b", 20, 1.6);
    burst(game.px, game.py, 12, "#ffffff", 16, 1.2);
    on("heal");
    return;
  }
  if (c.gun === "turret") {
    // The best kept first; one too many, the weakest is left behind.
    const tier = c.tier ?? "sentry";
    game.carry.push(tier);
    game.carry.sort((a, b) => TURRETS[b].from - TURRETS[a].from);
    game.carry.length = Math.min(game.carry.length, TURRET.carry);
    burst(c.x, c.y, 12, "#c89b5a", 20, 1.6);
    on("turret", tier);
    return;
  }
  if (game.gun !== c.gun) game.charge = game.lase = 0;
  game.ammo = game.gun === c.gun ? game.ammo + GUNS[c.gun].ammo : GUNS[c.gun].ammo;
  game.gun = c.gun;
  burst(c.x, c.y, 12, "#c89b5a", 20, 1.6);
  on("pickup", c.gun);
}

/** Whether a turret can stand at a point: on the field, clear of walls, barrels, crates and other turrets. @param {number} x @param {number} y */
export function canPlace(x, y) {
  const r = TURRET.r;
  if (Math.abs(x) > game.hw - r || Math.abs(y) > game.hh - r) return false;
  if (wallGap(x, y) < r + 0.5) return false;
  if (game.barrels.some((b) => Math.hypot(b.x - x, b.y - y) < r + BARREL_R + 0.5)) return false;
  if (game.turrets.some((t) => Math.hypot(t.x - x, t.y - y) < r * 2 + 0.5)) return false;
  return !game.crates.some((c) => Math.hypot(c.x - x, c.y - y) < r + CRATE_R);
}

/** Put a carried turret down at a point; whether it went down. @param {number} x @param {number} y */
export function placeTurret(x, y) {
  if (game.state !== "play" || game.carry.length < 1 || !canPlace(x, y)) return false;
  const kind = /** @type {TurretKind} */ (game.carry.shift());
  // The oldest goes once too many stand.
  if (game.turrets.length >= TURRET.max) game.turrets.shift();
  game.turrets.push({ x, y, aim: Math.atan2(-y, -x), cool: 0.3, rounds: TURRETS[kind].rounds, muzzle: 0, kind, shield: TURRETS[kind].dome, hitFx: 0 });
  burst(x, y, 10, "#c9d1d9", 14, 1.2);
  on("placed");
  return true;
}

/**
 * The turrets: each turns on the nearest zombie in range it can see past the
 * walls, and fires once it faces it. Out of rounds, it falls apart.
 * @param {number} dt
 */
function sentries(dt) {
  for (const t of game.turrets) {
    const spec = TURRETS[t.kind];
    if (t.kind === "bio") {
      gas(t, dt);
      continue;
    }
    t.cool -= dt;
    t.muzzle = Math.max(0, t.muzzle - dt);
    t.hitFx = Math.max(0, t.hitFx - dt);
    /** @type {Zombie | null} */
    let target = null;
    let near = spec.range;
    for (const z of game.zombies) {
      const d = Math.hypot(z.x - t.x, z.y - t.y);
      if (d < near && !walled(t.x, t.y, z.x, z.y, 0.3)) {
        near = d;
        target = z;
      }
    }
    if (!target) continue;
    const want = Math.atan2(target.y - t.y, target.x - t.x);
    const off = Math.atan2(Math.sin(want - t.aim), Math.cos(want - t.aim));
    t.aim += Math.sign(off) * Math.min(Math.abs(off), dt * 7);
    if (Math.abs(off) > 0.18 || t.cool > 0) continue;
    t.cool = spec.every;
    t.rounds--;
    t.muzzle = 0.06;
    const tip = TURRET.r + 1.6;
    const a = t.aim + (Math.random() - 0.5) * spec.spread;
    game.bullets.push({ x: t.x + Math.cos(t.aim) * tip, y: t.y + Math.sin(t.aim) * tip, vx: Math.cos(a) * spec.speed, vy: Math.sin(a) * spec.speed, life: spec.range / spec.speed + 0.05, dmg: spec.dmg, pierce: 1, hit: new Set(), sentry: true });
    on("shot", t.kind === "sentry" ? "turret" : "turretMini");
  }
  for (const t of game.turrets.filter((t) => t.rounds <= 0)) {
    burst(t.x, t.y, 14, t.kind === "bio" ? "#a6e22e" : "#8b949e", 18, 1.4);
    on("spent", t.kind);
  }
  game.turrets = game.turrets.filter((t) => t.rounds > 0);
}

/**
 * A biohazard's gas: it lasts its seconds (`rounds`), and every zombie in the
 * cloud that it can reach past the walls is infected. `cool` keeps time for
 * the cloud's drift.
 * @param {Turret} t @param {number} dt
 */
function gas(t, dt) {
  t.rounds -= dt;
  t.cool += dt;
  const reach = TURRETS.bio.range;
  for (const z of game.zombies) {
    if (z.sick || Math.hypot(z.x - t.x, z.y - t.y) > reach + z.r) continue;
    if (!walled(t.x, t.y, z.x, z.y, 0.3)) z.sick = 0.001;
  }
}

/**
 * The infected: each loses health slowly until it dies (a kill like any
 * other, paying its credits), and may pass it on to a zombie it brushes past.
 * @param {number} dt
 */
function sickness(dt) {
  const sick = game.zombies.filter((z) => z.sick);
  for (const a of sick) {
    for (const b of game.zombies) {
      if (b.sick || Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r + SICK.reach) continue;
      if (Math.random() < SICK.spread * dt) b.sick = 0.001;
    }
  }
  for (const z of sick) {
    z.sick += dt;
    if (Math.random() < dt * 3) burst(z.x, z.y, 1, "#a6e22e", 4, 0.9);
    hurtZombie(z, SICK.dps * dt, 0, 0, 0);
  }
}

/** The player walks, kept on the field and out of the barrels; a crate walked over is theirs. @param {number} dt */
function walk(dt) {
  let { mx, my } = game;
  const m = Math.hypot(mx, my);
  if (m > 1) {
    mx /= m;
    my /= m;
  }
  if (!m) return;
  game.step += dt * 10 * Math.min(1, m);
  game.px = Math.max(-game.hw + PLAYER_R, Math.min(game.hw - PLAYER_R, game.px + mx * WALK * dt));
  game.py = Math.max(-game.hh + PLAYER_R, Math.min(game.hh - PLAYER_R, game.py + my * WALK * dt));
  const me = { x: game.px, y: game.py };
  offWall(me, PLAYER_R);
  game.px = me.x;
  game.py = me.y;
  for (const b of game.barrels) {
    const dx = game.px - b.x;
    const dy = game.py - b.y;
    const d = Math.hypot(dx, dy) || 1;
    const min = PLAYER_R + BARREL_R;
    if (d < min) {
      game.px = b.x + (dx / d) * min;
      game.py = b.y + (dy / d) * min;
    }
  }
  for (const c of [...game.crates]) {
    if (Math.hypot(c.x - game.px, c.y - game.py) < CRATE_R + PLAYER_R) pickUp(c);
  }
}

/** Where a segment from (x1,y1) to (x2,y2) first comes within r of (cx,cy), or -1. */
function cross(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const a = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, -(fx * dx + fy * dy) / a));
  const px = fx + dx * t;
  const py = fy + dy * t;
  return px * px + py * py <= r * r ? t : -1;
}

/** @param {Bullet} b @param {number} dt @returns {boolean} whether it flies on */
function fly(b, dt) {
  if (b.kind === "rocket") return flyRocket(b, dt);
  const x2 = b.x + b.vx * dt;
  const y2 = b.y + b.vy * dt;
  // A turret's rounds are for zombies only: never a crate, never a barrel.
  for (const c of b.sentry ? [] : game.crates) {
    if (cross(b.x, b.y, x2, y2, c.x, c.y, CRATE_R + 0.6) >= 0) {
      pickUp(c);
      return false;
    }
  }
  for (const barrel of b.sentry ? [] : game.barrels) {
    if (cross(b.x, b.y, x2, y2, barrel.x, barrel.y, BARREL_R) >= 0) {
      barrel.hp -= b.dmg;
      burst(barrel.x, barrel.y, 3, "#ffd27a", 14, 1);
      if (barrel.hp <= 0) explode(barrel);
      return false;
    }
  }
  for (const z of [...game.zombies]) {
    if (b.hit.has(z)) continue;
    if (cross(b.x, b.y, x2, y2, z.x, z.y, z.r + 0.4) < 0) continue;
    b.hit.add(z);
    hurtZombie(z, b.dmg, b.vx, b.vy);
    if (--b.pierce <= 0) return false;
  }
  if (wallGap(x2, y2) === 0) {
    burst(x2, y2, 3, "#b9b2a3", 10, 0.9);
    return false;
  }
  b.x = x2;
  b.y = y2;
  b.life -= dt;

  return b.life > 0 && Math.abs(b.x) < game.hw + 10 && Math.abs(b.y) < game.hh + 10;
}

/** A rocket flies until it meets a zombie, a barrel, a wall or the end of its fuel, and blows up there. @param {Bullet} b @param {number} dt */
function flyRocket(b, dt) {
  const x2 = b.x + b.vx * dt;
  const y2 = b.y + b.vy * dt;
  const hit =
    game.zombies.some((z) => cross(b.x, b.y, x2, y2, z.x, z.y, z.r + 0.4) >= 0) ||
    game.barrels.some((r) => cross(b.x, b.y, x2, y2, r.x, r.y, BARREL_R) >= 0) ||
    wallGap(x2, y2) === 0 ||
    (b.life -= dt) <= 0 ||
    Math.abs(x2) > game.hw + 4 ||
    Math.abs(y2) > game.hh + 4;
  if (hit) {
    blast(b.x, b.y, ROCKET_BLAST, b.dmg, ROCKET_HURT);
    return false;
  }
  b.x = x2;
  b.y = y2;
  // A trail of smoke.
  if (Math.random() < 0.7) {
    const life = rand(0.25, 0.5);
    game.parts.push({ x: b.x, y: b.y, vx: rand(-3, 3), vy: rand(-3, 3), life, max: life, color: Math.random() < 0.3 ? "#ffb347" : "#9a948c", size: rand(0.6, 1.1) });
  }
  return true;
}

/* ---------- A step of the world ---------- */

/** @param {number} dt seconds */
export function update(dt) {
  if (game.state !== "play") {
    settleEffects(dt);
    return;
  }
  game.cool -= dt;
  walk(dt);
  const spinning = game.firing && GUNS[game.gun].kind === "spin";
  game.spool = Math.max(0, Math.min(1, game.spool + (spinning ? dt * 1.6 : -dt * 2)));
  if (GUNS[game.gun].kind === "laser") laser(dt);
  else {
    game.ray = null;
    if (game.firing && game.cool <= 0) fire();
  }

  // Waves: spawning, then the pause after a cleared one.
  if (game.between > 0) {
    game.between -= dt;
    if (game.between <= 0) nextWave();
  } else if (game.toSpawn > 0) {
    game.spawnIn -= dt;
    if (game.spawnIn <= 0) {
      spawn();
      game.toSpawn--;
      game.spawnIn = Math.max(0.3, 1.5 - game.wave * 0.11) * rand(0.6, 1.3);
    }
  } else if (!game.zombies.length) {
    const bonus = game.wave;
    game.earned += bonus;
    game.between = BETWEEN;
    on("cleared", { wave: game.wave, bonus: Math.floor(bonus * game.mult) });
  }

  if (game.wave >= 2) {
    game.crateIn -= dt;
    if (game.crateIn <= 0 && game.wave >= BATCH.from) {
      // Later, several at once, once the last lot is mostly taken or gone.
      if (game.crates.length <= 1) {
        dropBatch();
        game.crateIn = rand(BATCH.every[0], BATCH.every[1]);
      }
    } else if (game.crateIn <= 0 && game.crates.length < 2) {
      dropCrate();
      game.crateIn = rand(10, 17);
    }
  }
  for (const c of game.crates) c.life -= dt;
  game.crates = game.crates.filter((c) => c.life > 0);

  sentries(dt);
  sickness(dt);
  game.bullets = game.bullets.filter((b) => fly(b, dt));

  for (const b of [...game.barrels]) {
    if (b.fuse && (b.fuse -= dt) <= 0) explode(b);
  }

  // Zombies shamble at the player, shouldering one another and the barrels aside.
  for (const z of game.zombies) {
    z.flash = Math.max(0, z.flash - dt);
    z.wob += dt * 5;
    const d = Math.hypot(game.px - z.x, game.py - z.y) || 1;
    const reach = z.r + PLAYER_R;
    // Round the walls by the doorways; straight at the player once in the open.
    const to = waypoint(z);
    const tx = to.x - z.x;
    const ty = to.y - z.y;
    const atPlayer = to.x === game.px && to.y === game.py;
    const ang = Math.atan2(ty, tx) + Math.sin(z.wob) * (atPlayer ? 0.25 : 0.06);
    // Turned towards where it walks, not snapped there.
    const turn = Math.atan2(Math.sin(Math.atan2(ty, tx) - z.face), Math.cos(Math.atan2(ty, tx) - z.face));
    z.face += turn * Math.min(1, dt * 10);
    if (d > reach) {
      // Never past a waypoint: overshooting one, it would come back, and back again.
      const step = Math.min(z.speed * dt, d - reach, atPlayer ? Infinity : Math.hypot(tx, ty));
      z.x += Math.cos(ang) * step;
      z.y += Math.sin(ang) * step;
      z.bite = Math.min(z.bite, 0.25);
    } else {
      z.bite -= dt;
      if (z.bite <= 0) {
        z.bite = 0.7;
        game.hp -= z.blue ? 12 : 8;
        game.hurt = 0.25;
        game.shake = Math.min(1.6, game.shake + 0.4);
        on("hurt");
      }
    }
  }
  for (let i = 0; i < game.zombies.length; i++) {
    const a = game.zombies[i];
    for (let j = i + 1; j < game.zombies.length; j++) {
      const b = game.zombies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      a.x -= (dx / d) * push;
      a.y -= (dy / d) * push;
      b.x += (dx / d) * push;
      b.y += (dy / d) * push;
    }
    for (const b of game.barrels) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const min = a.r + BARREL_R;
      if (d < min) {
        a.x = b.x + (dx / d) * min;
        a.y = b.y + (dy / d) * min;
      }
    }
    // A dome keeps zombies out, and those pressed against it gnaw at it.
    for (const t of game.turrets) {
      if (t.shield <= 0) continue;
      const dx = a.x - t.x;
      const dy = a.y - t.y;
      const d = Math.hypot(dx, dy) || 1;
      const min = a.r + TURRET.domeR;
      if (d >= min) continue;
      a.x = t.x + (dx / d) * min;
      a.y = t.y + (dy / d) * min;
      a.gnaw -= dt;
      if (a.gnaw > 0) continue;
      a.gnaw = 1;
      t.shield -= a.blue ? 6 : 4;
      t.hitFx = 0.2;
      if (t.shield <= 0) {
        t.shield = 0;
        burst(t.x, t.y, 30, "#8fd3ff", 30, 1.4);
        on("dome");
      }
    }
    offWall(a, a.r);
  }

  settleEffects(dt);
  on("earn");

  if (game.hp <= 0) {
    game.hp = 0;
    game.state = "over";
    game.firing = false;
    game.stick = game.aimStick = null;
    burst(game.px, game.py, 24, "#b3261e", 26, 2.4);
    on("over");
  }
}

/** @param {number} dt */
function settleEffects(dt) {
  game.hurt = Math.max(0, game.hurt - dt);
  game.muzzle = Math.max(0, game.muzzle - dt);
  game.shake = Math.max(0, game.shake - dt * 3);
  for (const p of game.parts) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - dt * 4;
    p.vy *= 1 - dt * 4;
    p.life -= dt;
  }
  game.parts = game.parts.filter((p) => p.life > 0);
  for (const b of game.booms) b.life -= dt;
  game.booms = game.booms.filter((b) => b.life > 0);
  for (const b of game.beams) b.life -= dt;
  game.beams = game.beams.filter((b) => b.life > 0);
  for (const d of game.decals) d.a = Math.max(0.12, d.a - dt * 0.01);
}

/** Whether anything is still moving once a game is over. */
export const settling = () => game.parts.length > 0 || game.booms.length > 0 || game.beams.length > 0 || game.shake > 0 || game.hurt > 0;

/* ---------- Drawing ---------- */

/** @type {CanvasPattern | null} */
let grass = null;
let grassScale = 0;

/** A patch of field, drawn once per scale and tiled. @param {CanvasRenderingContext2D} ctx @param {number} u */
function grassPattern(ctx, u) {
  if (grass && grassScale === u) return grass;
  const size = Math.round(64 * u);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  g.fillStyle = "#4f7a35";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 14; i++) {
    g.fillStyle = i % 2 ? "rgba(70, 110, 45, 0.55)" : "rgba(98, 140, 62, 0.4)";
    g.beginPath();
    g.ellipse(Math.random() * size, Math.random() * size, rand(4, 10) * u, rand(3, 7) * u, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.lineCap = "round";
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    g.strokeStyle = Math.random() < 0.5 ? "rgba(132, 176, 86, 0.7)" : "rgba(52, 86, 32, 0.7)";
    g.lineWidth = 0.35 * u;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + rand(-0.6, 0.6) * u, y - rand(0.8, 1.6) * u);
    g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    g.fillStyle = ["#f3e27a", "#ffffff", "#e9a0c8"][i % 3];
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, 0.35 * u, 0, Math.PI * 2);
    g.fill();
  }
  grass = ctx.createPattern(c, "repeat");
  grassScale = u;
  return grass;
}

/**
 * The field, in device pixels.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w @param {number} h canvas size
 * @param {number} u device pixels to a unit
 */
export function draw(ctx, w, h, u) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = grassPattern(ctx, u);
  ctx.fillRect(0, 0, w, h);
  const sx = game.shake ? (Math.random() - 0.5) * game.shake * 1.6 * u : 0;
  const sy = game.shake ? (Math.random() - 0.5) * game.shake * 1.6 * u : 0;
  ctx.setTransform(u, 0, 0, u, w / 2 + sx, h / 2 + sy);

  for (const d of game.decals) {
    ctx.globalAlpha = d.a;
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.ellipse(d.x, d.y, d.r, d.r * 0.7, d.rot, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawWall(ctx);
  for (const c of game.crates) drawCrate(ctx, c);
  for (const b of game.barrels) drawBarrel(ctx, b);
  for (const t of game.turrets) drawTurret(ctx, t);
  for (const z of game.zombies) drawZombie(ctx, z);
  if (game.state === "over") drawFallen(ctx);
  else drawPlayer(ctx);

  ctx.lineCap = "round";
  for (const b of game.bullets) {
    if (b.kind === "rocket") {
      drawRocket(ctx, b);
      continue;
    }
    ctx.strokeStyle = "#fff6c4";
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  if (game.ray) drawLaser(ctx, game.ray);
  for (const b of game.beams) {
    const k = b.life / 0.3;
    ctx.globalAlpha = k;
    ctx.strokeStyle = "#5fd8ff";
    ctx.lineWidth = 2.4 * k + 0.4;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.7 * k + 0.15;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const b of game.booms) {
    const t = 1 - b.life / 0.5;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = t < 0.3 ? "#fff1b8" : "#ff8a1f";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * (0.4 + t * 0.7), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * (0.6 + t * 0.6), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const p of game.parts) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * (p.life / p.max)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (game.stick && game.state === "play") drawStick(ctx, game.stick);
  if (game.aimStick && game.state === "play") drawStick(ctx, game.aimStick, game.firing);
  if (game.ghost && game.state === "play") drawGhost(ctx, game.ghost);
  ctx.restore();

  if (game.state === "play") drawHud(ctx, w, h, u);
  if (game.hurt > 0) {
    ctx.fillStyle = `rgba(200, 20, 20, ${game.hurt * 0.9})`;
    ctx.fillRect(0, 0, w, h);
  }
}

/** The laser's beam: a red glow round a white core, flickering. @param {CanvasRenderingContext2D} ctx @param {{x1: number, y1: number, x2: number, y2: number}} r */
function drawLaser(ctx, r) {
  const w = 1 + Math.random() * 0.25;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const [color, width] of /** @type {[string, number][]} */ ([["rgba(255, 40, 30, 0.35)", 4], ["rgba(255, 70, 50, 0.85)", 1.8], ["#fff4f0", 0.7]])) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * w;
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x2, r.y2);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255, 120, 90, 0.6)";
  ctx.beginPath();
  ctx.arc(r.x2, r.y2, 1.2 * w, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A rocket in flight: a body along its heading and a flame behind. @param {CanvasRenderingContext2D} ctx @param {Bullet} b */
function drawRocket(ctx, b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.atan2(b.vy, b.vx));
  ctx.fillStyle = "#ffb02e";
  ctx.beginPath();
  ctx.moveTo(-1.4, 0);
  ctx.lineTo(-2.6 - Math.random() * 1.2, 0);
  ctx.lineTo(-1.4, 0.45);
  ctx.closePath();
  ctx.moveTo(-1.4, -0.45);
  ctx.lineTo(-2.6 - Math.random() * 1.2, 0);
  ctx.lineTo(-1.4, 0);
  ctx.fill();
  ctx.fillStyle = "#4a5a3a";
  ctx.fillRect(-1.5, -0.5, 2.4, 1);
  ctx.fillStyle = "#d8302a";
  ctx.beginPath();
  ctx.moveTo(0.9, -0.5);
  ctx.lineTo(1.7, 0);
  ctx.lineTo(0.9, 0.5);
  ctx.fill();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} r */
function shadow(ctx, x, y, r) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.beginPath();
  ctx.ellipse(x + 0.6, y + 0.9, r, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** The fort's walls from above: runs of stone blocks, their shadow on the grass. @param {CanvasRenderingContext2D} ctx */
function drawWall(ctx) {
  const list = walls();
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  for (const w of list) ctx.fillRect(w.x0 + 0.5, w.y0 + 0.8, w.x1 - w.x0, w.y1 - w.y0);
  for (const w of list) {
    const along = w.x1 - w.x0 > w.y1 - w.y0;
    const len = along ? w.x1 - w.x0 : w.y1 - w.y0;
    const block = 5;
    for (let i = 0; i * block < len; i++) {
      const a = i * block;
      const b = Math.min(len, a + block);
      const x = along ? w.x0 + a : w.x0;
      const y = along ? w.y0 : w.y0 + a;
      const bw = along ? b - a : WALL_T;
      const bh = along ? WALL_T : b - a;
      ctx.fillStyle = i % 2 ? "#8d877b" : "#9a9487";
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = "#5f5a51";
      ctx.lineWidth = 0.3;
      ctx.strokeRect(x + 0.15, y + 0.15, bw - 0.3, bh - 0.3);
      ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
      if (along) ctx.fillRect(x + 0.3, y + 0.3, bw - 0.6, 0.5);
      else ctx.fillRect(x + 0.3, y + 0.3, 0.5, bh - 0.6);
    }
  }
}

/** A barrel seen from above: a red drum, its rim and lid rings, a hazard mark. @param {CanvasRenderingContext2D} ctx @param {Barrel} b */
function drawBarrel(ctx, b) {
  shadow(ctx, b.x, b.y, BARREL_R);
  const g = ctx.createRadialGradient(b.x - 1, b.y - 1, 0.3, b.x, b.y, BARREL_R);
  g.addColorStop(0, b.fuse ? "#fff0a0" : "#ff6b4f");
  g.addColorStop(1, "#9d1c12");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.x, b.y, BARREL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5e0f0a";
  ctx.lineWidth = 0.45;
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  ctx.arc(b.x, b.y, BARREL_R * 0.68, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#ffcf33";
  ctx.beginPath();
  ctx.moveTo(b.x, b.y - 1.25);
  ctx.lineTo(b.x + 1.15, b.y + 0.8);
  ctx.lineTo(b.x - 1.15, b.y + 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#2a1a10";
  ctx.fillRect(b.x - 0.12, b.y - 0.5, 0.24, 0.75);
  if (b.hp < 3) {
    ctx.fillStyle = "rgba(40, 30, 20, 0.6)";
    ctx.beginPath();
    ctx.arc(b.x + 1.3, b.y - 0.6, 0.35, 0, Math.PI * 2);
    if (b.hp < 2) ctx.arc(b.x - 1.4, b.y + 1.2, 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A sentry turret from above: three legs, a round housing, the barrel along its aim, its rounds left as a ring. @param {CanvasRenderingContext2D} ctx @param {Turret} t */
function drawTurret(ctx, t) {
  if (t.kind === "bio") return drawBio(ctx, t);
  const r = TURRET.r;
  const spec = TURRETS[t.kind];
  shadow(ctx, t.x, t.y, r * 1.2);
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.strokeStyle = "#3b4048";
  ctx.lineWidth = 0.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r * 1.35, Math.sin(a) * r * 1.35);
  }
  ctx.stroke();
  // Rounds left, round the base.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 0.45;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = t.rounds > spec.rounds * 0.25 ? "#7ee2a0" : "#ffb347";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * t.rounds) / spec.rounds);
  ctx.stroke();
  ctx.rotate(t.aim);
  if (t.muzzle > 0) {
    ctx.fillStyle = "#ffe066";
    ctx.beginPath();
    ctx.arc(r + 2, 0, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#23272e";
  if (t.kind === "sentry") ctx.fillRect(0, -0.4, r + 1.6, 0.8);
  else {
    // Three barrels side by side, shaking as they fire.
    const j = t.muzzle > 0 ? (Math.random() - 0.5) * 0.25 : 0;
    for (const off of [-0.55, 0, 0.55]) ctx.fillRect(0, off - 0.2 + j, r + 2, 0.4);
  }
  const g = ctx.createRadialGradient(-0.5, -0.5, 0.2, 0, 0, r * 0.8);
  g.addColorStop(0, t.kind === "sentry" ? "#c3ccd6" : "#e1b96a");
  g.addColorStop(1, t.kind === "sentry" ? "#5c6670" : "#7a5a22");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2b3038";
  ctx.lineWidth = 0.3;
  ctx.stroke();
  ctx.fillStyle = "#e5484d";
  ctx.beginPath();
  ctx.arc(r * 0.3, 0, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (t.shield > 0) drawDome(ctx, t.x, t.y, t.shield / spec.dome, t.hitFx);
}

/**
 * A biohazard from above: its cloud first, a green haze over the ground with
 * puffs drifting round in it, thinning as the gas runs out; then the canister,
 * yellow with the biohazard mark, and the seconds left as a ring round it.
 * @param {CanvasRenderingContext2D} ctx @param {Turret} t
 */
function drawBio(ctx, t) {
  const spec = TURRETS.bio;
  const R = spec.range;
  const left = Math.max(0, Math.min(1, t.rounds / spec.rounds));
  const fade = Math.min(1, left * 4);
  const haze = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, R);
  haze.addColorStop(0, `rgba(166, 226, 46, ${0.34 * fade})`);
  haze.addColorStop(0.7, `rgba(140, 200, 40, ${0.2 * fade})`);
  haze.addColorStop(1, "rgba(140, 200, 40, 0)");
  ctx.fillStyle = haze;
  ctx.beginPath();
  ctx.arc(t.x, t.y, R, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + t.cool * (0.25 + (i % 3) * 0.08) * (i % 2 ? 1 : -1);
    const d = R * (0.3 + 0.45 * ((i * 0.37) % 1)) + Math.sin(t.cool * 1.3 + i) * 1.2;
    ctx.fillStyle = `rgba(190, 240, 90, ${0.16 * fade})`;
    ctx.beginPath();
    ctx.arc(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, 2.6 + (i % 3) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  const r = TURRET.r;
  shadow(ctx, t.x, t.y, r * 1.1);
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 0.45;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = left > 0.25 ? "#a6e22e" : "#ffb347";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
  ctx.stroke();
  const g = ctx.createRadialGradient(-0.6, -0.6, 0.2, 0, 0, r * 0.9);
  g.addColorStop(0, "#fff27a");
  g.addColorStop(1, "#c99400");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5a4300";
  ctx.lineWidth = 0.3;
  ctx.stroke();
  // The mark: three lobes round a ring.
  ctx.fillStyle = "#1c2400";
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0.62, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#e9c21a";
  ctx.beginPath();
  ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A dome from above: a pale blue bubble, fainter as it weakens, a bright
 * rim with its strength left drawn round it, flaring when bitten.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} left 0…1 @param {number} hit
 */
function drawDome(ctx, x, y, left, hit) {
  const R = TURRET.domeR;
  const g = ctx.createRadialGradient(x - R * 0.35, y - R * 0.4, R * 0.1, x, y, R);
  g.addColorStop(0, `rgba(220, 244, 255, ${0.08 + 0.12 * left})`);
  g.addColorStop(0.85, `rgba(120, 200, 255, ${0.08 + 0.14 * left})`);
  g.addColorStop(1, `rgba(150, 215, 255, ${0.25 + 0.3 * left + hit * 2})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 0.35;
  ctx.strokeStyle = `rgba(190, 232, 255, ${0.5 + hit * 2})`;
  ctx.stroke();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = left > 0.3 ? "rgba(140, 215, 255, 0.95)" : "rgba(255, 179, 71, 0.95)";
  ctx.beginPath();
  ctx.arc(x, y, R + 0.6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
  ctx.stroke();
  // A highlight, as on glass.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.arc(x, y, R * 0.78, Math.PI * 1.1, Math.PI * 1.45);
  ctx.stroke();
}

/** Where a turret would go: its reach, and the turret see-through, red where it cannot stand. @param {CanvasRenderingContext2D} ctx @param {{x: number, y: number}} p */
function drawGhost(ctx, p) {
  const ok = canPlace(p.x, p.y);
  const kind = game.carry[0] ?? "sentry";
  const spec = TURRETS[kind];
  ctx.fillStyle = ok ? "rgba(126, 226, 160, 0.1)" : "rgba(229, 72, 77, 0.1)";
  ctx.strokeStyle = ok ? "rgba(126, 226, 160, 0.6)" : "rgba(229, 72, 77, 0.7)";
  ctx.lineWidth = 0.3;
  ctx.setLineDash([1.2, 1]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, spec.range, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.6;
  drawTurret(ctx, { x: p.x, y: p.y, aim: -Math.PI / 2, cool: 0, rounds: spec.rounds, muzzle: 0, kind, shield: spec.dome, hitFx: 0 });
  if (!ok) {
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(p.x - 2, p.y - 2);
    ctx.lineTo(p.x + 2, p.y + 2);
    ctx.moveTo(p.x + 2, p.y - 2);
    ctx.lineTo(p.x - 2, p.y + 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A wooden crate with the gun's name stencilled on, blinking as it goes. @param {CanvasRenderingContext2D} ctx @param {Crate} c */
function drawCrate(ctx, c) {
  if (c.life < 3 && Math.floor(c.life * 6) % 2) return;
  const r = CRATE_R;
  const bob = Math.sin(c.life * 4) * 0.3;
  shadow(ctx, c.x, c.y + 0.4, r);
  ctx.save();
  ctx.translate(c.x, c.y + bob);
  ctx.fillStyle = "#b07a3c";
  ctx.strokeStyle = "#5a3a17";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.roundRect(-r, -r, r * 2, r * 2, 0.5);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r, -r);
  ctx.lineTo(r, r);
  ctx.moveTo(r, -r);
  ctx.lineTo(-r, r);
  ctx.strokeStyle = "rgba(90, 58, 23, 0.6)";
  ctx.stroke();
  if (c.gun === "health") {
    // A first-aid crate: white, a red cross on it.
    ctx.fillStyle = "#f4f1ea";
    ctx.strokeStyle = "#8a8378";
    ctx.beginPath();
    ctx.roundRect(-r, -r, r * 2, r * 2, 0.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e0281e";
    ctx.fillRect(-0.55, -1.9, 1.1, 3.8);
    ctx.fillRect(-1.9, -0.55, 3.8, 1.1);
    ctx.restore();
    ctx.strokeStyle = `rgba(126, 226, 160, ${0.55 + 0.3 * Math.sin(c.life * 8)})`;
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.arc(c.x, c.y + bob, r * 1.75, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = "#fff8e6";
  const tag = c.gun === "turret" ? "TURRET" : GUNS[c.gun].tag;
  const sub = c.gun === "turret" && c.tier ? TURRETS[c.tier].tag : "";
  ctx.font = `700 ${tag.length <= 3 ? 1.5 : tag.length >= 6 ? 1.05 : 1.15}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tag, 0, sub ? -0.6 : 0.1, r * 1.9);
  if (sub) {
    ctx.fillStyle = "#ffe08a";
    ctx.font = "800 0.95px system-ui, sans-serif";
    ctx.fillText(sub, 0, 0.75, r * 1.9);
  }
  ctx.restore();
  // A ring calls it out.
  const heavy = c.gun === "turret" ? !!c.tier && TURRETS[c.tier].from > 2 : GUNS[c.gun].from > 2;
  ctx.strokeStyle = `rgba(${heavy ? "255, 120, 70" : "255, 236, 140"}, ${0.5 + 0.3 * Math.sin(c.life * 8)})`;
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.arc(c.x, c.y + bob, r * 1.75, 0, Math.PI * 2);
  ctx.stroke();
}

/** A zombie from above: arms reaching for the player, shoulders, a head with red eyes. @param {CanvasRenderingContext2D} ctx @param {Zombie} z */
function drawZombie(ctx, z) {
  shadow(ctx, z.x, z.y, z.r);
  if (z.sick) {
    // Infected: a sickly haze about it, pulsing.
    ctx.fillStyle = `rgba(166, 226, 46, ${0.22 + 0.12 * Math.sin(z.wob * 1.7)})`;
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.r * 1.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.rotate(z.face);
  const skin = z.flash ? "#ffffff" : z.sick ? (z.blue ? "#6fc7a6" : "#b9d930") : z.blue ? "#5d8ff0" : "#86b04a";
  const dark = z.blue ? "#2b4f9e" : "#4d6b25";
  const cloth = z.blue ? "#27345c" : "#5b4a3a";
  const sway = Math.sin(z.wob) * 0.35;
  ctx.lineCap = "round";
  ctx.strokeStyle = skin;
  ctx.lineWidth = z.r * 0.38;
  ctx.beginPath();
  ctx.moveTo(0, -z.r * 0.62);
  ctx.lineTo(z.r * 1.25, -z.r * 0.5 + sway);
  ctx.moveTo(0, z.r * 0.62);
  ctx.lineTo(z.r * 1.25, z.r * 0.5 - sway);
  ctx.stroke();
  ctx.fillStyle = z.flash ? "#ffffff" : cloth;
  ctx.beginPath();
  ctx.ellipse(0, 0, z.r * 0.62, z.r * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = skin;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  ctx.arc(z.r * 0.12, 0, z.r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = z.blue ? "#e8f3ff" : "#e0281e";
  ctx.beginPath();
  ctx.arc(z.r * 0.5, -z.r * 0.2, z.r * 0.11, 0, Math.PI * 2);
  ctx.arc(z.r * 0.5, z.r * 0.2, z.r * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (z.blue && z.hp < z.max) {
    const w = z.r * 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(z.x - w / 2, z.y - z.r - 1.6, w, 0.6);
    ctx.fillStyle = "#9cc4ff";
    ctx.fillRect(z.x - w / 2, z.y - z.r - 1.6, (w * z.hp) / z.max, 0.6);
  }
}

/** The player from above, the gun out along the aim. @param {CanvasRenderingContext2D} ctx */
function drawPlayer(ctx) {
  const r = PLAYER_R;
  const gun = GUNS[game.gun];
  shadow(ctx, game.px, game.py, r);
  ctx.save();
  ctx.translate(game.px, game.py);
  // Feet, stepping while they walk.
  if (game.mx || game.my) {
    const walkDir = Math.atan2(game.my, game.mx);
    const swing = Math.sin(game.step) * 1.1;
    ctx.save();
    ctx.rotate(walkDir);
    ctx.fillStyle = "#2a2a2e";
    ctx.beginPath();
    ctx.ellipse(swing, -1.1, 0.9, 0.55, 0, 0, Math.PI * 2);
    ctx.ellipse(-swing, 1.1, 0.9, 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.rotate(game.aim);
  if (game.muzzle > 0) {
    ctx.fillStyle = game.gun === "railgun" ? "#9be9ff" : "#ffe066";
    ctx.beginPath();
    ctx.arc(r + gun.len + 0.6, 0, game.gun === "shotgun" || game.gun === "rocket" ? 1.6 : 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  drawGun(ctx, r, gun);
  ctx.lineCap = "round";
  ctx.strokeStyle = "#e9b98d";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.7);
  ctx.lineTo(r * 1.2, -0.3);
  ctx.moveTo(0, r * 0.7);
  ctx.lineTo(r * 0.9, 0.3);
  ctx.stroke();
  ctx.fillStyle = game.hurt > 0 ? "#ff6b6b" : "#3f6fb0";
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.62, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e9b98d";
  ctx.beginPath();
  ctx.arc(r * 0.08, 0, r * 0.52, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#5a3a1e";
  ctx.beginPath();
  ctx.arc(-r * 0.05, 0, r * 0.5, Math.PI * 0.55, Math.PI * 1.45);
  ctx.fill();
  ctx.restore();
}

/**
 * The gun in the player's hands, pointing along +x, each tier its own shape.
 * @param {CanvasRenderingContext2D} ctx @param {number} r @param {Gun} gun
 */
function drawGun(ctx, r, gun) {
  const x0 = r * 0.4;
  const len = gun.len + r * 0.6;
  if (game.gun === "minigun") {
    // A drum of barrels that turn as it spins up.
    ctx.fillStyle = "#3a3d44";
    ctx.fillRect(x0, -1.1, 2.6, 2.2);
    const turn = Math.sin(performance.now() / (40 + 200 * (1 - game.spool))) * 0.35;
    ctx.fillStyle = "#1e1e22";
    for (const off of [-0.6, 0, 0.6]) ctx.fillRect(x0 + 2.4, off + turn * 0.3 - 0.22, len - 2.4, 0.44);
    ctx.fillStyle = "#5b616b";
    ctx.fillRect(x0 + len - 0.8, -0.95, 0.5, 1.9);
  } else if (game.gun === "railgun") {
    // Two rails with a glow between them.
    ctx.fillStyle = "#2b3440";
    ctx.fillRect(x0, -0.9, 2.4, 1.8);
    ctx.fillStyle = `rgba(95, 216, 255, ${0.35 + 0.5 * Math.max(0, 1 - game.cool / gun.every)})`;
    ctx.fillRect(x0 + 2.4, -0.3, len - 2.4, 0.6);
    ctx.fillStyle = "#c9d1d9";
    ctx.fillRect(x0 + 1.6, -0.85, len - 1.6, 0.4);
    ctx.fillRect(x0 + 1.6, 0.45, len - 1.6, 0.4);
  } else if (game.gun === "rocket") {
    // A wide olive tube on the shoulder, its mouth dark.
    ctx.fillStyle = "#56663f";
    ctx.fillRect(x0 - 1.4, -0.85, len + 1.4, 1.7);
    ctx.fillStyle = "#2c3322";
    ctx.fillRect(x0 + len - 0.6, -0.85, 0.6, 1.7);
    ctx.fillStyle = "#c8a24a";
    ctx.fillRect(x0 + 1.4, -0.85, 0.5, 1.7);
  } else if (game.gun === "laser") {
    // A white body, a red lens, and the charge glowing at its tip.
    ctx.fillStyle = "#d9dee5";
    ctx.fillRect(x0, -0.7, len - 0.6, 1.4);
    ctx.fillStyle = "#8a929c";
    ctx.fillRect(x0 + 1, -0.7, 0.5, 1.4);
    ctx.fillRect(x0 + 2.2, -0.7, 0.5, 1.4);
    ctx.fillStyle = "#e0281e";
    ctx.fillRect(x0 + len - 0.8, -0.5, 0.8, 1);
    const glow = game.lase > 0 ? 1 : game.charge;
    if (glow > 0) {
      ctx.fillStyle = `rgba(255, 70, 50, ${0.3 + 0.5 * glow})`;
      ctx.beginPath();
      ctx.arc(x0 + len + 0.2, 0, 0.3 + glow * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = "#1e1e22";
    ctx.fillRect(x0, -0.45, len, 0.9);
    if (game.gun === "shotgun") {
      ctx.fillStyle = "#7a4a22";
      ctx.fillRect(x0, -0.55, 2.2, 1.1);
    }
  }
}

/** @param {CanvasRenderingContext2D} ctx */
function drawFallen(ctx) {
  ctx.fillStyle = "rgba(120, 12, 12, 0.6)";
  ctx.beginPath();
  ctx.ellipse(game.px, game.py, PLAYER_R * 1.6, PLAYER_R * 1.1, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(game.px, game.py);
  ctx.rotate(game.aim + Math.PI / 2);
  ctx.fillStyle = "#3f6fb0";
  ctx.beginPath();
  ctx.ellipse(0, 0, PLAYER_R * 0.62, PLAYER_R, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A thumb-stick: a ring where it stands, the knob where the thumb has
 * pushed it (in the middle when let go), red while the aiming stick fires.
 * @param {CanvasRenderingContext2D} ctx @param {{x: number, y: number, dx: number, dy: number}} s @param {boolean} [hot]
 */
function drawStick(ctx, s, hot = false) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STICK, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = hot ? "rgba(255, 110, 90, 0.7)" : "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.arc(s.x + s.dx * STICK, s.y + s.dy * STICK, STICK * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

/** A thumb-stick's reach, in units. */
export const STICK = 9;

/** Wave and what is left of it top left; health and the gun at the bottom. In device pixels. */
function drawHud(ctx, w, h, u) {
  // Drawn at the page's text size, whatever the field's.
  const s = Math.min(3, window.devicePixelRatio || 1);
  const pad = 12 * s;
  // Clear of a phone's home indicator, the field running under it.
  const foot = pad + game.inset;
  ctx.save();
  ctx.font = `700 ${14 * s}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  const left = game.zombies.length + game.toSpawn;
  const label = game.wave ? `Wave ${game.wave} · ${left} left` : "Get ready";
  const lw = ctx.measureText(label).width;
  ctx.beginPath();
  ctx.roundRect(pad, pad, lw + 20 * s, 26 * s, 13 * s);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(label, pad + 10 * s, pad + 6 * s);

  const bw = Math.min(w * 0.6, 260 * s);
  const bx = (w - bw) / 2;
  const by = h - foot - 10 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, 10 * s, 5 * s);
  ctx.fill();
  const frac = Math.max(0, game.hp / HP);
  ctx.fillStyle = frac > 0.5 ? "#5ad46a" : frac > 0.25 ? "#ffc83d" : "#ff4b3e";
  if (frac > 0) {
    ctx.beginPath();
    ctx.roundRect(bx, by, Math.max(10 * s, bw * frac), 10 * s, 5 * s);
    ctx.fill();
  }
  const gun = GUNS[game.gun];
  const ammo =
    gun.kind === "laser"
      ? `Laser · ${game.ammo} ${game.ammo === 1 ? "cell" : "cells"}${game.lase > 0 ? ` · ${game.lase.toFixed(1)}s` : game.charge > 0 ? " · charging" : ""}`
      : Number.isFinite(game.ammo)
        ? `${gun.name} · ${game.ammo}`
        : gun.name;
  ctx.font = `700 ${13 * s}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillText(ammo, w / 2 + s, by - 5 * s + s);
  ctx.fillStyle = "#fff";
  ctx.fillText(ammo, w / 2, by - 5 * s);
  ctx.restore();
}
