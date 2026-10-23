import type { BuildPiece } from "../items/building.ts";

/**
 * Climbing "on rails". A rail is a straight line in the world that a player
 * can take hold of and slide up or down: a ladder's long axis today, a rope or
 * a pole later. Nothing about it is a ladder: it is a line, a way the climber
 * faces, and how far along it they are.
 *
 * Holding one, the player only goes up and down (W and S); the camera is free,
 * and jumping lets go at any time with the usual air control. The movement
 * itself is `Player.updateClimbing` (it shares the player's collision sweep);
 * this file is the rail and the state the player carries.
 */

/** Climbing speed along the rail, m/s. */
export const CLIMB_SPEED = 2.6;
/** How fast a player is drawn in to the rail on taking hold, m/s at most. */
export const CLIMB_SNAP_SPEED = 7;
/** The push away from the rail on a jump (m/s), and the lift (fraction of a normal jump). */
export const CLIMB_HOP_AWAY = 1.6;
export const CLIMB_HOP_LIFT = 0.85;
/** Reaching the top this close to the end, the climber hops over onto a ledge: forward and up, m/s. */
export const CLIMB_MANTLE_MARGIN = 0.25;
export const CLIMB_MANTLE_PUSH = 2.6;
export const CLIMB_MANTLE_LIFT = 5.2;
/** Seconds after letting go before a rail will take hold again, so a jump clears it. */
export const CLIMB_REGRAB_DELAY = 0.4;
/** The nearest a player's centre may be to the rail's plane and still take hold, metres. */
const GRAB_REACH = 1.2;
/** A rail flatter than this (the y of its direction) is a floor to walk on, not something to climb. */
const MIN_STEEPNESS = 0.5;
/** Beyond the top end by this much and the climber is not offered the rail (the feet are above it). */
const TOP_DEAD_ZONE = 0.5;
/** Facing the rail within this cosine of dead on takes hold. */
const FACING_COSINE = 0.3;
/** Room left between the body and the rungs, metres. */
const BODY_GAP = 0.05;

export class Rail {
  /** The piece it belongs to, so it can be found again as that piece moves. */
  pieceId = 0;
  /** The bottom end of the line. */
  px = 0;
  py = 0;
  pz = 0;
  /** Unit direction up the line. */
  dx = 0;
  dy = 1;
  dz = 0;
  length = 0;
  /** Unit normal of the side the climber is on, pointing out toward them. */
  nx = 0;
  ny = 0;
  nz = 1;
  /** Half the thickness of the rail, and half the width a climber may be off-centre by. */
  halfThickness = 0.04;
  halfSpan = 0.3;

  /** The horizontal part of the facing normal, unit (or zero for a rail facing straight up). */
  horizontalNormal(out: { x: number; z: number }): { x: number; z: number } {
    const length = Math.hypot(this.nx, this.nz);
    out.x = length > 1e-6 ? this.nx / length : 0;
    out.z = length > 1e-6 ? this.nz / length : 0;
    return out;
  }

  /** How far from the line's plane a player's centre stands while climbing, for a body `halfWidth` wide. */
  standoff(halfWidth: number): number {
    const length = Math.hypot(this.nx, this.nz);
    const spread = length > 1e-6 ? (Math.abs(this.nx) + Math.abs(this.nz)) / length : 1;
    return this.halfThickness + halfWidth * spread + BODY_GAP;
  }

  /**
   * How well a player standing at feet (x, y, z), looking along (frontX,
   * frontZ), could take hold: smaller is better, or -1 if not at all. They have
   * to be in front of it, within reach of its width and length, and facing it.
   */
  grabScore(x: number, y: number, z: number, frontX: number, frontZ: number): number {
    const rx = x - this.px;
    const ry = y - this.py;
    const rz = z - this.pz;
    const along = rx * this.dx + ry * this.dy + rz * this.dz;
    if (along < -0.5 || along > this.length - TOP_DEAD_ZONE) return -1;
    const perpX = rx - this.dx * along;
    const perpY = ry - this.dy * along;
    const perpZ = rz - this.dz * along;
    const front = perpX * this.nx + perpY * this.ny + perpZ * this.nz;
    if (front < -0.15 || front > GRAB_REACH) return -1;
    const side = Math.hypot(perpX - this.nx * front, perpY - this.ny * front, perpZ - this.nz * front);
    if (side > this.halfSpan + 0.15) return -1;
    const flat = Math.hypot(frontX, frontZ);
    const wall = Math.hypot(this.nx, this.nz);
    if (flat < 1e-6) return -1;
    const facing = wall < 1e-6 ? 1 : -(frontX * this.nx + frontZ * this.nz) / (flat * wall);
    if (facing < FACING_COSINE) return -1;
    return Math.abs(front) + side;
  }
}

export function createRail(): Rail {
  return new Rail();
}

/** Where rails can be found: the building pieces, in the game. */
export interface RailSource {
  /** The best rail a player at feet (x, y, z) facing (frontX, frontZ) could take hold of, into `out`. */
  findRail(x: number, y: number, z: number, frontX: number, frontZ: number, out: Rail): boolean;
  /** The rail of piece `pieceId` as it stands now, into `out`; false if the piece is gone or no longer climbable. */
  railOf(pieceId: number, out: Rail): boolean;
}

/** A climbable piece as a rail: its `along` axis, the side opposite its contact face facing out. False if too flat to climb. */
export function railOfPiece(piece: BuildPiece, out: Rail): boolean {
  const spec = piece.spec;
  if (!spec.climbable) return false;
  const a = piece.solid.axes;
  const along = spec.along * 3;
  let dx = a[along] ?? 0;
  let dy = a[along + 1] ?? 0;
  let dz = a[along + 2] ?? 0;
  if (dy < 0) {
    dx = -dx;
    dy = -dy;
    dz = -dz;
  }
  if (dy < MIN_STEEPNESS) return false;
  const length = spec.size[spec.along];
  out.pieceId = piece.id;
  out.dx = dx;
  out.dy = dy;
  out.dz = dz;
  out.length = length;
  out.px = piece.x - dx * (length / 2);
  out.py = piece.y - dy * (length / 2);
  out.pz = piece.z - dz * (length / 2);
  // The side facing out is opposite the face it is put against.
  const contact = spec.contactAxis * 3;
  const sign = -spec.contactSign;
  out.nx = (a[contact] ?? 0) * sign;
  out.ny = (a[contact + 1] ?? 0) * sign;
  out.nz = (a[contact + 2] ?? 0) * sign;
  out.halfThickness = spec.size[spec.contactAxis] / 2;
  // The remaining axis is its width.
  const across = (3 - spec.along - spec.contactAxis) as 0 | 1 | 2;
  out.halfSpan = spec.size[across] / 2;
  return true;
}

/** What the player carries about climbing. */
export class ClimbState {
  /** Holding a rail. */
  active = false;
  /** The rail held, kept up to date each step from its piece. */
  readonly rail = createRail();
  /** Where the feet are along it, metres from the bottom. */
  t = 0;
  /** Signed speed along it this step (m/s): what the climbing animation keys off. */
  speed = 0;
  /** Distance climbed in total, metres: the animation's phase. */
  travelled = 0;
  /** Seconds until a rail will take hold again. */
  cooldown = 0;

  grab(rail: Rail, t: number): void {
    this.active = true;
    this.rail.pieceId = rail.pieceId;
    this.t = t;
    this.speed = 0;
  }

  release(): void {
    this.active = false;
    this.speed = 0;
  }
}
