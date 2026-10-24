import {
  aabbOverlapsSolid,
  createAabbCollision,
  createSphereCollision,
  sweepAabb,
  sweepSphere,
  type SolidQuery,
} from "./collision.ts";
import {
  CLIMB_HOP_AWAY,
  CLIMB_HOP_LIFT,
  CLIMB_MANTLE_LIFT,
  CLIMB_MANTLE_MARGIN,
  CLIMB_MANTLE_PUSH,
  CLIMB_REGRAB_DELAY,
  CLIMB_SNAP_SPEED,
  CLIMB_SPEED,
  ClimbState,
  type RailSource,
} from "./climb.ts";
import { VOXEL_SIZE } from "./constants.ts";
import { CHUTE_ACCEL, Glide } from "../items/parachute.ts";
import { SkateState } from "./skate.ts";

/**
 * Player physics and look state. A verbatim port of src/Player.{hpp,cpp}.
 *
 * Position is tracked as the collider's bottom (feet) in both modes, so
 * toggling Ragball does not shift the point touching the ground. Walking
 * uses an AABB, Ragball a sphere; nothing outside this class needs to know
 * which.
 *
 * Quaternions are four loose numbers rather than a library type because
 * @fgp/shared cannot depend on three.js -- the server runs this file. The
 * client reads `orientation*` straight into a THREE.Quaternion each frame.
 */

export const PlayerMode = {
  Walking: 0,
  Ragball: 1,
} as const;
export type PlayerMode = (typeof PlayerMode)[keyof typeof PlayerMode];

/**
 * Per-frame movement intent, gathered from input before update() runs so
 * movement logic stays independent of the input layer.
 */
export interface PlayerInput {
  /** Strafe right (+). */
  moveX: number;
  /** Forward (+). */
  moveZ: number;
  jumpPressed: boolean;
  /** Skateboard trick button went down this frame (latched like jumpPressed). */
  skateTrickPressed: boolean;
  /** Skateboard trick button is held: a manual on the ground. */
  skateTrickHeld: boolean;
}

export function createPlayerInput(): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    jumpPressed: false,
    skateTrickPressed: false,
    skateTrickHeld: false,
  };
}

export const GRAVITY = -18;
const GROUND_ACCEL = 30;
const AIR_ACCEL = 8;
/** A hair over 5 voxels. */
const STEP_HEIGHT = 0.51;
/**
 * Rolling friction: horizontal ragball speed decays at this rate (1/s) while
 * grounded, so the ball coasts down slopes but settles on flat ground
 * instead of sliding forever. Walking has no equivalent -- ground
 * acceleration doubles as its stopping force.
 */
const RAGBALL_GROUND_FRICTION = 2;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Half the walking collider's width. Sized to the player model's body,
 * which is a wide round mass rather than a narrow capsule -- the 0.3 the
 * native build used was built around a placeholder sphere and left the
 * model clipping into terrain at its sides.
 */
export const WALK_HALF_WIDTH = 0.55;
/** 190cm player. */
export const WALK_HEIGHT = 1.9;
/** Eyes sit just below the top of the head. */
export const WALK_EYE_HEIGHT = 1.78;
export const RAGBALL_RADIUS = 0.6;
/** Kilograms: a big lad. What shoves from outside (a rope letting go) are divided by. */
export const PLAYER_MASS = 100;
/**
 * A shove from outside wears off at this rate (1/s) while walking: quickly on
 * the ground, where feet grip, hardly at all in the air. It is also the most a
 * walker can lean on a push: their steering holds back `walkSpeed * decay`
 * times their mass in newtons.
 */
const KNOCK_GROUND_DECAY = 4;
const KNOCK_AIR_DECAY = 0.4;

/**
 * Below the loaded vertical chunk band there is no terrain to catch a fall,
 * so anything that drops out the bottom respawns. A stopgap for testing
 * movement, not a designed mechanic -- expect it to be replaced (fall
 * damage, a void biome, whatever) once that is actually decided.
 */
export const KILL_PLANE_Y = -5;

export class Player {
  /** Feet position. */
  x: number;
  y: number;
  z: number;

  vx = 0;
  vy = 0;
  vz = 0;
  /**
   * The part of the walking velocity that came from outside (see
   * {@link applyImpulse}), which steering does not fight and which wears off
   * by itself.
   */
  private knockX = 0;
  private knockZ = 0;

