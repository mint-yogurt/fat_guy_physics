import { sweepAabb, createAabbCollision, type SolidQuery } from "./collision.ts";
import { VOXEL_SIZE } from "./constants.ts";
import type { Player, PlayerInput } from "./player.ts";

/**
 * Riding a skateboard: a basic, arcade skate-game feel on top of the walking
 * collider. Player.updateSkating runs `beforeSweep`, the collision sweep, then
 * `afterSweep`, once per fixed substep.
 *
 *  - The board has a heading that chases the look direction, slowly on the
 *    ground (so it is steered with the mouse and carves), freely in the air
 *    (so you can spin).
 *  - W pushes with a leg: slow at first, ramping up the longer it is held.
 *    S drags a foot. Otherwise the board coasts, and slopes pull it along.
 *  - Ollie (Space or left mouse) pops off the ground; kickflip (right mouse in
 *    the air) rolls the board under you; right mouse on the ground is a manual.
 *  - Land with the board across your path, or mid-flip, or off a big drop, or
 *    run into something fast, and you bail: all momentum stops and you are
 *    down for a moment.
 */

/** Height of the board above the ground: the rider and camera are lifted by this. */
export const SKATE_BOARD_HEIGHT = 0.255;
/** Along the board, metres. */
export const SKATE_BOARD_LENGTH = 1.2;

const GRAVITY = 18;
/** Board turn rate chasing the look direction on the ground, rad/s, falling with speed. */
const TURN_RATE = 3.6;
const TURN_SPEED_DAMPING = 0.12;
/** In the air, the board follows the look direction this fast, rad/s. */
const AIR_SPIN_RATE = 14;
/** Sideways speed bleeds off at this rate (1/s); half of what is lost is kept as forward speed. */
const GRIP = 9;
const CARVE_KEEP = 0.5;
/** Rolling resistance: a constant drag (m/s^2) plus a proportional one (1/s). */
const ROLL_DRAG = 0.35;
const ROLL_DRAG_PROPORTIONAL = 0.22;
const BRAKE = 10;
const MANUAL_DRAG = 0.5;

const PUSH_RAMP_SECONDS = 2.4;
const PUSH_RAMP_DECAY = 1.2;
/** Pushes per second at the start of a run and once fully ramped up. */
const PUSH_RATE_MIN = 1.3;
const PUSH_RATE_MAX = 2.4;
/** Peak acceleration of a push stroke, m/s^2, at the start and fully ramped up. */
const PUSH_ACCEL_MIN = 5;
const PUSH_ACCEL_MAX = 10;
/** Pushing stops adding speed past this, which rises as the run ramps up. */
const PUSH_MAX_SPEED_MIN = 5;
const PUSH_MAX_SPEED_MAX = 11;

/**
 * At the speed pushing can reach, the rider stops pushing and just rides,
 * holding that speed; the push starts again once something (an uphill, a
 * turn, a lift in the cap) leaves them this far under it.
 */
const PUSH_RESUME_GAP = 0.6;
/** Board and rider follow the ground's angle this fast (1/s) on the ground, and level out at this rate in the air. */
const TILT_FOLLOW = 20;
const TILT_LEVEL = 3;
/** How far from the board's centre, sideways, the ground is read for its roll. */
const ROLL_REACH = 0.3;

const OLLIE_SPEED = 4.8;
/** Faster rolling pops higher: each m/s of speed adds this much, up to the cap. */
const OLLIE_SPEED_PER_MS = 0.28;
const OLLIE_SPEED_BONUS_MAX = 5;
const OLLIE_BUFFER_SECONDS = 0.12;
const COYOTE_SECONDS = 0.09;
/** Leaving the ground by less than this (steps down, slope stairs) stays rolling on it. */
const SNAP_DROP = 0.22;
const MAX_LAUNCH_SPEED = 12;

const FLIP_SECONDS = 0.42;
/** A flip that is within this many radians of whole when you land is landed. */
const FLIP_TOLERANCE = 0.95;
const MANUAL_ANGLE = 0.5;
const MANUAL_RATE = 7;
const MANUAL_MIN_SPEED = 1.5;

