import type { OrientedBody } from "../sim/sceneQuery.ts";
import { GRAVITY } from "../sim/player.ts";

/**
 * Trampolines: placed with the Trampoline item, bounced on by the player and
 * by anything thrown or dropped onto them, picked back up with E.
 *
 * A trampoline is a spring, so what it gives back is what it was given:
 * energy in, energy out, less a little lost to the mat. Nothing here is a
 * flat "bounce height". Everything that lands comes back off at
 * RESTITUTION times its landing speed, so
 *
 *  - walking on adds almost no speed, so there is almost no bounce;
 *  - a hop from standstill is a small bounce, and each landing that is
 *    timed with a jump (space held, as a jumper pumps their knees) puts a
 *    little more in than the mat took out, so the bounces climb, up to
 *    PUMP_CAP_SPEED -- the most a jumper can put in from the legs alone;
 *  - a drop from height lands fast and goes back up nearly as high, past
 *    that cap, because the energy came from the fall and not the legs.
 *
 * The same RESTITUTION is what the rigid-body side (logs) and the pickup
 * field (dropped items) use, so a log and a player drop off the same height
 * rebound alike.
 *
 * The trampoline is solid to the player like any other body -- a column from
 * below the ground up to the mat, stood on and stepped onto through the
 * normal sweep -- and this module adds the rebound on top of that landing.
 */

/** Mat radius and height above the ground, metres. The mat is at step height so it can be walked onto. */
export const TRAMPOLINE_RADIUS = 1.2;
export const TRAMPOLINE_HEIGHT = 0.5;
/** The solid column runs this far below the base, so a trampoline on a slope has no gap under it. */
export const TRAMPOLINE_SINK = 0.6;

/** Fraction of landing speed returned; the rest is lost to the mat and frame. */
export const TRAMPOLINE_RESTITUTION = 0.92;
/** Landing slower than this (m/s) is a step onto the mat, not a bounce. */
export const MIN_BOUNCE_IMPACT = 1.5;
/** Take-off speed of a jump from standing still on the mat. */
export const STAND_JUMP_SPEED = 3;
/** Speed a mistimed-free, well-timed jump adds on each landing. */
export const PUMP_SPEED = 2;
/** Pumping stops adding speed once the jumper is going this fast. */
export const PUMP_CAP_SPEED = 13;
/** How long after pressing jump a landing still counts as timed with it, seconds. */
export const PUMP_BUFFER_SECONDS = 0.2;

/** Extra reach around the mat that still counts as being on it, for the player's own width. */
const STAND_MARGIN = 0.4;
const STAND_TOLERANCE_Y = 0.08;
/** Minimum spacing between centres, so two mats never overlap. */
const MIN_SPACING = TRAMPOLINE_RADIUS * 2;
/** How finely the aim ray is walked when looking for a trampoline to pick up. */
const AIM_STEP = 0.1;

export interface Trampoline {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Ground under the mat's legs. */
  readonly baseY: number;
  /** Top of the mat. */
  readonly topY: number;
  /** The solid column, as the player's sweep and the physics world both see it. */
  readonly body: OrientedBody;
}

/** The speed a landing at `impact` m/s comes back off at, given whether it was timed with a jump. */
export function bounceSpeed(impact: number, pumping: boolean): number {
  const base = impact >= MIN_BOUNCE_IMPACT ? impact * TRAMPOLINE_RESTITUTION : 0;
  if (!pumping) return base;
  return Math.min(base + PUMP_SPEED, Math.max(base, PUMP_CAP_SPEED));
}

/** The slice of the player the rebound reads and writes. */
export interface BouncePlayer {
  x: number;
  y: number;
  z: number;
  vy: number;
  grounded: boolean;
}

export class TrampolineField {
  readonly items: Trampoline[] = [];
  /** Ids removed since the last call, for the renderer and physics to drop theirs. */
  readonly removed: number[] = [];
  private nextId = 1;

  /** Whether a mat centred here would overlap another. */
  canPlace(x: number, z: number): boolean {
    for (const item of this.items) {
      if (Math.hypot(item.x - x, item.z - z) < MIN_SPACING) return false;
    }
    return true;
  }

