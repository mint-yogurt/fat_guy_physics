import type { Inventory } from "./inventory.ts";
import type { GroundSampler, Pickup, PickupField } from "./pickupField.ts";
import { ropeMaxReach, ropeSpecFor, XMAS_LIGHTS } from "./rope.ts";

/**
 * The fishing rod: left mouse casts (hold to throw farther, with a higher arc),
 * right mouse reels in. The line is a slightly thinner string of xmas lights.
 *
 * For now the hook only snags *pickups* (dropped items), and reeling one all the
 * way in puts it in the inventory, exactly as E would. It flies and slides over the
 * terrain heightfield only: trees, props and felled logs do not stop it yet, and the
 * line is a drawn curve, not a simulated rope. Both wait on the physics engine.
 *
 * Everything the player can tune about the rod is in {@link FISHING}. The one that
 * matters most is `maxLineLength`: the farthest the hook can ever be from the rod.
 *
 * Lives in shared (no DOM, no three.js): the server will run it.
 */

export interface FishingSettings {
  /**
   * The longest the line gets, metres: the farthest a full-charge cast lands and the
   * farthest the hook is ever allowed from the rod tip (walk away and it is dragged).
   * THE number to change to make the rod cast further or shorter.
   */
  readonly maxLineLength: number;
  /** Seconds holding left mouse to reach a full-charge cast. */
  readonly chargeSeconds: number;
  /** How far a tap of a cast goes, as a fraction of `maxLineLength` (a full charge is 1). */
  readonly minCastFraction: number;
  /**
   * Radians added to where you are looking to get the angle the hook leaves at: `arcLow`
   * for a tap, `arcHigh` for a full charge. Looking higher lobs it higher; the distance
   * is set by the charge alone.
   */
  readonly arcLow: number;
  readonly arcHigh: number;
  /** The launch angle is kept between these, radians above level. */
  readonly minLaunchAngle: number;
  readonly maxLaunchAngle: number;
  /** m/s squared, for the hook in flight. */
  readonly gravity: number;
  /** How fast the hook comes in when reeling, m/s. */
  readonly reelSpeed: number;
  /** A pickup this close to the hook is snagged by it, metres. */
  readonly hookRadius: number;
  /** Reeled this close to the player (along the ground), the catch is landed and taken, metres. */
  readonly catchRadius: number;
  /** How high the hook rides above the ground, metres. */
  readonly hookRestHeight: number;
  /** The line is drawn at this fraction of the xmas lights' thickness. */
  readonly lineScale: number;
  /** Show the dashed aim line when the rod is held and not casting, at the shortest cast. */
  readonly previewWhenIdle: boolean;
}

export const FISHING: FishingSettings = {
  // Three strings of xmas lights at their longest reach: 3 * 9 segments * 5/9 m = 15m.
  maxLineLength: ropeMaxReach(ropeSpecFor(XMAS_LIGHTS, 3)),
  chargeSeconds: 1.1,
  minCastFraction: 0.15,
  arcLow: 0.1,
  arcHigh: 0.55,
  minLaunchAngle: 0.12,
  maxLaunchAngle: 1.2,
  gravity: 9.8,
  reelSpeed: 6.5,
  hookRadius: 0.55,
  catchRadius: 1.4,
  hookRestHeight: 0.12,
  lineScale: 0.6,
  previewWhenIdle: false,
};

export const FishingState = {
  /** Line wound on the rod, hook in hand. Left mouse charges a cast. */
  Stowed: 0,
  /** The hook is in the air. */
  Flying: 1,
  /** The hook lies where it landed. */
  Resting: 2,
  /** Right mouse is held: the hook comes in along the ground. */
  Reeling: 3,
} as const;
export type FishingState = (typeof FishingState)[keyof typeof FishingState];

/** The hook is stepped at this rate whatever the frame rate, so a cast and its preview agree. */
const HOOK_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 12;
/** A cast never lands exactly at the line's limit, so landing does not yank the hook back. */
const RANGE_MARGIN = 0.97;
const MIN_LAND_DISTANCE = 0.6;
/** Preview and path points are this many hook steps apart. */
const PATH_EVERY = 6;
const PATH_MAX_STEPS = 720;
export const FISHING_PATH_POINTS = PATH_MAX_STEPS / PATH_EVERY + 2;

/** How slack the drawn line hangs, as a fraction of its length, per state. */
const SAG_FLYING = 0.03;
const SAG_RESTING = 0.07;
const SAG_REELING = 0.015;

