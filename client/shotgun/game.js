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
 * the nearest zombie it can see and shoots until its rounds run out.
 */

/** @typedef {"pistol" | "shotgun" | "smg" | "rifle"} GunId */

/**
 * The guns. `every` is seconds between shots, `speed` units a second, `life`
 * how long a pellet flies; `pierce` how many zombies one passes through.
 */
export const GUNS = {
  pistol: { name: "Pistol", every: 0.3, pellets: 1, spread: 0.04, dmg: 1, speed: 120, life: 1.3, pierce: 1, ammo: Infinity, len: 3.2 },
  shotgun: { name: "Shotgun", every: 0.68, pellets: 7, spread: 0.5, dmg: 1, speed: 105, life: 0.42, pierce: 1, ammo: 24, len: 5.2 },
  smg: { name: "SMG", every: 0.085, pellets: 1, spread: 0.15, dmg: 1, speed: 130, life: 1, pierce: 1, ammo: 160, len: 4.2 },
  rifle: { name: "Rifle", every: 0.45, pellets: 1, spread: 0, dmg: 5, speed: 190, life: 1, pierce: 4, ammo: 30, len: 6.4 },
};

/** The guns a crate can hold. */
const DROPS = /** @type {GunId[]} */ (["shotgun", "smg", "rifle"]);
/** The share of crates that hold a turret rather than a gun. */
const TURRET_DROP = 0.25;

/** A sentry turret: how far it sees, how often it fires, its rounds, how many stand at once, how many the player can carry. */
const TURRET = { range: 34, every: 0.32, dmg: 1, speed: 130, rounds: 60, r: 2.6, max: 3, carry: 2 };

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
 *   plan: {door: number, side: number, through: boolean} | null}} Zombie
 * @typedef {{x: number, y: number, vx: number, vy: number, life: number, dmg: number, pierce: number, hit: Set<object>, sentry?: boolean}} Bullet
 * @typedef {{x: number, y: number, hp: number, fuse: number}} Barrel
 * @typedef {{x: number, y: number, gun: GunId | "turret", life: number}} Crate
 * @typedef {{x: number, y: number, aim: number, cool: number, rounds: number, muzzle: number}} Turret
 * @typedef {{x: number, y: number, vx: number, vy: number, life: number, max: number, color: string, size: number}} Part
 * @typedef {{x: number, y: number, r: number, color: string, a: number, rot: number}} Decal
 * @typedef {{x: number, y: number, life: number}} Boom
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
  muzzle: 0,
  shake: 0,
  /** @type {Zombie[]} */ zombies: [],
  /** @type {Bullet[]} */ bullets: [],
  /** @type {Barrel[]} */ barrels: [],
  /** @type {Crate[]} */ crates: [],
  /** @type {Turret[]} */ turrets: [],
  /** Turrets taken and not yet placed. */
  carry: 0,
  /** @type {{x: number, y: number} | null} where a turret would go, while the player is placing one */
  ghost: null,
  /** @type {Part[]} */ parts: [],
  /** @type {Decal[]} */ decals: [],
  /** @type {Boom[]} */ booms: [],
};

/** @typedef {"shot" | "empty" | "kill" | "boom" | "hurt" | "pickup" | "cleared" | "wave" | "over" | "earn" | "turret" | "placed" | "spent"} Event */
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
    muzzle: 0,
    shake: 0,
    zombies: [],
    bullets: [],
    crates: [],
    turrets: [],
    carry: 0,
    ghost: null,
    parts: [],
    decals: [],
    booms: [],
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
    if (game.barrels.some((b) => Math.hypot(b.x - x, b.y - y) < 12)) continue;
    game.barrels.push({ x, y, hp: 3, fuse: 0 });
  }
}

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
  game.zombies.push({ x, y, r: blue ? 3.6 : 3, hp, max: hp, blue, speed, bite: 0, flash: 0, face: Math.atan2(game.py - y, game.px - x), wob: Math.random() * 6, plan: null });
}

function dropCrate() {
  for (let tries = 0; tries < 40; tries++) {
    const x = rand(-game.hw + 8, game.hw - 8);
    const y = rand(-game.hh + 8, game.hh - 8);
    const d = Math.hypot(x - game.px, y - game.py);
    if (d < 12 || wallGap(x, y) < 8 || game.barrels.some((b) => Math.hypot(b.x - x, b.y - y) < 8)) continue;
    const gun = Math.random() < TURRET_DROP ? "turret" : DROPS[Math.floor(Math.random() * DROPS.length)];
    game.crates.push({ x, y, gun, life: CRATE_LIFE });
    return;
  }
}