/** Landing across the direction of travel by more than this (radians, mod a half turn) bails. */
const BAIL_ANGLE = 0.95;
const BAIL_MIN_SPEED = 2.5;
const BAIL_IMPACT_SPEED = 13;
const BONK_MIN_SPEED = 6;
const BONK_KEEP = 0.35;
const BAIL_SECONDS = 1.15;
/** The last stretch of a bail in which the rider gets back up. */
const BAIL_GET_UP_SECONDS = 0.4;

const TAU = Math.PI * 2;

export function wrapPi(angle: number): number {
  return angle - TAU * Math.round(angle / TAU);
}

/** The board as it leaves the rider on a bail: where, how fast, and how it is turning. */
export interface BoardLaunch {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  /** Roll about its long axis at the moment it left, radians. */
  flip: number;
  /** Yaw spin and tumble, rad/s. */
  spin: number;
  tumble: number;
}

/** A bailed board pops up by this, plus a share of the speed it landed with. */
const EJECT_HOP = 2;
const EJECT_SPIN = 3;
const EJECT_TUMBLE = 7;

/** Top of the highest solid voxel at (x, z) at or below `fromY`, searching `depth` down; -Infinity if none. */
export function groundTop(query: SolidQuery, x: number, z: number, fromY: number, depth: number): number {
  const vx = Math.floor(x / VOXEL_SIZE);
  const vz = Math.floor(z / VOXEL_SIZE);
  const top = Math.floor(fromY / VOXEL_SIZE);
  const bottom = Math.floor((fromY - depth) / VOXEL_SIZE);
  for (let vy = top; vy >= bottom; vy--) {
    if (query.isSolid(vx, vy, vz)) return (vy + 1) * VOXEL_SIZE;
  }
  return -Infinity;
}

export class SkateState {
  /** Board heading, radians, in the sim's yaw convention: atan2(z, x). */
  heading = 0;
  /** Roll about the board's long axis during a kickflip, 0..2pi. */
  flip = 0;
  /** Nose-up tilt of a manual, radians. */
  manual = 0;
  /** Rider's fall-over amount, 0 (upright) to 1 (flat out). */
  bailTilt = 0;
  /** 0..1, how far into a run of pushing the rider is. */
  pushRamp = 0;
  /** Which part of a push stroke the leg is in, 0..1. */
  pushPhase = 0;
  /** Seconds left in a bail; > 0 means down. */
  bailTime = 0;
  airborne = false;
  /** The rider is pushing: faces forward and strokes with a leg, instead of standing sideways. */
  pushing = false;
  /**
   * Angle of the ground under the wheels, radians: nose up (+) or down (-)
   * along the board, and rolled about it. The board and rider are drawn tilted
   * by these, as a real board follows the ground it is on.
   */
  pitch = 0;
  roll = 0;
  /** Bumped on every bail, for sound and the like. */
  bails = 0;
  /** Bumped on every ollie and every kickflip started, likewise. */
  ollies = 0;
  flips = 0;
  /** Bumped when a kickflip is landed cleanly (a bailed one does not count). */
  flipsLanded = 0;
  /** Bumped at the start of every push stroke of the leg. */
  pushes = 0;
  /**
   * Set on a bail: the board comes out from under the rider with the speed it
   * had, and is the caller's to take (and clear) and turn into a LooseBoard.
   */
  ejected: BoardLaunch | undefined = undefined;

  private slope = 0;
  private rollSlope = 0;
  /** W is held but the rider is at the top speed pushing gives: riding it out, not pushing. */
  private capped = false;
  /** Velocity handed to the sweep this substep: the board's, before anything stopped the rider. */
  private preVx = 0;
  private preVz = 0;
  private flipT = 0;
  private flipping = false;
  private ollieBuffer = 0;
  private coyote = 0;
  private wasGrounded = false;
  private ollied = false;
  private preSpeed = 0;
  private preVy = 0;
  private readonly snap = createAabbCollision();

  get isDown(): boolean {
    return this.bailTime > 0;
  }