  mode: PlayerMode = PlayerMode.Walking;
  grounded = false;
  /** Bumped every time the player falls out of the world and is put back at the start, for sound. */
  respawns = 0;

  /** Standing on a skateboard (set each frame by whoever owns the inventory); Walking only. */
  skating = false;
  readonly skate = new SkateState();
  private wasSkating = false;
  /** Wearing a parachute (set each frame by whoever owns the inventory); Walking only. See items/parachute.ts. */
  gliding = false;
  readonly glide = new Glide();
  /** Holding a rail (a ladder): see sim/climb.ts. */
  readonly climb = new ClimbState();
  /** Where rails are found; unset, nothing can be climbed. */
  rails: RailSource | undefined = undefined;
  private readonly railNormal = { x: 0, z: 0 };

  /** Body orientation as a quaternion. Read by the renderer at M11. */
  orientationX = 0;
  orientationY = 0;
  orientationZ = 0;
  orientationW = 1;

  /** Matches Player::mouseSensitivity. Degrees per pixel. */
  /**
   * Collider dimensions, as fields rather than constants so the golden
   * trace can hold the reference build's values while the game uses ones
   * that fit the actual model.
   */
  halfWidth = WALK_HALF_WIDTH;
  ballRadius = RAGBALL_RADIUS;

  mouseSensitivity = 0.1;
  walkSpeed = 4.5;
  jumpSpeed = 6.3;
  /**
   * Ragball is momentum-based (see DESIGN.md): input should only nudge and
   * steer, not directly drive speed the way Walking does. Real speed is
   * meant to come from rolling downhill under gravity, so the acceleration
   * is deliberately weak and the max speed is a safety ceiling against
   * runaway velocity on steep terrain, not a normal-play cap.
   */
  ragballAccel = 3;
  ragballMaxSpeed = 20;

  frontX = 0;
  frontY = 0;
  frontZ = -1;
  rightX = 1;
  rightY = 0;
  rightZ = 0;

  private yawDeg = -90;
  private pitchDeg = 0;

  // Reused across substeps -- update() runs up to 8 times per frame.
  private readonly aabbResult = createAabbCollision();
  private readonly sphereResult = createSphereCollision();

  constructor(feetX: number, feetY: number, feetZ: number) {
    this.x = feetX;
    this.y = feetY;
    this.z = feetZ;
    this.updateVectors();
  }

  get eyeHeight(): number {
    if (this.mode !== PlayerMode.Walking) return this.ballRadius * 1.3;
    // Fallen off the board, the eye is down near the ground.
    return WALK_EYE_HEIGHT - this.skate.bailTilt * (WALK_EYE_HEIGHT - 0.5);
  }

  /** How far a fallen skater has tipped over, 0..1. */
  get skateTilt(): number {
    return this.skate.bailTilt;
  }

  /** Holding a ladder or other rail. */
  get climbing(): boolean {
    return this.climb.active;
  }

  get bodyRadius(): number {
    return this.mode === PlayerMode.Walking ? this.halfWidth : this.ballRadius;
  }

  get yaw(): number {
    return this.yawDeg;
  }

  get pitch(): number {
    return this.pitchDeg;
  }

  look(xOffset: number, yOffset: number): void {
    this.yawDeg += xOffset * this.mouseSensitivity;
    this.pitchDeg += yOffset * this.mouseSensitivity;
    this.pitchDeg = Math.min(89, Math.max(-89, this.pitchDeg));
    this.updateVectors();
  }

  /** Faces a saved direction (degrees), as `look` would have got there. */
  setLook(yawDegrees: number, pitchDegrees: number): void {
    this.yawDeg = yawDegrees;
    this.pitchDeg = Math.min(89, Math.max(-89, pitchDegrees));
    this.updateVectors();
  }

  private updateVectors(): void {
    const yaw = this.yawDeg * DEG_TO_RAD;
    const pitch = this.pitchDeg * DEG_TO_RAD;
    const cosPitch = Math.cos(pitch);

    this.frontX = Math.cos(yaw) * cosPitch;
    this.frontY = Math.sin(pitch);
    this.frontZ = Math.sin(yaw) * cosPitch;

    // right = normalize(cross(front, worldUp)) with worldUp = +Y. The cross
    // product reduces to (-front.z, 0, front.x), whose length is cosPitch --
    // so normalising is a divide by cosPitch, and the result is the flat
    // heading's right vector regardless of pitch.
    const flatLen = Math.hypot(this.frontZ, this.frontX);
    if (flatLen > 1e-6) {
      this.rightX = -this.frontZ / flatLen;
      this.rightY = 0;
      this.rightZ = this.frontX / flatLen;
    }
  }

