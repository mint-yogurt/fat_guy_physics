import type { Object3D, Scene } from "three/webgpu";

import { pieceMass, type BuildField, type BuildPiece, type SupportWorld } from "@fgp/shared/items/building";
import type { OrientedSolid, SceneSolidQuery } from "@fgp/shared/sim/sceneQuery";
import type { Prop, Tree, World } from "@fgp/shared/sim/world";

import type { PieceMeshes } from "../render/pieceMesh.ts";
import type { LogSystem } from "./logSystem.ts";
import type { BodyHandle, PhysicsWorld } from "./physicsWorld.ts";

/**
 * Everything physical about placed building pieces (shared/items/building.ts
 * is the data; this is the rigid bodies, the meshes and the rest).
 *
 * A piece gripped to the world (`fixed`: a ladder) is a static body, there for
 * everything else to land on. A loose one is a dynamic body: set down, it drops
 * and settles, and goes to sleep where it comes to rest. Whatever the field
 * holds, this makes a body and a mesh for, so a save loading, a piece being
 * placed and a piece being released all take the same road: the field changes
 * and `update` catches up.
 *
 * Each frame it
 *  - follows the bodies of moving pieces into the field (so the sim sees the
 *    pose) and keeps terrain collision bodies near them (the log system owns
 *    those, `keepAround`);
 *  - lists the pieces at rest near the player as solid for walking
 *    (`SceneSolidQuery.pieces`), like settled logs; and
 *  - once a second, asks the field which fixed pieces have lost whatever held
 *    them (dug away, chopped, picked up) and lets those fall.
 *
 * Jolt loads later than the game starts, so until then nothing moves: pieces
 * stay where they were put, and gain bodies, asleep, when it arrives.
 */

/** Pieces nearer than this to the player are solid to walk on. Metres. */
const SOLID_NEAR = 16;
/** Seconds between looks at what is holding fixed pieces up. */
const ANCHOR_CHECK_SECONDS = 1;
/** A piece that has fallen this far down out of the world is lost. */
const LOST_BELOW = -30;
/** Pieces wake and are re-checked when disturbed this near, metres past their own size. */
const DISTURB_MARGIN = 0.6;

interface View {
  readonly object: Object3D;
  handle: BodyHandle | undefined;
  /** Whether the body is dynamic, as the piece was when it was made. */
  dynamic: boolean;
}

export class BuildSystem {
  private readonly views = new Map<BuildPiece, View>();
  private physics: PhysicsWorld | undefined;
  private logs: LogSystem | undefined;
  private readonly transform = new Float32Array(7);
  private readonly loose: BuildPiece[] = [];
  private readonly nearTrees: Tree[] = [];
  private readonly nearProps: Prop[] = [];
  private readonly nearby: BuildPiece[] = [];
  private anchorTimer = ANCHOR_CHECK_SECONDS;

  private readonly support: SupportWorld;

  /**
   * `activeMeters`: pieces further than this from the player are not looked
   * after (the terrain they stand on may not be loaded, which would read as
   * nothing holding them up) and are not drawn.
   */
  constructor(
    private readonly field: BuildField,
    private readonly world: World,
    private readonly query: SceneSolidQuery,
    private readonly scene: Scene,
    private readonly meshes: PieceMeshes,
    private readonly activeMeters: number,
    /** Rebuilt each frame with every piece near, for things in flight to hit (`TrunkQuery.solids`). */
    private readonly flightSolids: OrientedSolid[] = [],
  ) {
    this.support = {
      isSolid: (vx, vy, vz) => this.world.isSolid(vx, vy, vz),
      isInsideTreeOrProp: (x, y, z) => this.insideTreeOrProp(x, y, z),
    };
  }

  /** Jolt has loaded: pieces get bodies, asleep where they stand. */
  attachPhysics(physics: PhysicsWorld, logs: LogSystem): void {
    this.physics = physics;
    this.logs = logs;
  }

  /**
   * Something changed at (x, y, z) within `radius`: ground dug away, a piece
   * picked up. Pieces resting nearby are woken to settle again, and what holds
   * the fixed ones is looked at on the next frame.
   */
  disturb(x: number, y: number, z: number, radius: number): void {
    this.anchorTimer = 0;
    if (this.physics === undefined) return;
    for (const piece of this.field.near(x, y, z, radius + DISTURB_MARGIN, this.nearby)) {
      const view = this.views.get(piece);
      if (view?.handle === undefined || !view.dynamic) continue;
      this.physics.activate(view.handle);
      piece.settled = false;
    }
  }

  /** How many pieces have a rigid body (a dev readout). */
  get bodyCount(): number {
    let count = 0;
    for (const view of this.views.values()) if (view.handle !== undefined) count++;
    return count;
  }

  /** The rigid body of a piece, if it has one at the moment (a fixed one is a static body). */
  handleOf(piece: BuildPiece): BodyHandle | undefined {
    return this.views.get(piece)?.handle;
  }

  /** Applies an impulse to a piece, at a world point. Does nothing to one that is held fast. */
  pushPiece(piece: BuildPiece, ix: number, iy: number, iz: number, x: number, y: number, z: number): void {
    const view = this.views.get(piece);
    if (view?.handle === undefined || !view.dynamic) return;
    this.physics?.addImpulseAt(view.handle, ix, iy, iz, x, y, z);
  }

  /** The piece's velocity (linear then angular, 6 floats) into `out`; false if it has no moving body. */
  pieceVelocity(piece: BuildPiece, out: Float32Array): boolean {
    const view = this.views.get(piece);
    if (view?.handle === undefined || !view.dynamic) return false;
    return this.physics?.readVelocity(view.handle, out) ?? false;
  }

