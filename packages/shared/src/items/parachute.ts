/**
 * The parachute: worn while it is the selected hotbar item (see items/gear.ts for the day it
 * stops being one). Nothing is clicked. It opens by itself the moment the player is falling
 * ({@link CHUTE_OPEN_FALL_SPEED}, after {@link CHUTE_OPEN_DELAY}), even from the top of a hop:
 *
 *  - the canopy takes {@link CHUTE_OPEN_SECONDS} to fill, and as it does the fall eases from
 *    whatever it was to {@link CHUTE_SINK_SPEED} (m/s, steady). Falling in from higher means a longer glide,
 *    because the descent is slow and the drift forward does not stop: distance covered is
 *    about the height left times {@link CHUTE_SPEED} / {@link CHUTE_SINK_SPEED};
 *  - it carries the player along a heading at {@link CHUTE_SPEED}. The heading starts as the way
 *    they were already going and turns only slowly towards where they look
 *    ({@link CHUTE_TURN_DEG}/s), so steering is a lean, not a drive;
 *  - A and D slide the player sideways a little, W and S trim the speed a little. Nothing else.
 *
 * It lets go on landing, on being put away, or in any body but the walking one. A hang glider
 * is meant to be the steerable, faster cousin of this: same shape, bigger numbers.
 *
 * Plain numbers in, plain numbers out (no Player import), so the sim and its test share it.
 */

/** Seconds the canopy takes to fill once it has been let go. */
export const CHUTE_OPEN_SECONDS = 0.15;
/** The canopy opens once the fall has been faster than this (m/s) for {@link CHUTE_OPEN_DELAY}: a hair, so the top of a jump does not flicker it. */
export const CHUTE_OPEN_FALL_SPEED = 0.5;
/** Seconds of falling before it opens; none, it opens at once. */
export const CHUTE_OPEN_DELAY = 0;
/** Steady descent under an open canopy, m/s. */
export const CHUTE_SINK_SPEED = 3;
/** Speed along the heading, m/s. */
export const CHUTE_SPEED = 5.5;
/** What W and S can add to or take from that speed, as a fraction. */
export const CHUTE_TRIM = 0.25;
/** How fast the player's velocity follows the heading, m/s^2. */
export const CHUTE_ACCEL = 4;
/** Degrees per second the heading turns towards the look direction. */
export const CHUTE_TURN_DEG = 28;
/** Sideways slide on A / D, m/s. */
export const CHUTE_STRAFE = 1.4;

const DEG_TO_RAD = Math.PI / 180;

/** The slice of the player the canopy reads. */
export interface ChutePlayer {
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  /** Look direction in degrees; the sim's convention (front = cos, sin in x, z). */
  readonly yaw: number;
}

/** The slice of the input it reads. */
export interface ChuteInput {
  moveX: number;
  moveZ: number;
}

/** Shortest signed turn from `from` to `to`, degrees. */
function angleBetween(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export class Glide {
  /** How full the canopy is, 0 (stowed) to 1; the client draws it from this. */
  open = 0;
  /** Direction of travel, degrees (the same convention as the player's yaw). */
  heading = 0;
  /** Seconds the fall has been fast enough to open on. */
  private falling = 0;
  /** The fall speed (m/s, positive) when the canopy let go. */
  private fallAtOpen = CHUTE_SINK_SPEED;
  /** The velocity the player's steering is asked to follow, x and z, m/s. */
  wishX = 0;
  wishZ = 0;

  /** Whether the canopy is out and carrying the player this step. */
  get carrying(): boolean {
    return this.open > 0;
  }

  /** Puts it away at once. */
  reset(): void {
    this.open = 0;
    this.falling = 0;
  }

  /**
   * Once per step before the player's steering. `worn` is whether the parachute is on (selected,
   * today). Returns true while the canopy is out, in which case {@link wishX}/{@link wishZ} are the
   * velocity to steer towards (at {@link CHUTE_ACCEL}) and {@link sink} replaces the plain fall.
   */
  update(player: ChutePlayer, input: ChuteInput, dt: number, worn: boolean): boolean {
    if (!worn || player.grounded) {
      this.reset();
      return false;
    }
    if (this.open === 0) {
      this.falling = player.vy < -CHUTE_OPEN_FALL_SPEED ? this.falling + dt : 0;
      if (this.falling === 0 || this.falling < CHUTE_OPEN_DELAY) return false;
      this.fallAtOpen = Math.max(-player.vy, CHUTE_SINK_SPEED);
      // Let go: the way they were going is the way they go on, until they steer.
      const going = Math.hypot(player.vx, player.vz);
      this.heading = going > 0.5 ? Math.atan2(player.vz, player.vx) / DEG_TO_RAD : player.yaw;
    }
    this.open = Math.min(1, this.open + dt / CHUTE_OPEN_SECONDS);

    const turn = angleBetween(this.heading, player.yaw);
    const step = CHUTE_TURN_DEG * dt;
    this.heading += Math.max(-step, Math.min(step, turn));

    const heading = this.heading * DEG_TO_RAD;
    const forward = CHUTE_SPEED * (1 + CHUTE_TRIM * input.moveZ);
    const slide = CHUTE_STRAFE * input.moveX;
    this.wishX = Math.cos(heading) * forward - Math.sin(heading) * slide;
    this.wishZ = Math.sin(heading) * forward + Math.cos(heading) * slide;
    return true;
  }

  /**
   * The fall speed after this step's gravity: no faster than the canopy allows, which eases from
   * the speed it let go at to the steady sink as it fills.
   */
  sink(vy: number): number {
    const filled = this.open * this.open * (3 - 2 * this.open);
    const slowest = -(CHUTE_SINK_SPEED + (this.fallAtOpen - CHUTE_SINK_SPEED) * (1 - filled));
    return Math.max(vy, slowest);
  }
}