/** The world and the player as the rod sees them this frame. Filled in by the caller. */
export interface FishingFrame {
  /** Where the line leaves the rod. */
  tipX: number;
  tipY: number;
  tipZ: number;
  /** The player's feet. */
  playerX: number;
  playerY: number;
  playerZ: number;
  /** Unit vector the player is looking along. */
  frontX: number;
  frontY: number;
  frontZ: number;
}

export function createFishingFrame(): FishingFrame {
  return { tipX: 0, tipY: 0, tipZ: 0, playerX: 0, playerY: 0, playerZ: 0, frontX: 0, frontY: 0, frontZ: 1 };
}

export interface FishingInput {
  /** The rod is the equipped item and the player is on their feet. */
  active: boolean;
  /** Left mouse is down. */
  cast: boolean;
  /** Right mouse is down. */
  reel: boolean;
}

/** What happened this frame, for sound and so on. Reset at the start of every update. */
export interface FishingEvents {
  cast: boolean;
  landed: boolean;
  hooked: boolean;
  /** Reeled in all the way and the item went into the inventory. */
  caught: boolean;
  /** Reeled in all the way but the inventory was full: the item was let go at the player's feet. */
  full: boolean;
}

interface Velocity {
  vx: number;
  vy: number;
  vz: number;
}

/**
 * The velocity that throws the hook from height `tipHeight` above the ground so it lands
 * the distance a cast of `charge` (0..1) goes, at the arc the player's look and the charge
 * give. Writes it into `out`.
 */
export function planCast(
  settings: FishingSettings,
  charge: number,
  tipHeight: number,
  frontX: number,
  frontY: number,
  frontZ: number,
  out: Velocity,
): void {
  const c = Math.min(1, Math.max(0, charge));
  const flat = Math.hypot(frontX, frontZ);
  const hx = flat > 1e-4 ? frontX / flat : 0;
  const hz = flat > 1e-4 ? frontZ / flat : 1;
  const aim = Math.atan2(frontY, flat);
  const angle = Math.min(
    settings.maxLaunchAngle,
    Math.max(settings.minLaunchAngle, aim + settings.arcLow + (settings.arcHigh - settings.arcLow) * c),
  );
  // Straight-line distance to the landing spot, then the level distance that makes it.
  const reach =
    settings.maxLineLength * RANGE_MARGIN * (settings.minCastFraction + (1 - settings.minCastFraction) * c);
  const h = Math.max(0.2, tipHeight);
  const level = Math.max(MIN_LAND_DISTANCE, Math.sqrt(Math.max(0, reach * reach - h * h)));
  // Lands `level` away on the ground after falling from height h: solve for the launch speed.
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const drop = h + level * (sin / cos);
  const speedSq = (settings.gravity * level * level) / (2 * cos * cos * Math.max(0.05, drop));
  const speed = Math.sqrt(speedSq);
  out.vx = hx * cos * speed;
  out.vy = sin * speed;
  out.vz = hz * cos * speed;
}

/**
 * Where a cast from (x, y, z) at velocity `v` goes: points (x, y, z each) written to `out`,
 * ending where it lands on the ground. Returns how many points. Steps the way the hook does.
 */
export function castPath(
  settings: FishingSettings,
  x: number,
  y: number,
  z: number,
  v: Velocity,
  ground: GroundSampler,
  out: Float32Array,
): number {
  let vy = v.vy;
  let count = 0;
  const push = (px: number, py: number, pz: number): void => {
    if ((count + 1) * 3 > out.length) return;
    out[count * 3] = px;
    out[count * 3 + 1] = py;
    out[count * 3 + 2] = pz;
    count++;
  };
  push(x, y, z);
  for (let step = 1; step <= PATH_MAX_STEPS; step++) {
    vy -= settings.gravity * HOOK_DT;
    x += v.vx * HOOK_DT;
    y += vy * HOOK_DT;
    z += v.vz * HOOK_DT;
    const rest = ground(x, z) + settings.hookRestHeight;
    if (y <= rest && vy <= 0) {
      push(x, rest, z);
      return count;
    }
    if (step % PATH_EVERY === 0) push(x, y, z);
  }
  return count;
}

export class Fishing {
  state: FishingState = FishingState.Stowed;
  /** Cast charge, 0..1; above zero only while left mouse is held to throw. */
  charge = 0;
  hookX = 0;
  hookY = 0;
  hookZ = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private airborne = false;
  /** The pickup on the hook, if any. */
  hooked: Pickup | undefined;
  /** How slack the drawn line is, eased; a fraction of its length. */
  sag = SAG_RESTING;
  readonly events: FishingEvents = { cast: false, landed: false, hooked: false, caught: false, full: false };
  /** The aim line: x, y, z for each point, valid up to `pathCount` (0: not shown). */
  readonly path = new Float32Array(FISHING_PATH_POINTS * 3);
  pathCount = 0;