  /** Called when the board comes out: heading starts where you are looking. */
  reset(player: Player): void {
    this.heading = Math.atan2(player.frontZ, player.frontX);
    this.flip = 0;
    this.manual = 0;
    this.bailTilt = 0;
    this.pushRamp = 0;
    this.pushPhase = 0;
    this.bailTime = 0;
    this.airborne = !player.grounded;
    this.slope = 0;
    this.rollSlope = 0;
    this.pitch = 0;
    this.roll = 0;
    this.capped = false;
    this.pushing = false;
    this.flipT = 0;
    this.flipping = false;
    this.ollieBuffer = 0;
    this.coyote = 0;
    this.ejected = undefined;
  }

  /** Sets the velocity the collision sweep will use this substep. */
  beforeSweep(p: Player, input: PlayerInput, dt: number, query: SolidQuery): void {
    this.wasGrounded = p.grounded;
    this.ollied = false;
    this.preSpeed = Math.hypot(p.vx, p.vz);
    this.preVy = p.vy;

    if (input.jumpPressed) this.ollieBuffer = OLLIE_BUFFER_SECONDS;
    else this.ollieBuffer = Math.max(0, this.ollieBuffer - dt);
    this.coyote = p.grounded ? COYOTE_SECONDS : Math.max(0, this.coyote - dt);

    if (this.bailTime > 0) {
      this.updateDown(p, dt);
      return;
    }

    const grounded = p.grounded;
    const speed = this.preSpeed;

    // Heading: steered by the look direction.
    const diff = wrapPi(Math.atan2(p.frontZ, p.frontX) - this.heading);
    const rate = grounded ? TURN_RATE / (1 + speed * TURN_SPEED_DAMPING) : AIR_SPIN_RATE;
    this.heading = wrapPi(this.heading + Math.max(-rate * dt, Math.min(rate * dt, diff)));
    const hx = Math.cos(this.heading);
    const hz = Math.sin(this.heading);

    let along = p.vx * hx + p.vz * hz;
    let across = -p.vx * hz + p.vz * hx;

    if (grounded) {
      // Wheels grip: sideways speed turns mostly into heat, partly into forward speed.
      const lost = across * (1 - Math.exp(-GRIP * dt));
      across -= lost;
      along += (along >= 0 ? 1 : -1) * Math.abs(lost) * CARVE_KEEP;

      // Slopes: gravity along the slope, measured ahead of and behind the board.
      const reach = 0.45;
      const ahead = groundTop(query, p.x + hx * reach, p.z + hz * reach, p.y + 0.6, 1.5);
      const behind = groundTop(query, p.x - hx * reach, p.z - hz * reach, p.y + 0.6, 1.5);
      if (ahead > -Infinity && behind > -Infinity) {
        const measured = Math.max(-1, Math.min(1, (ahead - behind) / (2 * reach)));
        this.slope += (measured - this.slope) * Math.min(1, dt * 15);
      }
      // Over a lip or a drop there is nothing to measure: keep the slope that was
      // under the wheels, which is what the board leaves the ground with.
      along -= (GRAVITY * this.slope * dt) / Math.sqrt(1 + this.slope * this.slope);

      // The same ground read across the board, for the way it is banked.
      const lx = -hz;
      const lz = hx;
      const right = groundTop(query, p.x + lx * ROLL_REACH, p.z + lz * ROLL_REACH, p.y + 0.6, 1.5);
      const left = groundTop(query, p.x - lx * ROLL_REACH, p.z - lz * ROLL_REACH, p.y + 0.6, 1.5);
      if (right > -Infinity && left > -Infinity) {
        const measured = Math.max(-1, Math.min(1, (right - left) / (2 * ROLL_REACH)));
        this.rollSlope += (measured - this.rollSlope) * Math.min(1, dt * 15);
      }
      // Nose up on a rise, and the deck's up leaning the way the ground falls away.
      const follow = Math.min(1, dt * TILT_FOLLOW);
      this.pitch += (Math.atan(this.slope) - this.pitch) * follow;
      this.roll += (-Math.atan(this.rollSlope) - this.roll) * follow;

      // Manual: right mouse held, rolling, balancing on the back wheels.
      const manualWanted = input.skateTrickHeld && speed > MANUAL_MIN_SPEED;
      this.manual += ((manualWanted ? MANUAL_ANGLE : 0) - this.manual) * Math.min(1, dt * MANUAL_RATE);

      // Pushing: a leg stroke, slow to start, quicker and stronger the longer W is held.
      // Holding W keeps the run ramping up even once the rider is at the top
      // speed it allows, so the cap lifts and the pushing starts again.
      const wantsPush = input.moveZ > 0 && this.manual < 0.1;
      if (wantsPush) this.pushRamp = Math.min(1, this.pushRamp + dt / PUSH_RAMP_SECONDS);
      else this.pushRamp = Math.max(0, this.pushRamp - dt * PUSH_RAMP_DECAY);
      const top = PUSH_MAX_SPEED_MIN + (PUSH_MAX_SPEED_MAX - PUSH_MAX_SPEED_MIN) * this.pushRamp;
      this.capped = wantsPush && (this.capped ? along >= top - PUSH_RESUME_GAP : along >= top);
      const wasPushing = this.pushing;
      this.pushing = wantsPush && !this.capped;
      if (this.pushing) {
        const strokeBefore = wasPushing ? this.pushPhase : 1;
        this.pushPhase =
          (this.pushPhase + dt * (PUSH_RATE_MIN + (PUSH_RATE_MAX - PUSH_RATE_MIN) * this.pushRamp)) % 1;
        // The leg kicks as the phase starts over, and on the first stroke of a run.
        if (this.pushPhase < strokeBefore) this.pushes = (this.pushes + 1) & 0xff;
        const stroke = Math.max(0, Math.sin(this.pushPhase * TAU));
        const accel = PUSH_ACCEL_MIN + (PUSH_ACCEL_MAX - PUSH_ACCEL_MIN) * this.pushRamp;
        along += accel * stroke * dt;
      } else {
        this.pushPhase = 0;
      }

      // Drag: a foot on the ground, and rolling resistance.
      let drag = ROLL_DRAG + (this.manual > 0.1 ? MANUAL_DRAG : 0);
      if (input.moveZ < 0) drag += BRAKE;
      // Riding out the top speed holds it: the push that would be needed to keep it is not drawn.
      const slowed = this.capped ? 0 : Math.abs(along) * (1 - Math.exp(-ROLL_DRAG_PROPORTIONAL * dt)) + drag * dt;
      along = Math.sign(along) * Math.max(0, Math.abs(along) - slowed);

      if (this.ollieBuffer > 0) this.ollie(p, along);
    } else {
      this.pushing = false;
      this.capped = false;
      const level = Math.min(1, dt * TILT_LEVEL);
      this.pitch -= this.pitch * level;
      this.roll -= this.roll * level;
      this.manual += (0 - this.manual) * Math.min(1, dt * MANUAL_RATE);
      this.pushRamp = Math.max(0, this.pushRamp - dt * PUSH_RAMP_DECAY);
      this.pushPhase = 0;
      if (this.coyote > 0 && this.ollieBuffer > 0 && p.vy <= 0.5) this.ollie(p, along);
    }

    if (!p.grounded && !this.ollied) this.airborne = true;

    // Kickflip: right mouse in the air, once it has left the ground.
    if (this.airborne && !this.flipping && input.skateTrickPressed && this.flip === 0) {
      this.flipping = true;
      this.flipT = 0;
      this.flips = (this.flips + 1) & 0xff;
    }
    if (this.flipping) {
      this.flipT = Math.min(1, this.flipT + dt / FLIP_SECONDS);
      this.flip = this.flipT * TAU;
    }

    p.vx = hx * along - hz * across;
    p.vz = hz * along + hx * across;
    this.preVx = p.vx;
    this.preVz = p.vz;
  }