/* ---------- Damage ---------- */

/** @param {Zombie} z @param {number} dmg @param {number} ax @param {number} ay */
function hurtZombie(z, dmg, ax, ay) {
  z.hp -= dmg;
  z.flash = 0.08;
  // Knocked back a little along the shot.
  const d = Math.hypot(ax, ay) || 1;
  z.x += (ax / d) * 0.8;
  z.y += (ay / d) * 0.8;
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
  game.booms.push({ x: b.x, y: b.y, life: 0.5 });
  game.decals.push({ x: b.x, y: b.y, r: BLAST * 0.55, color: "#1d1a14", a: 0.5, rot: Math.random() * 6 });
  burst(b.x, b.y, 26, "#ffb02e", 40, 3);
  burst(b.x, b.y, 14, "#5a5048", 22, 4);
  game.shake = Math.min(1.6, game.shake + 1);
  for (const z of [...game.zombies]) {
    if (Math.hypot(z.x - b.x, z.y - b.y) < BLAST + z.r) hurtZombie(z, 50, z.x - b.x, z.y - b.y);
  }
  if (game.state === "play" && Math.hypot(game.px - b.x, game.py - b.y) < BLAST * 0.8 + PLAYER_R) {
    game.hp -= 35;
    game.hurt = 0.4;
    on("hurt");
  }
  // The barrels it reaches go up a beat after it.
  for (const other of game.barrels) {
    if (!other.fuse && Math.hypot(other.x - b.x, other.y - b.y) < BLAST + BARREL_R) other.fuse = 0.14;
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
  for (let i = 0; i < gun.pellets; i++) {
    const a = game.aim + (Math.random() - 0.5) * gun.spread;
    const v = gun.speed * (gun.pellets > 1 ? rand(0.85, 1.1) : 1);
    game.bullets.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: gun.life * (gun.pellets > 1 ? rand(0.8, 1.15) : 1), dmg: gun.dmg, pierce: gun.pierce, hit: new Set() });
  }
  game.ammo--;
  game.cool = gun.every;
  game.muzzle = 0.06;
  on("shot", game.gun);
}

/** @param {Crate} c */
function pickUp(c) {
  game.crates.splice(game.crates.indexOf(c), 1);
  if (c.gun === "turret") {
    game.carry = Math.min(TURRET.carry, game.carry + 1);
    burst(c.x, c.y, 12, "#c89b5a", 20, 1.6);
    on("turret");
    return;
  }
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
  if (game.state !== "play" || game.carry < 1 || !canPlace(x, y)) return false;
  game.carry--;
  // The oldest goes once too many stand.
  if (game.turrets.length >= TURRET.max) game.turrets.shift();
  game.turrets.push({ x, y, aim: Math.atan2(-y, -x), cool: 0.3, rounds: TURRET.rounds, muzzle: 0 });
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
    t.cool -= dt;
    t.muzzle = Math.max(0, t.muzzle - dt);
    /** @type {Zombie | null} */
    let target = null;
    let near = TURRET.range;
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
    t.cool = TURRET.every;
    t.rounds--;
    t.muzzle = 0.06;
    const tip = TURRET.r + 1.6;
    const a = t.aim + (Math.random() - 0.5) * 0.05;
    game.bullets.push({ x: t.x + Math.cos(t.aim) * tip, y: t.y + Math.sin(t.aim) * tip, vx: Math.cos(a) * TURRET.speed, vy: Math.sin(a) * TURRET.speed, life: TURRET.range / TURRET.speed + 0.05, dmg: TURRET.dmg, pierce: 1, hit: new Set(), sentry: true });
    on("shot", "turret");
  }
  for (const t of game.turrets.filter((t) => t.rounds <= 0)) {
    burst(t.x, t.y, 14, "#8b949e", 18, 1.4);
    on("spent");
  }
  game.turrets = game.turrets.filter((t) => t.rounds > 0);
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

/* ---------- A step of the world ---------- */

/** @param {number} dt seconds */
export function update(dt) {
  if (game.state !== "play") {
    settleEffects(dt);
    return;
  }
  game.cool -= dt;
  walk(dt);
  if (game.firing && game.cool <= 0) fire();

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
    if (game.crateIn <= 0 && game.crates.length < 2) {
      dropCrate();
      game.crateIn = rand(10, 17);
    }
  }
  for (const c of game.crates) c.life -= dt;
  game.crates = game.crates.filter((c) => c.life > 0);

  sentries(dt);
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
  for (const d of game.decals) d.a = Math.max(0.12, d.a - dt * 0.01);
}