  /** Left mouse has been up since the line was last put away, so a held button does not cast at once. */
  private armed = false;
  private clock = 0;
  private readonly velocity: Velocity = { vx: 0, vy: 0, vz: 0 };

  constructor(readonly settings: FishingSettings = FISHING) {}

  /** True while the line is out (the hook is not in the player's hand). */
  get lineOut(): boolean {
    return this.state !== FishingState.Stowed;
  }

  /** One frame. Call with `active` false whenever the rod is not equipped, to put the line away. */
  update(
    dt: number,
    input: FishingInput,
    frame: FishingFrame,
    ground: GroundSampler,
    pickups: PickupField,
    inventory: Inventory,
  ): FishingEvents {
    const events = this.events;
    events.cast = false;
    events.landed = false;
    events.hooked = false;
    events.caught = false;
    events.full = false;
    this.pathCount = 0;

    if (!input.active) {
      this.stow(ground);
      this.armed = false;
      return events;
    }
    if (!input.cast) this.armed = true;

    if (this.state === FishingState.Stowed) {
      this.updateCharge(dt, input, frame, ground);
    } else {
      // Reeling lasts as long as right mouse is held; letting go leaves the hook where it is.
      if (input.reel && this.state !== FishingState.Reeling) this.state = FishingState.Reeling;
      else if (!input.reel && this.state === FishingState.Reeling) {
        this.state = this.airborne ? FishingState.Flying : FishingState.Resting;
        this.vx = 0;
        this.vz = 0;
      }
      this.stepHook(dt, frame, ground, pickups, inventory);
    }

    const sagWanted =
      this.state === FishingState.Flying
        ? SAG_FLYING
        : this.state === FishingState.Reeling
          ? SAG_REELING
          : SAG_RESTING;
    this.sag += (sagWanted - this.sag) * Math.min(1, dt * 6);
    return events;
  }

  /** Left mouse charges the cast; letting go throws it. Right mouse while charging cancels it. */
  private updateCharge(dt: number, input: FishingInput, frame: FishingFrame, ground: GroundSampler): void {
    const s = this.settings;
    if (this.charge > 0 && input.reel) {
      this.charge = 0;
      this.armed = false;
    } else if (input.cast && (this.charge > 0 || this.armed)) {
      // Never exactly zero once started, so a click shorter than a frame still casts.
      this.charge = Math.max(1e-3, Math.min(1, this.charge + dt / s.chargeSeconds));
      this.armed = true;
    } else if (this.charge > 0) {
      this.cast(frame);
      this.charge = 0;
      return;
    }

    if (this.charge > 0 || s.previewWhenIdle) {
      this.aim(this.charge, frame, ground);
    }
  }

  /** Fills `path` with where a cast of this charge would go. */
  private aim(charge: number, frame: FishingFrame, ground: GroundSampler): void {
    const v = this.velocity;
    planCast(this.settings, charge, frame.tipY - frame.playerY, frame.frontX, frame.frontY, frame.frontZ, v);
    this.pathCount = castPath(this.settings, frame.tipX, frame.tipY, frame.tipZ, v, ground, this.path);
  }

  private cast(frame: FishingFrame): void {
    const v = this.velocity;
    planCast(
      this.settings,
      this.charge,
      frame.tipY - frame.playerY,
      frame.frontX,
      frame.frontY,
      frame.frontZ,
      v,
    );
    this.hookX = frame.tipX;
    this.hookY = frame.tipY;
    this.hookZ = frame.tipZ;
    this.vx = v.vx;
    this.vy = v.vy;
    this.vz = v.vz;
    this.airborne = true;
    this.state = FishingState.Flying;
    this.clock = 0;
    this.events.cast = true;
  }