  /**
   * A discrete, once-per-press action -- deliberately not part of
   * PlayerInput/update(). update() runs once per fixed physics substep
   * (usually several per rendered frame), so a level-triggered "toggle"
   * field there would flip the mode back and forth within a single frame
   * and appear to do nothing.
   *
   * Needs the world because Walking's box is taller than Ragball's sphere
   * at the same feet position: switching back under low clearance (a tunnel
   * scooped just wide enough for the ball) would otherwise embed the box in
   * solid terrain, which sweep-based collision has no way to recover from
   * -- it only ever prevents new penetration, not existing penetration --
   * and reads as movement being blocked on every axis.
   */
  toggleMode(query: SolidQuery): void {
    const newMode = this.mode === PlayerMode.Walking ? PlayerMode.Ragball : PlayerMode.Walking;

    if (newMode === PlayerMode.Walking) {
      const UNSTUCK_STEP = 0.05;
      const MAX_UNSTUCK_LIFT = 2.5;
      for (let lift = 0; lift <= MAX_UNSTUCK_LIFT; lift += UNSTUCK_STEP) {
        const candidateY = this.y + lift;
        if (
          !aabbOverlapsSolid(
            query,
            this.x - this.halfWidth,
            candidateY,
            this.z - this.halfWidth,
            this.x + this.halfWidth,
            candidateY + WALK_HEIGHT,
            this.z + this.halfWidth,
          )
        ) {
          this.y = candidateY;
          break;
        }
      }
    }

    this.mode = newMode;
  }

  /**
   * An impulse (N*s) from outside the player: a stretched rope letting go, a
   * blast. Walking steers toward its wish velocity at a fixed rate, which
   * would undo a shove in a few steps, so the shove is kept apart from what
   * steering is working on and wears off on its own instead.
   */
  applyImpulse(ix: number, iy: number, iz: number): void {
    const dvx = ix / PLAYER_MASS;
    const dvz = iz / PLAYER_MASS;
    this.vx += dvx;
    this.vy += iy / PLAYER_MASS;
    this.vz += dvz;
    if (this.mode === PlayerMode.Walking && !this.skating) {
      this.knockX += dvx;
      this.knockZ += dvz;
    }
  }

  /** One fixed physics substep. */
  update(input: PlayerInput, dt: number, query: SolidQuery, surfaceHeightVoxels: () => number): void {
    const skating = this.skating && this.mode === PlayerMode.Walking;
    if (skating && !this.wasSkating) this.skate.reset(this);
    this.wasSkating = skating;
    if (skating || this.mode !== PlayerMode.Walking) {
      this.knockX = 0;
      this.knockZ = 0;
    }

    // A rail is held by a walker only; tucking into a ball or mounting a board lets go.
    if (skating || this.mode !== PlayerMode.Walking) this.climb.release();
    if (skating || this.mode !== PlayerMode.Walking || this.climb.active) this.glide.reset();
    if (this.climb.cooldown > 0) this.climb.cooldown -= dt;
    if (this.climb.active && !this.refreshRail()) this.letGo(0);
    if (
      !this.climb.active &&
      !skating &&
      this.mode === PlayerMode.Walking &&
      this.climb.cooldown <= 0 &&
      input.moveZ > 0
    ) {
      this.tryGrab();
    }

    if (this.climb.active) {
      this.updateClimbing(input, dt, query);
    } else if (skating) {
      this.updateSkating(input, dt, query);
      this.updateFacingOrientation();
    } else if (this.mode === PlayerMode.Walking) {
      this.skate.bailTilt = 0;
      this.updateWalking(input, dt, query);
      this.updateFacingOrientation();
    } else {
      this.updateRagball(input, dt, query);
      this.updateBodyOrientation(dt);
    }

    if (this.y < KILL_PLANE_Y) {
      this.x = 0;
      this.y = surfaceHeightVoxels() * VOXEL_SIZE + 1;
      this.z = 0;
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
      this.mode = PlayerMode.Walking;
      this.grounded = false;
      this.skate.reset(this);
      this.climb.release();
      this.respawns = (this.respawns + 1) & 0xff;
    }
  }

  /** The held rail as it stands now (its piece may have moved); false if it is gone. */
  private refreshRail(): boolean {
    return this.rails !== undefined && this.rails.railOf(this.climb.rail.pieceId, this.climb.rail);
  }