/** Whether anything is still moving once a game is over. */
export const settling = () => game.parts.length > 0 || game.booms.length > 0 || game.shake > 0 || game.hurt > 0;

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
    ctx.strokeStyle = "#fff6c4";
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const b of game.booms) {
    const t = 1 - b.life / 0.5;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = t < 0.3 ? "#fff1b8" : "#ff8a1f";
    ctx.beginPath();
    ctx.arc(b.x, b.y, BLAST * (0.4 + t * 0.7), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BLAST * (0.6 + t * 0.6), 0, Math.PI * 2);
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
  const r = TURRET.r;
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
  ctx.strokeStyle = t.rounds > TURRET.rounds * 0.25 ? "#7ee2a0" : "#ffb347";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.15, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * t.rounds) / TURRET.rounds);
  ctx.stroke();
  ctx.rotate(t.aim);
  if (t.muzzle > 0) {
    ctx.fillStyle = "#ffe066";
    ctx.beginPath();
    ctx.arc(r + 2, 0, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#23272e";
  ctx.fillRect(0, -0.4, r + 1.6, 0.8);
  const g = ctx.createRadialGradient(-0.5, -0.5, 0.2, 0, 0, r * 0.8);
  g.addColorStop(0, "#c3ccd6");
  g.addColorStop(1, "#5c6670");
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
}

/** Where a turret would go: its reach, and the turret see-through, red where it cannot stand. @param {CanvasRenderingContext2D} ctx @param {{x: number, y: number}} p */
function drawGhost(ctx, p) {
  const ok = canPlace(p.x, p.y);
  ctx.fillStyle = ok ? "rgba(126, 226, 160, 0.1)" : "rgba(229, 72, 77, 0.1)";
  ctx.strokeStyle = ok ? "rgba(126, 226, 160, 0.6)" : "rgba(229, 72, 77, 0.7)";
  ctx.lineWidth = 0.3;
  ctx.setLineDash([1.2, 1]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, TURRET.range, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.6;
  drawTurret(ctx, { x: p.x, y: p.y, aim: -Math.PI / 2, cool: 0, rounds: TURRET.rounds, muzzle: 0 });
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
  ctx.fillStyle = "#fff8e6";
  ctx.font = `700 ${c.gun === "smg" ? 1.5 : c.gun === "turret" ? 1.05 : 1.15}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(c.gun === "turret" ? "TURRET" : GUNS[c.gun].name.toUpperCase(), 0, 0.1, r * 1.9);
  ctx.restore();
  // A ring calls it out.
  ctx.strokeStyle = `rgba(255, 236, 140, ${0.5 + 0.3 * Math.sin(c.life * 8)})`;
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.arc(c.x, c.y + bob, r * 1.75, 0, Math.PI * 2);
  ctx.stroke();
}

/** A zombie from above: arms reaching for the player, shoulders, a head with red eyes. @param {CanvasRenderingContext2D} ctx @param {Zombie} z */
function drawZombie(ctx, z) {
  shadow(ctx, z.x, z.y, z.r);
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.rotate(z.face);
  const skin = z.flash ? "#ffffff" : z.blue ? "#5d8ff0" : "#86b04a";
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
    ctx.fillStyle = "#ffe066";
    ctx.beginPath();
    ctx.arc(r + gun.len + 0.6, 0, game.gun === "shotgun" ? 1.6 : 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#1e1e22";
  ctx.fillRect(r * 0.4, -0.45, gun.len + r * 0.6, 0.9);
  if (game.gun === "shotgun") {
    ctx.fillStyle = "#7a4a22";
    ctx.fillRect(r * 0.4, -0.55, 2.2, 1.1);
  }
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
 * A thumb-stick: a ring where the thumb went down, a knob where it is, red
 * while the aiming stick is firing.
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
  const by = h - pad - 10 * s;
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
  const ammo = Number.isFinite(game.ammo) ? `${gun.name} · ${game.ammo}` : gun.name;
  ctx.font = `700 ${13 * s}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillText(ammo, w / 2 + s, by - 5 * s + s);
  ctx.fillStyle = "#fff";
  ctx.fillText(ammo, w / 2, by - 5 * s);
  ctx.restore();
}