  private stepHook(
    dt: number,
    frame: FishingFrame,
    ground: GroundSampler,
    pickups: PickupField,
    inventory: Inventory,
  ): void {
    const s = this.settings;
    this.clock += Math.min(dt, MAX_STEPS_PER_FRAME * HOOK_DT);
    let steps = Math.floor(this.clock / HOOK_DT);
    this.clock -= steps * HOOK_DT;
    steps = Math.min(steps, MAX_STEPS_PER_FRAME);

    // Let go of an item that someone else took (E) or that timed out.
    if (this.hooked !== undefined && !pickups.items.includes(this.hooked)) this.hooked = undefined;

    for (let i = 0; i < steps; i++) {
      const reeling = this.state === FishingState.Reeling;
      if (reeling) {
        const dx = frame.playerX - this.hookX;
        const dz = frame.playerZ - this.hookZ;
        const flat = Math.hypot(dx, dz);
        if (flat <= s.catchRadius) {
          this.land(ground, pickups, inventory, frame);
          return;
        }
        this.vx = (dx / flat) * s.reelSpeed;
        this.vz = (dz / flat) * s.reelSpeed;
      }

      if (this.airborne) this.vy -= s.gravity * HOOK_DT;
      this.hookX += this.vx * HOOK_DT;
      this.hookY += this.vy * HOOK_DT;
      this.hookZ += this.vz * HOOK_DT;

      const rest = ground(this.hookX, this.hookZ) + s.hookRestHeight;
      if (this.airborne) {
        if (this.hookY <= rest && this.vy <= 0) {
          this.hookY = rest;
          this.vx = 0;
          this.vy = 0;
          this.vz = 0;
          this.airborne = false;
          if (this.state === FishingState.Flying) {
            this.state = FishingState.Resting;
            this.events.landed = true;
          }
        }
      } else {
        // On the ground it follows the ground, and drops if the ground falls away.
        this.hookY = rest;
        if (!reeling) {
          this.vx = 0;
          this.vz = 0;
        }
      }

      this.pullTaut(frame, ground);
      this.snag(pickups);
      if (this.hooked !== undefined) this.carry(ground);
    }
  }

  /** The line is only so long: past it the hook is dragged after the rod. */
  private pullTaut(frame: FishingFrame, ground: GroundSampler): void {
    const s = this.settings;
    const dx = this.hookX - frame.tipX;
    const dy = this.hookY - frame.tipY;
    const dz = this.hookZ - frame.tipZ;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= s.maxLineLength) return;
    const k = s.maxLineLength / distance;
    this.hookX = frame.tipX + dx * k;
    this.hookY = frame.tipY + dy * k;
    this.hookZ = frame.tipZ + dz * k;
    if (this.airborne) {
      this.vx = 0;
      this.vz = 0;
    }
    const rest = ground(this.hookX, this.hookZ) + s.hookRestHeight;
    if (this.hookY < rest) {
      this.hookY = rest;
      this.vy = 0;
      this.airborne = false;
    }
  }

  /** Hooks the nearest free pickup within reach of the hook, while it is flying or being reeled. */
  private snag(pickups: PickupField): void {
    if (this.hooked !== undefined || this.state === FishingState.Resting) return;
    const radiusSq = this.settings.hookRadius * this.settings.hookRadius;
    let best: Pickup | undefined;
    let bestSq = radiusSq;
    for (const item of pickups.items) {
      if (item.stuck !== undefined) continue;
      const dx = item.x - this.hookX;
      const dy = item.y - this.hookY;
      const dz = item.z - this.hookZ;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq <= bestSq) {
        best = item;
        bestSq = dSq;
      }
    }
    if (best === undefined) return;
    this.hooked = best;
    best.vx = 0;
    best.vy = 0;
    best.vz = 0;
    best.landed = true;
    this.events.hooked = true;
    if (this.state === FishingState.Flying) {
      // Caught in the air: the cast ends where the item is.
      this.vx = 0;
      this.vz = 0;
    }
  }

  /** The hooked item rides along under the hook. */
  private carry(ground: GroundSampler): void {
    const item = this.hooked;
    if (item === undefined) return;
    item.x = this.hookX;
    item.z = this.hookZ;
    item.groundY = ground(item.x, item.z);
    item.landed = true;
  }

  /** Reeled in: take the catch into the inventory, or let it go, and wind the line up. */
  private land(ground: GroundSampler, pickups: PickupField, inventory: Inventory, frame: FishingFrame): void {
    const item = this.hooked;
    if (item !== undefined) {
      if (pickups.collect(item, inventory)) {
        this.events.caught = true;
      } else {
        // Nowhere to put it: it falls at the player's feet.
        item.x = frame.playerX;
        item.z = frame.playerZ;
        item.groundY = ground(item.x, item.z);
        item.landed = false;
        this.events.full = true;
      }
    }
    this.hooked = undefined;
    this.state = FishingState.Stowed;
    this.airborne = false;
    this.armed = false;
  }

  /** Puts the line away at once (rod unequipped): a hooked item is let go where it lies. */
  private stow(ground: GroundSampler): void {
    if (this.hooked !== undefined) {
      this.hooked.groundY = ground(this.hooked.x, this.hooked.z);
      this.hooked.landed = false;
      this.hooked = undefined;
    }
    this.state = FishingState.Stowed;
    this.charge = 0;
    this.airborne = false;
  }
}