  /** Takes hold of the best rail in reach, if the player is at one and facing it. */
  private tryGrab(): void {
    const rails = this.rails;
    if (rails === undefined) return;
    const rail = this.climb.rail;
    if (!rails.findRail(this.x, this.y, this.z, this.frontX, this.frontZ, rail)) return;
    const along = (this.x - rail.px) * rail.dx + (this.y - rail.py) * rail.dy + (this.z - rail.pz) * rail.dz;
    this.climb.grab(rail, Math.min(Math.max(along, 0), rail.length));
    this.knockX = 0;
    this.knockZ = 0;
  }

  /** Lets go of the rail; it will not take hold again for `delay` seconds. */
  private letGo(delay: number): void {
    this.climb.release();
    this.climb.cooldown = delay;
  }

  /**
   * One step of hanging on a rail: up and down it at climbing speed, nothing
   * else. The body is drawn in to the line and stays a body's width off it, and
   * goes through the same sweep as walking, so a wall or a ledge still stops it.
   * Jumping lets go with a hop, and the ends of the rail let go too: the
   * bottom onto the ground, the top over onto whatever ledge is there.
   */
  private updateClimbing(input: PlayerInput, dt: number, query: SolidQuery): void {
    const climb = this.climb;
    const rail = climb.rail;
    const wall = rail.horizontalNormal(this.railNormal);

    if (input.jumpPressed) {
      this.letGo(CLIMB_REGRAB_DELAY);
      this.vx = wall.x * CLIMB_HOP_AWAY;
      this.vz = wall.z * CLIMB_HOP_AWAY;
      this.vy = this.jumpSpeed * CLIMB_HOP_LIFT;
      this.grounded = false;
      this.updateWalking(input, dt, query);
      this.updateFacingOrientation();
      return;
    }

    climb.speed = input.moveZ * CLIMB_SPEED;
    climb.t += climb.speed * dt;
    if (climb.t <= 0 && climb.speed < 0) {
      // Down the bottom and onto the ground.
      this.letGo(CLIMB_REGRAB_DELAY);
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
      this.updateWalking(input, dt, query);
      this.updateFacingOrientation();
      return;
    }
    if (climb.t >= rail.length - CLIMB_MANTLE_MARGIN && climb.speed > 0) {
      // Up the top and over: forward, toward the rail's wall, and up.
      this.letGo(CLIMB_REGRAB_DELAY);
      this.vx = -wall.x * CLIMB_MANTLE_PUSH;
      this.vz = -wall.z * CLIMB_MANTLE_PUSH;
      this.vy = CLIMB_MANTLE_LIFT;
      this.grounded = false;
      this.updateWalking(input, dt, query);
      this.updateFacingOrientation();
      return;
    }
    climb.t = Math.min(Math.max(climb.t, 0), rail.length);

    const stand = rail.standoff(this.halfWidth);
    const wantX = rail.px + rail.dx * climb.t + wall.x * stand;
    const wantY = rail.py + rail.dy * climb.t;
    const wantZ = rail.pz + rail.dz * climb.t + wall.z * stand;
    let vx = (wantX - this.x) / dt;
    let vy = (wantY - this.y) / dt;
    let vz = (wantZ - this.z) / dt;
    const speed = Math.hypot(vx, vy, vz);
    const limit = Math.max(CLIMB_SNAP_SPEED, Math.abs(climb.speed) * 1.5);
    if (speed > limit) {
      vx *= limit / speed;
      vy *= limit / speed;
      vz *= limit / speed;
    }
    const result = sweepAabb(
      query,
      this.x,
      this.y,
      this.z,
      this.halfWidth,
      WALK_HEIGHT,
      vx,
      vy,
      vz,
      dt,
      STEP_HEIGHT,
      this.aabbResult,
    );
    this.x = result.x;
    this.y = result.y;
    this.z = result.z;
    this.vx = result.vx;
    this.vy = result.vy;
    this.vz = result.vz;
    this.grounded = false;

    // Where the feet really are along the rail, so a ledge in the way holds the climb back too.
    const along =
      (this.x - rail.px) * rail.dx +
      (this.y - rail.py) * rail.dy +
      (this.z - rail.pz) * rail.dz -
      stand * (wall.x * rail.dx + wall.z * rail.dz);
    climb.t = Math.min(Math.max(along, 0), rail.length);
    climb.travelled += Math.abs(climb.speed) * dt;
    this.updateFacingOrientation(-wall.x, -wall.z);
  }

