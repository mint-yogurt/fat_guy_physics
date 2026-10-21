import { createAabbCollision, sweepAabb, type SolidQuery } from "./collision.ts";
import { groundTop, wrapPi, type BoardLaunch } from "./skate.ts";

/**
 * A skateboard with no one on it: what a bail leaves behind. It carries on
 * with the speed it had, tumbles, lands, rolls on (down slopes, over small
 * steps, back off walls it hits) and finally comes to rest, at which point the
 * caller swaps it for an ordinary pickup to go and fetch.
 *
 * Stepped on the same fixed clock as the player, against the same solids.
 */

const HALF_WIDTH = 0.25;
const HEIGHT = 0.25;
const STEP_HEIGHT = 0.12;
const GRAVITY = 18;
const AIR_DRAG = 0.1;
/** Rolling resistance on the ground: a constant (m/s^2) and a proportional (1/s) part. */
const ROLL_DRAG = 1;
const ROLL_DRAG_PROPORTIONAL = 0.18;
const SPIN_DAMPING = 4;
/** What a landing, and a wall, give back of the speed they were hit with. */
const FLOOR_BOUNCE = 0.35;
const WALL_BOUNCE = 0.4;
const MIN_BOUNCE_SPEED = 1.5;
/** Slower than this on a slope too gentle to pull it along, and it stays put. */
const REST_SPEED = 0.3;
const REST_SLOPE = 0.12;
const REST_SECONDS = 0.4;
/** Given up on after this long, so a board that rolled into an unloaded gap is not lost. */
const MAX_AGE_SECONDS = 25;
const FALL_LIMIT_Y = -5;
const SLOPE_REACH = 0.4;

export class LooseBoard {
  x: number;
  y: number;
  z: number;
  /** Last substep's position, for drawing between substeps. */
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  flip: number;
  grounded = false;

  private spin: number;
  private tumble: number;
  private slopeX = 0;
  private slopeZ = 0;
  private restTime = 0;
  private age = 0;
  private readonly hit = createAabbCollision();

  constructor(launch: BoardLaunch) {
    this.x = this.prevX = launch.x;
    this.y = this.prevY = launch.y;
    this.z = this.prevZ = launch.z;
    this.vx = launch.vx;
    this.vy = launch.vy;
    this.vz = launch.vz;
    this.heading = launch.heading;
    this.flip = launch.flip;
    this.spin = launch.spin;
    this.tumble = launch.tumble;
  }

  /** Stopped and lying there (or lost): time to become a pickup. */
  get settled(): boolean {
    return this.restTime >= REST_SECONDS || this.age > MAX_AGE_SECONDS || this.y < FALL_LIMIT_Y;
  }

  /** Lying on something, as opposed to lost, so a pickup can sit right on it. */
  get resting(): boolean {
    return this.restTime >= REST_SECONDS;
  }

  update(dt: number, query: SolidQuery): void {
    this.age += dt;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.vy -= GRAVITY * dt;

    let gradient = 0;
    if (this.grounded) {
      gradient = this.pull(query, dt);
      const speed = Math.hypot(this.vx, this.vz);
      if (speed < REST_SPEED && gradient < REST_SLOPE) {
        this.vx = 0;
        this.vz = 0;
      } else if (speed > 0) {
        const slowed = speed * (1 - Math.exp(-ROLL_DRAG_PROPORTIONAL * dt)) + ROLL_DRAG * dt;
        const keep = Math.max(0, speed - slowed) / speed;
        this.vx *= keep;
        this.vz *= keep;
      }
    } else {
      const keep = Math.max(0, 1 - AIR_DRAG * dt);
      this.vx *= keep;
      this.vz *= keep;
    }

    const inVx = this.vx;
    const inVy = this.vy;
    const inVz = this.vz;
    const r = sweepAabb(query, this.x, this.y, this.z, HALF_WIDTH, HEIGHT, inVx, inVy, inVz, dt, STEP_HEIGHT, this.hit);
    this.x = r.x;
    this.y = r.y;
    this.z = r.z;
    // A blocked axis is a wall: kick back off it rather than stopping dead.
    this.vx = Math.abs(r.vx - inVx) > 1e-6 ? -inVx * WALL_BOUNCE : r.vx;
    this.vz = Math.abs(r.vz - inVz) > 1e-6 ? -inVz * WALL_BOUNCE : r.vz;
    this.vy = r.vy;
    if (Math.abs(r.vy - inVy) > 1e-6 && inVy < -MIN_BOUNCE_SPEED) this.vy = -inVy * FLOOR_BOUNCE;
    this.grounded = r.grounded && this.vy <= 0;

    this.heading += this.spin * dt;
    if (this.grounded) {
      // On its wheels it rolls the way it is going, and the tumble dies out.
      this.spin *= Math.exp(-SPIN_DAMPING * dt);
      this.tumble = 0;
      const speed = Math.hypot(this.vx, this.vz);
      if (speed > 1) {
        let diff = wrapPi(Math.atan2(this.vz, this.vx) - this.heading);
        if (Math.abs(diff) > Math.PI / 2) diff -= Math.sign(diff) * Math.PI;
        this.heading = wrapPi(this.heading + diff * Math.min(1, dt * 4));
      }
      this.flip = wrapPi(this.flip);
      this.flip -= this.flip * Math.min(1, dt * 10);
      const resting = Math.hypot(this.vx, this.vz) < REST_SPEED && gradient < REST_SLOPE;
      this.restTime = resting ? this.restTime + dt : 0;
    } else {
      this.flip += this.tumble * dt;
      this.restTime = 0;
    }
  }

  /** Gravity along the slope under the board; returns how steep it is. */
  private pull(query: SolidQuery, dt: number): number {
    const top = this.y + 0.5;
    const east = groundTop(query, this.x + SLOPE_REACH, this.z, top, 1.5);
    const west = groundTop(query, this.x - SLOPE_REACH, this.z, top, 1.5);
    const south = groundTop(query, this.x, this.z + SLOPE_REACH, top, 1.5);
    const north = groundTop(query, this.x, this.z - SLOPE_REACH, top, 1.5);
    // Over an edge there is nothing to measure: keep what the wheels last felt.
    const blend = Math.min(1, dt * 15);
    if (east > -Infinity && west > -Infinity) {
      this.slopeX += ((east - west) / (2 * SLOPE_REACH) - this.slopeX) * blend;
    }
    if (south > -Infinity && north > -Infinity) {
      this.slopeZ += ((south - north) / (2 * SLOPE_REACH) - this.slopeZ) * blend;
    }
    const steepness = Math.hypot(this.slopeX, this.slopeZ);
    const scale = (GRAVITY * dt) / (1 + steepness * steepness);
    this.vx -= this.slopeX * scale;
    this.vz -= this.slopeZ * scale;
    return steepness;
  }
}
