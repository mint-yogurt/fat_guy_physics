import { Quaternion, Vector3 } from "three/webgpu";

import type { RopeBody, RopeVec } from "@fgp/shared/items/rope";

import { pieceMass, type BuildField, type BuildPiece } from "@fgp/shared/items/building";

import type { BuildSystem } from "./buildSystem.ts";
import type { Piece } from "./logSystem.ts";
import type { PhysicsWorld } from "./physicsWorld.ts";

/** Same density as the body the piece is made into; see PhysicsWorld.spawnCapsule. */
const WOOD_DENSITY = 600;

const transform = new Float32Array(7);
const velocity = new Float32Array(6);
const rotation = new Quaternion();

/**
 * A rope end tied to a felled tree piece, at the spot on it that was aimed
 * at. The spot is remembered in the piece's own frame, so it goes where the
 * piece goes as it rolls, and the rope's pull is applied there, so it turns it.
 */
export class PieceRopeBody implements RopeBody {
  readonly mass: number;
  private readonly local = new Vector3();
  /** The tie point's offset from the centre in the world frame, as of the last `tiePoint`. */
  private readonly offset = new Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly piece: Piece,
    hitX: number,
    hitY: number,
    hitZ: number,
  ) {
    const { radius, halfHeight } = piece.body;
    this.mass = Math.PI * radius * radius * (halfHeight * 2 + radius * 2) * WOOD_DENSITY;
    if (physics.readTransform(piece.handle, transform)) {
      rotation.set(transform[3] ?? 0, transform[4] ?? 0, transform[5] ?? 0, transform[6] ?? 1).invert();
      this.local
        .set(hitX - (transform[0] ?? 0), hitY - (transform[1] ?? 0), hitZ - (transform[2] ?? 0))
        .applyQuaternion(rotation);
    }
  }

  tiePoint(out: RopeVec): boolean {
    if (!this.physics.readTransform(this.piece.handle, transform)) return false;
    rotation.set(transform[3] ?? 0, transform[4] ?? 0, transform[5] ?? 0, transform[6] ?? 1);
    this.offset.copy(this.local).applyQuaternion(rotation);
    out.x = (transform[0] ?? 0) + this.offset.x;
    out.y = (transform[1] ?? 0) + this.offset.y;
    out.z = (transform[2] ?? 0) + this.offset.z;
    return true;
  }

  tieVelocity(out: RopeVec): void {
    if (!this.physics.readVelocity(this.piece.handle, velocity)) {
      out.x = out.y = out.z = 0;
      return;
    }
    // Linear plus spin about the centre, at the tie point (the offset is current from tiePoint()).
    const wx = velocity[3] ?? 0;
    const wy = velocity[4] ?? 0;
    const wz = velocity[5] ?? 0;
    out.x = (velocity[0] ?? 0) + (wy * this.offset.z - wz * this.offset.y);
    out.y = (velocity[1] ?? 0) + (wz * this.offset.x - wx * this.offset.z);
    out.z = (velocity[2] ?? 0) + (wx * this.offset.y - wy * this.offset.x);
  }

  push(ix: number, iy: number, iz: number): void {
    if (!this.physics.readTransform(this.piece.handle, transform)) return;
    this.physics.addImpulseAt(
      this.piece.handle,
      ix,
      iy,
      iz,
      (transform[0] ?? 0) + this.offset.x,
      (transform[1] ?? 0) + this.offset.y,
      (transform[2] ?? 0) + this.offset.z,
    );
  }
}

/** Mass of a piece held fast (a ladder on a wall): it does not move, so the rope sees something immovable. */
const FIXED_PIECE_MASS = 5000;

/**
 * A rope end tied to a placed building piece, at the spot aimed at. Like
 * {@link PieceRopeBody} the spot is kept in the piece's own frame, so it goes
 * where the piece goes; a loose piece is pulled (and turned) by the rope, a
 * fixed one is not moved. The tie is lost when the piece is picked up.
 */
export class BuildPieceRopeBody implements RopeBody {
  private readonly local = new Vector3();
  private readonly offset = new Vector3();
  private readonly speed = new Float32Array(6);

  constructor(
    private readonly system: BuildSystem,
    private readonly field: BuildField,
    private readonly piece: BuildPiece,
    hitX: number,
    hitY: number,
    hitZ: number,
  ) {
    rotation.set(piece.qx, piece.qy, piece.qz, piece.qw).invert();
    this.local.set(hitX - piece.x, hitY - piece.y, hitZ - piece.z).applyQuaternion(rotation);
  }

  get mass(): number {
    return this.piece.fixed ? FIXED_PIECE_MASS : pieceMass(this.piece.spec);
  }

  tiePoint(out: RopeVec): boolean {
    const piece = this.piece;
    if (!this.field.pieces.includes(piece)) return false;
    rotation.set(piece.qx, piece.qy, piece.qz, piece.qw);
    this.offset.copy(this.local).applyQuaternion(rotation);
    out.x = piece.x + this.offset.x;
    out.y = piece.y + this.offset.y;
    out.z = piece.z + this.offset.z;
    return true;
  }

  tieVelocity(out: RopeVec): void {
    if (!this.system.pieceVelocity(this.piece, this.speed)) {
      out.x = out.y = out.z = 0;
      return;
    }
    const v = this.speed;
    const wx = v[3] ?? 0;
    const wy = v[4] ?? 0;
    const wz = v[5] ?? 0;
    out.x = (v[0] ?? 0) + (wy * this.offset.z - wz * this.offset.y);
    out.y = (v[1] ?? 0) + (wz * this.offset.x - wx * this.offset.z);
    out.z = (v[2] ?? 0) + (wx * this.offset.y - wy * this.offset.x);
  }

  push(ix: number, iy: number, iz: number): void {
    const piece = this.piece;
    this.system.pushPiece(
      piece,
      ix,
      iy,
      iz,
      piece.x + this.offset.x,
      piece.y + this.offset.y,
      piece.z + this.offset.z,
    );
  }
}