  /**
   * Ground-plane movement direction from input, relative to look direction
   * (front/right flattened to XZ). Shared by Walking and Ragball since both
   * steer the same way; they just apply the result differently (direct
   * velocity vs. accelerate-toward). Written into wishX/wishZ to avoid
   * allocating a vector per substep.
   */
  private wishX = 0;
  private wishZ = 0;

  private computeWishDirection(input: PlayerInput): number {
    const flatLen = Math.hypot(this.frontX, this.frontZ);
    const flatFrontX = flatLen > 1e-6 ? this.frontX / flatLen : 0;
    const flatFrontZ = flatLen > 1e-6 ? this.frontZ / flatLen : 0;

    this.wishX = flatFrontX * input.moveZ + this.rightX * input.moveX;
    this.wishZ = flatFrontZ * input.moveZ + this.rightZ * input.moveX;
    return Math.hypot(this.wishX, this.wishZ);
  }

  private updateWalking(input: PlayerInput, dt: number, query: SolidQuery): void {
    const wishLen = this.computeWishDirection(input);
    // Under an open canopy the heading steers, not the keys; see items/parachute.ts.
    const chute = this.glide.update(this, input, dt, this.gliding);
    const wishVelX = chute ? this.glide.wishX : wishLen > 1e-5 ? (this.wishX / wishLen) * this.walkSpeed : 0;
    const wishVelZ = chute ? this.glide.wishZ : wishLen > 1e-5 ? (this.wishZ / wishLen) * this.walkSpeed : 0;

    // Steering works on the player's own velocity, not on a shove they were given.
    const deltaX = wishVelX - (this.vx - this.knockX);
    const deltaZ = wishVelZ - (this.vz - this.knockZ);
    const deltaLen = Math.hypot(deltaX, deltaZ);
    const maxChange = (chute ? CHUTE_ACCEL : this.grounded ? GROUND_ACCEL : AIR_ACCEL) * dt;
    if (deltaLen <= maxChange || deltaLen < 1e-5) {
      this.vx += deltaX;
      this.vz += deltaZ;
    } else {
      this.vx += (deltaX / deltaLen) * maxChange;
      this.vz += (deltaZ / deltaLen) * maxChange;
    }
    if (this.knockX !== 0 || this.knockZ !== 0) this.wearOffKnock(dt);

    this.vy += GRAVITY * dt;
    if (chute) this.vy = this.glide.sink(this.vy);
    if (input.jumpPressed && this.grounded) {
      this.vy = this.jumpSpeed;
    }

    const sweptX = this.vx;
    const sweptZ = this.vz;
    const result = sweepAabb(
      query,
      this.x,
      this.y,
      this.z,
      this.halfWidth,
      WALK_HEIGHT,
      this.vx,
      this.vy,
      this.vz,
      dt,
      STEP_HEIGHT,
      this.aabbResult,
    );
    this.x = result.x;
    this.y = result.y;
    this.z = result.z;
    this.vx = result.vx;
    this.vy = result.vy;
    this.vz = result.vz;
    this.grounded = result.grounded;
    // A wall takes the shove with the rest of the speed it stops.
    if (sweptX !== this.vx) this.knockX = sweptX === 0 ? 0 : this.knockX * (this.vx / sweptX);
    if (sweptZ !== this.vz) this.knockZ = sweptZ === 0 ? 0 : this.knockZ * (this.vz / sweptZ);
  }

  /** Lets a shove from outside fade: the ground grips it, the air barely does. */
  private wearOffKnock(dt: number): void {
    const gone = 1 - Math.exp(-(this.grounded ? KNOCK_GROUND_DECAY : KNOCK_AIR_DECAY) * dt);
    let lostX = this.knockX * gone;
    let lostZ = this.knockZ * gone;
    if (Math.hypot(this.knockX, this.knockZ) < 0.02) {
      lostX = this.knockX;
      lostZ = this.knockZ;
    }
    this.vx -= lostX;
    this.vz -= lostZ;
    this.knockX -= lostX;
    this.knockZ -= lostZ;
  }