  update(rawDt: number, playerX: number, playerY: number, playerZ: number): void {
    for (const piece of this.field.removed) this.forget(piece);
    this.field.removed.length = 0;

    this.query.pieces.length = 0;
    this.flightSolids.length = 0;
    const field = this.field;
    for (let i = field.pieces.length - 1; i >= 0; i--) {
      const piece = field.pieces[i];
      if (piece === undefined) continue;
      let view = this.views.get(piece);
      if (view === undefined) view = this.adopt(piece);
      if (view.handle === undefined && this.physics !== undefined) this.giveBody(piece, view);

      if (view.handle !== undefined && view.dynamic && this.physics !== undefined) {
        if (this.physics.readTransform(view.handle, this.transform)) {
          field.setPose(
            piece,
            this.transform[0] ?? 0,
            this.transform[1] ?? 0,
            this.transform[2] ?? 0,
            this.transform[3] ?? 0,
            this.transform[4] ?? 0,
            this.transform[5] ?? 0,
            this.transform[6] ?? 1,
          );
        }
        const asleep = !this.physics.isActive(view.handle);
        if (asleep !== piece.settled) {
          piece.settled = asleep;
          // Where it came to rest is what a save keeps.
          if (asleep) field.version++;
        }
        if (!asleep) this.logs?.keepAround(piece.x, piece.y, piece.z, piece.solid.reach);
        if (piece.y < LOST_BELOW) {
          field.remove(piece);
          continue;
        }
      } else {
        // Fixed, or nothing to simulate it yet: it is where it is.
        piece.settled = true;
      }

      const near = Math.hypot(piece.x - playerX, piece.y - playerY, piece.z - playerZ);
      view.object.visible = near < this.activeMeters + 8;
      if (near < this.activeMeters + piece.solid.reach) this.flightSolids.push(piece.solid);
      if (view.object.visible) {
        view.object.position.set(piece.x, piece.y, piece.z);
        view.object.quaternion.set(piece.qx, piece.qy, piece.qz, piece.qw);
      }
      // Only a piece at rest can be stood on: a tumbling one would have the
      // player's feet chasing a surface the walk code cannot predict.
      if (piece.spec.walkable && piece.settled && near < SOLID_NEAR + piece.solid.reach) {
        this.query.pieces.push(piece.solid);
      }
    }

    this.anchorTimer -= rawDt;
    if (this.anchorTimer <= 0) {
      this.anchorTimer = ANCHOR_CHECK_SECONDS;
      this.releaseUnsupported(playerX, playerY, playerZ);
    }
  }

  dispose(): void {
    for (const piece of [...this.views.keys()]) this.forget(piece);
    this.query.pieces.length = 0;
    this.flightSolids.length = 0;
  }

  /** Makes the mesh for a piece the field has and the system has not seen. */
  private adopt(piece: BuildPiece): View {
    const object = this.meshes.make(piece.spec.item);
    if (object === undefined) throw new Error(`no mesh for building piece ${piece.spec.item}`);
    this.scene.add(object);
    const view: View = { object, handle: undefined, dynamic: !piece.fixed };
    this.views.set(piece, view);
    return view;
  }

  /** Its rigid body, at the piece's pose: asleep if the piece has been at rest (loaded from a save), falling if it has just been put down. */
  private giveBody(piece: BuildPiece, view: View): void {
    const physics = this.physics;
    if (physics === undefined) return;
    view.dynamic = !piece.fixed;
    const [sx, sy, sz] = piece.spec.size;
    // A piece about to fall needs the ground to land on.
    if (view.dynamic && !piece.settled) this.logs?.ensureStaticAround(piece.x, piece.y, piece.z, piece.solid.reach);
    view.handle = physics.spawnPiece(
      piece.spec.round,
      sx / 2,
      sy / 2,
      sz / 2,
      piece.x,
      piece.y,
      piece.z,
      [piece.qx, piece.qy, piece.qz, piece.qw],
      pieceMass(piece.spec),
      view.dynamic,
      !piece.settled,
    );
  }

  private forget(piece: BuildPiece): void {
    const view = this.views.get(piece);
    if (view === undefined) return;
    this.views.delete(piece);
    if (view.handle !== undefined) this.physics?.removeBody(view.handle);
    this.scene.remove(view.object);
  }

  /** Lets go of fixed pieces that nothing holds up any more. */
  private releaseUnsupported(playerX: number, playerY: number, playerZ: number): void {
    // Chunks still streaming in read as air: do not take that for a wall going away.
    if (this.world.pendingCount > 0) return;
    this.field.looseOnes(this.support, this.loose);
    for (const piece of this.loose) {
      if (Math.hypot(piece.x - playerX, piece.y - playerY, piece.z - playerZ) > this.activeMeters) continue;
      const view = this.views.get(piece);
      if (view === undefined) continue;
      if (view.handle !== undefined) this.physics?.removeBody(view.handle);
      view.handle = undefined;
      piece.fixed = false;
      piece.settled = false;
      this.field.version++;
      // The next update gives it a dynamic body, awake.
    }
  }

  private insideTreeOrProp(x: number, y: number, z: number): boolean {
    for (const tree of this.world.treesNear(x, z, 3, this.nearTrees)) {
      if (tree.trunkTopMeters <= 0 || y < tree.y || y > tree.y + tree.trunkTopMeters) continue;
      const radius = tree.trunkRadiusMeters;
      if ((tree.x - x) ** 2 + (tree.z - z) ** 2 <= radius * radius) return true;
    }
    for (const prop of this.world.propsNear(x, z, 4, this.nearProps)) {
      if (prop.height <= 0 || y < prop.y || y > prop.y + prop.height) continue;
      if ((prop.x - x) ** 2 + (prop.z - z) ** 2 <= prop.radius * prop.radius) return true;
    }
    return false;
  }
}
