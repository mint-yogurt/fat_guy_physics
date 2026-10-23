import { GRAVITY } from "../sim/player.ts";

/**
 * Spring shoes: worn while they are the selected hotbar item. They turn
 * walking into bounding, and they work as a trampoline does -- energy in,
 * energy out -- so nothing here is a flat "jump height":
 *
 *  - walking on the ground, each step is a small leap (STRIDE_HOP_SPEED);
 *  - every landing comes back off at RESTITUTION times its landing speed, and a
 *    landing in the middle of a stride puts STRIDE_BOOST more in, so a run of
 *    bounds climbs, up to STRIDE_CAP_SPEED -- what the legs alone can add;
 *  - a landing timed with a jump (space held, or pressed just before) adds
 *    PUMP_SPEED more, up to PUMP_CAP_SPEED;
 *  - a jump from standing is JUMP_FACTOR times a plain jump;
 *  - a drop from height lands fast and goes back up nearly as high, past those
 *    caps, because that energy came from the fall;
 *  - landing on a trampoline mat the mat has already sent the player back up
 *    (items/trampoline.ts); the springs add MAT_GAIN on top of that.
 *
 * Only the Walking body uses them: not the ragball, not on a skateboard.
 *
 * STUB, for later: shoes are not meant to last forever. {@link SpringStride.bounds}
 * counts the bounds taken, and {@link SPRING_SHOES_LIFETIME} is how many a pair
 * survives. It is infinite for now, so nothing ever breaks; wiring it to
 * a "worn out" state (the item breaking, a sound, a stack that remembers its
 * wear) is the TODO in the README.
 */

/** Bounds a pair of shoes lasts before it breaks. Infinite until wear is built. */
export const SPRING_SHOES_LIFETIME = Number.POSITIVE_INFINITY;

/** Fraction of landing speed returned; the rest is lost in the springs. */
export const SPRING_RESTITUTION = 0.9;
/** Landing slower than this (m/s) is a footfall, not a rebound. */
export const SPRING_MIN_IMPACT = 1.5;
/** Take-off speed of a step on the ground while moving, m/s. */
export const STRIDE_HOP_SPEED = 3.4;
/** Speed a landing mid-stride adds, m/s. */
export const STRIDE_BOOST = 1.4;
/** Striding stops adding speed once the rebound is this fast. */
export const STRIDE_CAP_SPEED = 10;
/** A jump from standing, as a multiple of the usual jump speed. */
export const SPRING_JUMP_FACTOR = 1.7;
/** Speed a landing timed with a jump adds, m/s. */
export const SPRING_PUMP_SPEED = 2.5;
/** Pumping stops adding speed once the rebound is this fast. */
export const SPRING_PUMP_CAP_SPEED = 15;
/** What a trampoline's rebound is multiplied by under the springs. */
export const SPRING_MAT_GAIN = 1.25;
/** Landing on a mat stops adding once the rebound is this fast, m/s. */
export const SPRING_MAT_CAP_SPEED = 20;

/** The slice of the player the shoes read and write. */
export interface SpringPlayer {
  vy: number;
  grounded: boolean;
}

/** What happened in the player's step, as the shoes need it. */
export interface StrideStep {
  /** Was on the ground before the step. */
  wasGrounded: boolean;
  /** `vy` before the step. */
  preVy: number;
  /** Walking input is held. */
  moving: boolean;
  /** A jump was taken in the step. */
  jumped: boolean;
  /** Space is held, or was pressed a moment ago: a landing now is timed with a jump. */
  pumping: boolean;
  /** The speed a trampoline just threw the player back up at, if it did; else 0. */
  matRebound: number;
}

/** `base` plus `add`, unless `base` is already past `cap`. */
function climb(base: number, add: number, cap: number): number {
  return Math.min(base + add, Math.max(base, cap));
}

export class SpringStride {
  /** Bounds taken since the shoes were new; what the wear stub counts. */
  bounds = 0;

  /** Whether the pair has had all it can take. Never, until {@link SPRING_SHOES_LIFETIME} is finite. */
  get wornOut(): boolean {
    return this.bounds >= SPRING_SHOES_LIFETIME;
  }

  /**
   * After one player step with the shoes on: turns a landing into a rebound, a
   * step into a leap, and a jump into a big one.
   *
   * Returns the speed (m/s) the player was launched upwards at, else 0, so the
   * caller can make a sound out of it.
   */
  afterPlayerStep(player: SpringPlayer, dt: number, step: StrideStep, jumpSpeed: number): number {
    // The jump the step itself took, made bigger.
    if (step.jumped && step.wasGrounded && player.vy > 0) {
      return this.launch(player, jumpSpeed * SPRING_JUMP_FACTOR);
    }

    // A mat has already thrown them back up: the springs add to that.
    if (step.matRebound > 0 && !player.grounded) {
      const rebound = player.vy;
      let out = Math.min(rebound * SPRING_MAT_GAIN, Math.max(rebound, SPRING_MAT_CAP_SPEED));
      if (step.pumping) out = climb(out, SPRING_PUMP_SPEED, SPRING_MAT_CAP_SPEED);
      return this.launch(player, out);
    }

    if (!player.grounded) return 0;

    // Came down this step: the rebound. The step's own collision zeroed vy,
    // so the speed they landed at is only recoverable from before it.
    const impact = step.wasGrounded ? 0 : -(step.preVy + GRAVITY * dt);
    if (impact >= SPRING_MIN_IMPACT) {
      let out = impact * SPRING_RESTITUTION;
      if (step.moving) out = climb(out, STRIDE_BOOST, STRIDE_CAP_SPEED);
      if (step.pumping) out = climb(out, SPRING_PUMP_SPEED, SPRING_PUMP_CAP_SPEED);
      return this.launch(player, out);
    }

    // On the ground and walking: the next step is a leap.
    if (step.moving) return this.launch(player, STRIDE_HOP_SPEED);
    return 0;
  }

  private launch(player: SpringPlayer, speed: number): number {
    player.vy = speed;
    player.grounded = false;
    this.bounds++;
    return speed;
  }
}