  private ollie(p: Player, along: number): void {
    p.vy = OLLIE_SPEED + Math.min(OLLIE_SPEED_BONUS_MAX, Math.abs(along) * OLLIE_SPEED_PER_MS);
    p.grounded = false;
    this.ollieBuffer = 0;
    this.coyote = 0;
    this.ollied = true;
    this.ollies = (this.ollies + 1) & 0xff;
    this.airborne = true;
    this.flip = 0;
    this.flipT = 0;
    this.flipping = false;
  }

  /** Down after a bail: no control, all momentum gone, then back on your feet. */
  private updateDown(p: Player, dt: number): void {
    this.bailTime = Math.max(0, this.bailTime - dt);
    this.pushing = false;
    this.capped = false;
    const level = Math.min(1, dt * 8);
    this.pitch -= this.pitch * level;
    this.roll -= this.roll * level;
    const down = this.bailTime > BAIL_GET_UP_SECONDS;
    this.bailTilt += ((down ? 1 : 0) - this.bailTilt) * Math.min(1, dt * (down ? 9 : 6));
    if (this.bailTime === 0) this.bailTilt = 0;
    p.vx = 0;
    p.vz = 0;
    this.manual = 0;
    this.pushRamp = 0;
    this.pushPhase = 0;
    this.heading = wrapPi(this.heading);
  }