  place(x: number, baseY: number, z: number): Trampoline | undefined {
    if (!this.canPlace(x, z)) return undefined;
    const halfHeight = (TRAMPOLINE_HEIGHT + TRAMPOLINE_SINK) / 2;
    const item: Trampoline = {
      id: this.nextId++,
      x,
      z,
      baseY,
      topY: baseY + TRAMPOLINE_HEIGHT,
      body: {
        radius: TRAMPOLINE_RADIUS,
        halfHeight,
        x,
        y: baseY - TRAMPOLINE_SINK + halfHeight,
        z,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      },
    };
    this.items.push(item);
    return item;
  }

  remove(item: Trampoline): void {
    const index = this.items.indexOf(item);
    if (index < 0) return;
    this.items.splice(index, 1);
    this.removed.push(item.id);
  }

  /** Top of the highest mat over this point, if any. */
  topAt(x: number, z: number): number | undefined {
    let top: number | undefined;
    for (const item of this.items) {
      if (Math.hypot(x - item.x, z - item.z) > TRAMPOLINE_RADIUS) continue;
      if (top === undefined || item.topY > top) top = item.topY;
    }
    return top;
  }

  /** What the surface under this point gives back, 0 where there is no mat. */
  restitutionAt(x: number, z: number): number {
    return this.topAt(x, z) === undefined ? 0 : TRAMPOLINE_RESTITUTION;
  }

  /** The mat under a standing player's feet, if any. */
  private under(x: number, y: number, z: number): Trampoline | undefined {
    for (const item of this.items) {
      if (
        Math.hypot(x - item.x, z - item.z) <= TRAMPOLINE_RADIUS + STAND_MARGIN &&
        Math.abs(y - item.topY) <= STAND_TOLERANCE_Y
      ) {
        return item;
      }
    }
    return undefined;
  }

  /** Whether the player is standing on a mat right now. Call before the step. */
  isStandingOn(player: BouncePlayer): boolean {
    return player.grounded && this.under(player.x, player.y, player.z) !== undefined;
  }

  /**
   * After one player step: turns a landing on a mat into the rebound, and a
   * jump from a mat into a small hop.
   *
   * `wasStanding` and `preVy` are what {@link isStandingOn} and `player.vy`
   * were before the step. The step's own collision zeroes vy on landing, so
   * the speed the player arrived at is only recoverable from before it.
   *
   * Returns the speed (m/s) the player hit the mat at when it threw them back
   * up, else 0, so the caller can make a sound out of it.
   */
  afterPlayerStep(
    player: BouncePlayer,
    wasStanding: boolean,
    preVy: number,
    dt: number,
    jumped: boolean,
    pumping: boolean,
  ): number {
    if (!player.grounded && !(jumped && wasStanding)) return 0;

    if (jumped && wasStanding && player.vy > 0) {
      // The jump the player's own step took was a ground jump; off a mat it
      // is a small hop that the landing then builds on.
      player.vy = STAND_JUMP_SPEED;
      player.grounded = false;
      return 0;
    }

    if (!player.grounded || this.under(player.x, player.y, player.z) === undefined) return 0;
    const impact = -(preVy + GRAVITY * dt);
    const out = bounceSpeed(impact, pumping);
    if (out > 0 && impact >= MIN_BOUNCE_IMPACT) {
      player.vy = out;
      player.grounded = false;
      return impact;
    }
    return 0;
  }

  /**
   * The mat a ray is aimed at within `reach` metres, for E to pick up. Walked
   * in small steps against the solid column: cheap, there are only a few.
   */
  target(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    reach: number,
  ): Trampoline | undefined {
    if (this.items.length === 0) return undefined;
    for (let along = 0; along <= reach; along += AIM_STEP) {
      const x = eyeX + dirX * along;
      const y = eyeY + dirY * along;
      const z = eyeZ + dirZ * along;
      for (const item of this.items) {
        if (
          y <= item.topY + 0.05 &&
          y >= item.baseY &&
          Math.hypot(x - item.x, z - item.z) <= TRAMPOLINE_RADIUS
        ) {
          return item;
        }
      }
    }
    return undefined;
  }

  /**
   * Appends the mats near a point to `out`, as the solid bodies the player's
   * sweep tests against.
   */
  collectNear(x: number, z: number, range: number, out: OrientedBody[]): void {
    for (const item of this.items) {
      if (Math.hypot(x - item.x, z - item.z) <= range + TRAMPOLINE_RADIUS) out.push(item.body);
    }
  }

  clear(): void {
    for (const item of this.items) this.removed.push(item.id);
    this.items.length = 0;
  }
}