  private updateSkating(input: PlayerInput, dt: number, query: SolidQuery): void {
    this.vy += GRAVITY * dt;
    this.skate.beforeSweep(this, input, dt, query);

    const result = sweepAabb(
      query,
      this.x,
      this.y,
      this.z,
      this.halfWidth,
      WALK_HEIGHT,
      this.vx,
      this.vy,
      this.vz,
      dt,
      STEP_HEIGHT,
      this.aabbResult,
    );
    this.x = result.x;
    this.y = result.y;
    this.z = result.z;
    this.vx = result.vx;
    this.vy = result.vy;
    this.vz = result.vz;
    this.grounded = result.grounded;

    this.skate.afterSweep(this, query, WALK_HEIGHT, STEP_HEIGHT);
  }

  private updateRagball(input: PlayerInput, dt: number, query: SolidQuery): void {
    const wishLen = this.computeWishDirection(input);
    if (wishLen > 1e-5) {
      this.vx += (this.wishX / wishLen) * this.ragballAccel * dt;
      this.vz += (this.wishZ / wishLen) * this.ragballAccel * dt;
    }

    if (this.grounded) {
      const decay = Math.exp(-RAGBALL_GROUND_FRICTION * dt);
      this.vx *= decay;
      this.vz *= decay;
    }

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > this.ragballMaxSpeed) {
      this.vx = (this.vx / speed) * this.ragballMaxSpeed;
      this.vz = (this.vz / speed) * this.ragballMaxSpeed;
    }

    this.vy += GRAVITY * dt;

    const result = sweepSphere(
      query,
      this.x,
      this.y + this.ballRadius,
      this.z,
      this.ballRadius,
      this.vx,
      this.vy,
      this.vz,
      dt,
      this.sphereResult,
    );
    this.x = result.x;
    this.y = result.y - this.ballRadius;
    this.z = result.z;
    this.vx = result.vx;
    this.vy = result.vy;
    this.vz = result.vz;
    this.grounded = result.grounded;
  }

  /**
   * Rolling without slipping: the ball rotates about the axis perpendicular
   * to both "up" and its direction of travel, by an angle equal to arc
   * length (speed * dt) over radius.
   */
  private updateBodyOrientation(dt: number): void {
    const speed = Math.hypot(this.vx, this.vz);
    if (speed < 1e-4) return;

    // cross(+Y, horizVel) = (vz, 0, -vx), whose length is `speed`, so
    // normalising is a divide by speed.
    const axisX = this.vz / speed;
    const axisZ = -this.vx / speed;

    const angle = (speed * dt) / this.bodyRadius;
    const half = angle * 0.5;
    const s = Math.sin(half);
    const qx = axisX * s;
    const qy = 0;
    const qz = axisZ * s;
    const qw = Math.cos(half);

    // orientation = q * orientation (Hamilton product), matching glm.
    const { orientationX: ox, orientationY: oy, orientationZ: oz, orientationW: ow } = this;
    this.orientationW = qw * ow - qx * ox - qy * oy - qz * oz;
    this.orientationX = qw * ox + qx * ow + qy * oz - qz * oy;
    this.orientationY = qw * oy - qx * oz + qy * ow + qz * ox;
    this.orientationZ = qw * oz + qx * oy - qy * ox + qz * ow;
  }

  /**
   * No walk animation yet (that is M11), so all Walking does is yaw the
   * whole body to keep facing the camera's look direction -- not pitch, the
   * body should not tip forward or back when looking up and down.
   *
   * MODEL_FACE_LOCAL_X/Z is the mesh's own chest-forward axis in the local
   * space the loader leaves it in. Carried over from the C++ as local +X,
   * where it is flagged as a guess pending visual confirmation. If the body
   * ends up facing sideways or backwards at M11, this is the constant to
   * flip.
   */
  /** Turns the body to face along (faceX, faceZ): where it is looking, unless told otherwise (a climber faces the rungs). */
  private updateFacingOrientation(faceX = this.frontX, faceZ = this.frontZ): void {
    const MODEL_FACE_LOCAL_X = 1;
    const MODEL_FACE_LOCAL_Z = 0;

    const flatLen = Math.hypot(faceX, faceZ);
    if (flatLen < 1e-6) return;

    // Both vectors are flattened to the XZ plane, so aligning their
    // atan2(x, z) angles is a pure yaw rotation.
    const faceAngle = Math.atan2(MODEL_FACE_LOCAL_X, MODEL_FACE_LOCAL_Z);
    const targetAngle = Math.atan2(faceX / flatLen, faceZ / flatLen);
    const half = (targetAngle - faceAngle) * 0.5;
    this.orientationX = 0;
    this.orientationY = Math.sin(half);
    this.orientationZ = 0;
    this.orientationW = Math.cos(half);
  }
}