  /** Reads the collision result p already holds; may glue to the ground, launch, land or bail. */
  afterSweep(p: Player, query: SolidQuery, height: number, stepHeight: number): void {
    if (this.bailTime > 0) return;

    const hx = Math.cos(this.heading);
    const hz = Math.sin(this.heading);
    const along = p.vx * hx + p.vz * hz;

    // Rolled off something small: stay on the ground rather than hopping.
    if (this.wasGrounded && !p.grounded && !this.ollied && p.vy <= 0) {
      sweepAabb(query, p.x, p.y, p.z, p.halfWidth, height, 0, -SNAP_DROP, 0, 1, stepHeight, this.snap);
      if (this.snap.grounded) {
        p.y = this.snap.y;
        p.vy = 0;
        p.grounded = true;
      }
    }

    // Left the ground off a ramp: carry the slope's upward speed into the air.
    if (this.wasGrounded && !p.grounded && !this.ollied) {
      const launch = Math.min(MAX_LAUNCH_SPEED, along * this.slope);
      if (launch > p.vy) p.vy = launch;
      this.airborne = true;
    }

    if (this.airborne && p.grounded && p.vy <= 0 && !this.ollied) {
      this.airborne = false;
      const flipped = this.flipping;
      if (this.landingBails(p)) this.bail(p);
      else if (flipped) this.flipsLanded = (this.flipsLanded + 1) & 0xff;
      this.flip = 0;
      this.flipT = 0;
      this.flipping = false;
    }

    // Ran into something at speed.
    if (
      this.bailTime === 0 &&
      this.preSpeed > BONK_MIN_SPEED &&
      Math.hypot(p.vx, p.vz) < this.preSpeed * BONK_KEEP
    ) {
      this.bail(p);
    }
  }

  private landingBails(p: Player): boolean {
    const speed = Math.hypot(p.vx, p.vz);
    if (-this.preVy > BAIL_IMPACT_SPEED) return true;
    // Mid-flip when you land is landing on the deck's edge, or its back.
    if (this.flipping) {
      const turned = wrapPi(this.flip);
      if (Math.abs(turned) > FLIP_TOLERANCE) return true;
    }
    if (speed > BAIL_MIN_SPEED) {
      // Backwards (fakie) is fine; across is not.
      let across = Math.abs(wrapPi(Math.atan2(p.vz, p.vx) - this.heading));
      if (across > Math.PI / 2) across = Math.PI - across;
      if (across > BAIL_ANGLE) return true;
    }
    return false;
  }

  private bail(p: Player): void {
    // The rider stops dead, but the board does not: it shoots out from under
    // them with the velocity it was rolling at (a bonk's included, so it slams
    // into whatever stopped the rider and kicks back off it), spinning and
    // tumbling whichever way it was already turning.
    const turning = this.bails & 1 ? -1 : 1;
    this.ejected = {
      x: p.x,
      y: p.y,
      z: p.z,
      vx: this.preVx,
      vy: EJECT_HOP + Math.max(0, -this.preVy) * 0.3,
      vz: this.preVz,
      heading: this.heading,
      flip: this.flip,
      spin: turning * (EJECT_SPIN + Math.hypot(this.preVx, this.preVz) * 0.25),
      tumble: -turning * EJECT_TUMBLE,
    };
    p.vx = 0;
    p.vz = 0;
    this.bailTime = BAIL_SECONDS;
    this.flip = 0;
    this.flipT = 0;
    this.flipping = false;
    this.manual = 0;
    this.pushRamp = 0;
    this.pushPhase = 0;
    this.bails = (this.bails + 1) & 0xff;
  }
}
