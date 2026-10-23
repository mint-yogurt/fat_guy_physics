import { Group, Mesh, Quaternion, Vector3, type Object3D, type Scene } from "three/webgpu";

import { ItemType } from "@fgp/shared/items/inventory";
import { chunkKey, keyX, keyZ } from "@fgp/shared/sim/chunkKey";
import type { OrientedBody, SceneSolidQuery } from "@fgp/shared/sim/sceneQuery";
import { tileOf, TILE_METERS } from "@fgp/shared/worldgen/groundField";
import type { Tree, World } from "@fgp/shared/sim/world";

import type { ItemAssets } from "../render/itemAssets.ts";
import { sliceAtY } from "../render/sliceGeometry.ts";
import { horizontalRadius } from "../render/treeAssets.ts";
import type { FellingPiece, PieceShape } from "../render/treeRenderer.ts";
import type { BodyHandle, PhysicsWorld } from "./physicsWorld.ts";

/**
 * Felled pieces: whatever a chup cuts off a tree, as a falling rigid body
 * with the sliced piece of the tree's own mesh drawn on it -- and the start
 * of the wood economy. A piece can be chupped again, which cuts it in two
 * at the swing, the same way its tree was cut. Anything short enough
 * (LOG_PIECE_MAX_METERS) is not a body at all: it breaks down into log
 * pickups, and whatever foliage it carried puffs into leaves.
 *
 * Terrain collision bodies are created here rather than globally, and only
 * for the chunks immediately around a moving piece. Static mesh bodies are
 * not free to build, there are ~450 loaded chunks, and nothing but a piece
 * ever needs one -- so they follow the pieces around and are dropped the
 * moment no piece is near them. Standing trunks and stumps get the same
 * treatment, as static cylinders: without them a piece drops straight
 * through the stump it was cut from.
 *
 * Thrown logs live here too: a log bowled or lobbed out of the hand is a
 * small Jolt capsule with the log mesh on it, rolling and bouncing over the
 * same terrain bodies, until it comes to rest and turns back into a log
 * pickup where it stopped.
 */

/** Chunks either side of a piece's own that get a collision body. */
const TERRAIN_BODY_RADIUS = 1;

/** Standing trees within this of a moving piece (plus its half length) get a trunk body. */
const TRUNK_BODY_RADIUS = 2.5;

/** Pieces further than this from the player are dropped, mesh and body. */
const LOG_CULL_METERS = 48;

/** A piece this short or shorter is logs, not a body. */
const LOG_PIECE_MAX_METERS = 1.3;
/** Wood volume per log, m^3: a typical trunk comes apart into four or five. */
const LOG_VOLUME = 0.12;
const MAX_LOGS_PER_PIECE = 6;
/** Leaves each foliage cluster on a broken-down piece puffs into (it was four). */
const LEAVES_PER_CLUSTER = 2;

/** Swings to cut a piece in two, how far a cut may wander, and the shortest part a cut leaves. */
const CHOPS_TO_CUT = 2;
const CHOP_REANCHOR_METERS = 0.4;
const MIN_PART_METERS = 0.35;

/**
 * Rolling resistance on a thrown log touching the ground, as a steady
 * deceleration in m/s^2. Jolt has none of its own, so without this a rolled
 * log coasts forever on the flat and runs away down any slope. Being a
 * constant rather than a fraction of the speed, it brings a slow roll to a
 * proper stop, and holds a log still on a slope gentler than about 15
 * degrees. Range on the flat is v^2 / 2a.
 */
const ROLL_RESISTANCE = 1.6;
/** How close to the ground a log's centre counts as rolling on it, beyond its radius. */
const ROLL_CONTACT_SLACK = 0.12;
/** A thrown log goes back to being a pickup once it rests, or after this long regardless. */
const THROWN_LOG_MAX_SECONDS = 15;
/** It is never "at rest" sooner than this, while Jolt is still waking it. */
const THROWN_LOG_MIN_SECONDS = 0.4;

export type DropFn = (
  type: ItemType,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
) => void;

export interface Piece {
  readonly handle: BodyHandle;
  readonly object: Object3D;
  readonly shape: PieceShape;
  readonly lengthMeters: number;
  /**
   * The cylinder standing in for the piece, and the pose it is in. Handed
   * to the scene query once the piece settles, which is what makes it
   * walkable.
   */
  readonly body: OrientedBody;
  settled: boolean;
  /** Speed at the last update (m/s), to notice a sudden stop. */
  lastSpeed: number;
  /** Chop progress, as on a standing tree: a body-local height and a hit count. */
  chopLocalY: number;
  chopHits: number;
}

interface ThrownLog {
  readonly handle: BodyHandle;
  readonly object: Object3D;
  /** performance.now() at the throw, ms. */
  readonly born: number;
  /** Speed at the last update (m/s), to notice a sudden stop. */
  lastSpeed: number;
}

export interface PieceHit {
  piece: Piece | undefined;
  distance: number;
  x: number;
  y: number;
  z: number;
}

const scratchQuat = new Quaternion();
const scratchVec = new Vector3();
const scratchDir = new Vector3();

/**
 * Ray against a capsule along local Y (half length `h`, radius `r`), both
 * already in the capsule's frame. Distance to the first hit, or Infinity.
 */
function rayCapsule(o: Vector3, d: Vector3, h: number, r: number): number {
  let best = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = o.x * d.x + o.z * d.z;
    const c = o.x * o.x + o.z * o.z - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0 && Math.abs(o.y + t * d.y) <= h) best = t;
    }
  }
  for (const cy of [h, -h]) {
    const oy = o.y - cy;
    const b = o.x * d.x + oy * d.y + o.z * d.z;
    const c = o.x * o.x + oy * oy + o.z * o.z - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

export function createPieceHit(): PieceHit {
  return { piece: undefined, distance: Infinity, x: 0, y: 0, z: 0 };
}

/** A body that loses this much speed (m/s) between two updates has hit something. */
const IMPACT_MIN_DROP = 2.5;

export class LogSystem {
  /** Called when a piece or thrown log hits something hard: where, and how hard (m/s of speed lost). */
  onImpact: ((x: number, y: number, z: number, strength: number) => void) | undefined = undefined;
  private readonly pieces: Piece[] = [];
  private readonly thrown: ThrownLog[] = [];
  private readonly velocity = new Float32Array(6);
  private lastThrownUpdate = 0;
  private readonly transform = new Float32Array(7);
  private readonly wantedChunks = new Set<number>();
  private readonly wantedTrunks = new Set<number>();
  private readonly nearTrees: Tree[] = [];
  /** Spots other systems' moving bodies are at (x, y, z, reach), to be kept in terrain until the next update. */
  private readonly keeping: number[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: World,
    private readonly query: SceneSolidQuery,
    private readonly scene: Scene,
    private readonly drop: DropFn,
    private readonly items: ItemAssets,
  ) {}

  get count(): number {
    return this.pieces.length;
  }

  get thrownCount(): number {
    return this.thrown.length;
  }

  /**
   * A log leaving the hand at a position, rotation (body Y along the log)
   * and velocity. False if there was no body to make, so the caller can
   * drop it as a plain pickup instead.
   */
  throwLog(
    x: number,
    y: number,
    z: number,
    rotation: readonly [number, number, number, number],
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
  ): boolean {
    const radius = Math.max(0.03, this.items.logRadius);
    this.markWanted(x, y, z, this.items.logLength / 2);
    this.syncStaticBodies();
    const handle = this.physics.spawnLog(x, y, z, radius, this.items.logLength / 2, rotation);
    if (handle === undefined) return false;
    this.physics.setVelocity(handle, vx, vy, vz, wx, wy, wz);
    const object = this.items.log.clone();
    object.position.set(x, y, z);
    object.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    this.scene.add(object);
    this.thrown.push({ handle, object, born: performance.now(), lastSpeed: 0 });
    return true;
  }

  /**
   * Takes ownership of a piece just cut off a standing tree, toppling it
   * about the horizontal axis (toppleX, 0, toppleZ).
   */
  spawnFelled(piece: FellingPiece, toppleX: number, toppleZ: number): void {
    this.spawn(piece.shape, piece.x, piece.y, piece.z, [0, 0, 0, 1], toppleX, toppleZ);
  }

  /**
   * A shape at a world position and rotation: a body if it is long enough,
   * otherwise logs and leaves on the spot.
   */
  private spawn(
    shape: PieceShape,
    x: number,
    y: number,
    z: number,
    rotation: readonly [number, number, number, number],
    toppleX = 0,
    toppleZ = 0,
  ): void {
    const lengthMeters = (shape.top - shape.bottom) * shape.scale;
    const radius = Math.max(
      0.05,
      shape.trunk === undefined
        ? shape.trunkRadiusMeters
        : Math.min(shape.trunkRadiusMeters, horizontalRadius(shape.trunk) * shape.scale),
    );

    scratchQuat.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    if (shape.trunk === undefined || lengthMeters <= LOG_PIECE_MAX_METERS) {
      this.breakDown(shape, x, y, z, scratchQuat, lengthMeters, radius);
      return;
    }

    // Collision first: a piece spawned into a world with nothing under it
    // falls through before the next sync can catch it.
    this.markWanted(x, y, z, lengthMeters / 2);
    this.syncStaticBodies();

    const halfHeight = Math.max(0.05, lengthMeters / 2 - radius);
    const handle = this.physics.spawnCapsule(x, y, z, radius, halfHeight, rotation, toppleX, toppleZ);
    if (handle === undefined) {
      shape.trunk.dispose();
      return;
    }

    const object = this.build(shape);
    object.position.set(x, y, z);
    object.quaternion.copy(scratchQuat);
    this.scene.add(object);
    this.pieces.push({
      handle,
      object,
      shape,
      lengthMeters,
      body: {
        radius,
        halfHeight,
        x,
        y,
        z,
        qx: rotation[0],
        qy: rotation[1],
        qz: rotation[2],
        qw: rotation[3],
      },
      settled: false,
      lastSpeed: 0,
      chopLocalY: 0,
      chopHits: 0,
    });
  }

  /**
   * The mesh for a shape. Nested: the outer object is driven by the body's
   * transform, so the inner one carries the tree's own scale and yaw and
   * the shift that puts the piece's middle at the origin.
   */
  private build(shape: PieceShape): Object3D {
    const object = new Group();
    const inner = new Group();
    inner.rotation.y = shape.yaw;
    inner.scale.setScalar(shape.scale);
    inner.position.y = -((shape.bottom + shape.top) / 2) * shape.scale;
    object.add(inner);
    if (shape.trunk !== undefined) {
      shape.trunk.computeBoundingSphere();
      inner.add(new Mesh(shape.trunk, shape.trunkMaterials));
    }
    for (const cluster of shape.foliage) inner.add(new Mesh(cluster.geometry, shape.foliageMaterial));
    return object;
  }

  /** Turns a short piece into logs along its length, and its foliage into leaves. */
  private breakDown(
    shape: PieceShape,
    x: number,
    y: number,
    z: number,
    rotation: Quaternion,
    lengthMeters: number,
    radius: number,
  ): void {
    const mid = (shape.bottom + shape.top) / 2;
    // The piece's own axis in the world, for spreading drops along it.
    const axis = scratchDir.set(0, 1, 0).applyQuaternion(rotation);
    const pop = (): number => (Math.random() - 0.5) * 1.6;

    if (shape.trunk !== undefined) {
      const volume = Math.PI * radius * radius * lengthMeters;
      const logs = Math.min(MAX_LOGS_PER_PIECE, Math.max(1, Math.round(volume / LOG_VOLUME)));
      for (let i = 0; i < logs; i++) {
        const along = ((i + 0.5) / logs - 0.5) * lengthMeters;
        this.drop(
          ItemType.Log,
          x + axis.x * along,
          y + axis.y * along + 0.2,
          z + axis.z * along,
          pop(),
          2 + Math.random(),
          pop(),
        );
      }
      shape.trunk.dispose();
    }

    for (const cluster of shape.foliage) {
      const along = (cluster.y - mid) * shape.scale;
      for (let i = 0; i < LEAVES_PER_CLUSTER; i++) {
        this.drop(
          ItemType.Leaf,
          x + axis.x * along + pop() * 0.4,
          y + axis.y * along + pop() * 0.4,
          z + axis.z * along + pop() * 0.4,
          pop(),
          1 + Math.random(),
          pop(),
        );
      }
    }
  }

  /** Nearest piece along a ray, if one is nearer than `maxDistance`. `out.piece` is undefined on a miss. */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: PieceHit,
  ): PieceHit {
    out.piece = undefined;
    out.distance = maxDistance;
    const origin = scratchVec;
    const dir = scratchDir;
    for (const piece of this.pieces) {
      const body = piece.body;
      scratchQuat.set(body.qx, body.qy, body.qz, body.qw).invert();
      origin.set(ox - body.x, oy - body.y, oz - body.z).applyQuaternion(scratchQuat);
      dir.set(dx, dy, dz).applyQuaternion(scratchQuat);
      const t = rayCapsule(origin, dir, body.halfHeight, body.radius);
      if (t < out.distance) {
        out.piece = piece;
        out.distance = t;
      }
    }
    if (out.piece !== undefined) {
      out.x = ox + dx * out.distance;
      out.y = oy + dy * out.distance;
      out.z = oz + dz * out.distance;
    }
    return out;
  }

  /**
   * One chup swing landing on a piece at a world point. Every CHOPS_TO_CUT
   * swings at about one place cut it in two there; each half is then a
   * piece of its own, or logs if it is short enough.
   */
  chup(piece: Piece, hitX: number, hitY: number, hitZ: number): boolean {
    const index = this.pieces.indexOf(piece);
    if (index < 0) return false;
    const body = piece.body;
    scratchQuat.set(body.qx, body.qy, body.qz, body.qw).invert();
    const localY = scratchVec.set(hitX - body.x, hitY - body.y, hitZ - body.z).applyQuaternion(scratchQuat).y;

    if (Math.abs(localY - piece.chopLocalY) > CHOP_REANCHOR_METERS || piece.chopHits === 0) {
      piece.chopLocalY = localY;
      piece.chopHits = 0;
    }
    piece.chopHits++;
    if (piece.chopHits < CHOPS_TO_CUT) return true;

    const half = piece.lengthMeters / 2;
    const cutLocal = Math.min(half - MIN_PART_METERS, Math.max(-half + MIN_PART_METERS, piece.chopLocalY));
    const shape = piece.shape;
    const mid = (shape.bottom + shape.top) / 2;
    const cut = mid + cutLocal / shape.scale;
    const sliced = shape.trunk === undefined ? { below: undefined, above: undefined } : sliceAtY(shape.trunk, cut);

    // Gone from the world before the halves arrive, so they do not spawn
    // overlapping the body they replace.
    this.pieces.splice(index, 1);
    this.physics.removeBody(piece.handle);
    this.scene.remove(piece.object);
    shape.trunk?.dispose();

    const rotation: [number, number, number, number] = [body.qx, body.qy, body.qz, body.qw];
    const axis = new Vector3(0, 1, 0).applyQuaternion(scratchQuat.set(body.qx, body.qy, body.qz, body.qw));
    const halves: PieceShape[] = [
      { ...shape, trunk: sliced.below, bottom: shape.bottom, top: cut, foliage: shape.foliage.filter((f) => f.y < cut) },
      { ...shape, trunk: sliced.above, bottom: cut, top: shape.top, foliage: shape.foliage.filter((f) => f.y >= cut) },
    ];
    for (const part of halves) {
      if (part.trunk === undefined && part.foliage.length === 0) continue;
      const offset = ((part.bottom + part.top) / 2 - mid) * shape.scale;
      this.spawn(part, body.x + axis.x * offset, body.y + axis.y * offset, body.z + axis.z * offset, rotation);
    }
    return true;
  }

  /** A shove, as from a thrown stick. */
  shove(piece: Piece, ix: number, iy: number, iz: number): void {
    this.physics.addImpulse(piece.handle, ix, iy, iz);
  }

  /**
   * Keeps terrain and trunk bodies around a point for the next update, for a
   * moving body that is not one of this system's (a building piece falling).
   * This system owns those bodies, so everything that needs them asks here.
   */
  keepAround(x: number, y: number, z: number, reach: number): void {
    this.keeping.push(x, y, z, reach);
  }

  /** As {@link keepAround}, and makes the bodies now, for a body about to be dropped into the world this instant. */
  ensureStaticAround(x: number, y: number, z: number, reach: number): void {
    this.keepAround(x, y, z, reach);
    this.markWanted(x, y, z, reach);
    this.syncStaticBodies();
  }

  /** Drives mesh transforms off the bodies and keeps static bodies around them. */
  update(playerX: number, playerY: number, playerZ: number): void {
    this.wantedChunks.clear();
    this.wantedTrunks.clear();
    for (let i = 0; i < this.keeping.length; i += 4) {
      this.markWanted(this.keeping[i] ?? 0, this.keeping[i + 1] ?? 0, this.keeping[i + 2] ?? 0, this.keeping[i + 3] ?? 0);
    }
    this.keeping.length = 0;
    // Rebuilt from scratch each frame rather than patched: the list is a
    // handful of entries, and a piece that woke up has to leave it the same
    // frame or the player stands on a piece that is no longer there.
    this.query.bodies.length = 0;

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i];
      if (piece === undefined) continue;

      if (!this.physics.readTransform(piece.handle, this.transform)) continue;
      const x = this.transform[0] ?? 0;
      const y = this.transform[1] ?? 0;
      const z = this.transform[2] ?? 0;

      if (Math.hypot(x - playerX, y - playerY, z - playerZ) > LOG_CULL_METERS) {
        this.remove(piece);
        this.pieces.splice(i, 1);
        continue;
      }

      piece.object.position.set(x, y, z);
      piece.body.x = x;
      piece.body.y = y;
      piece.body.z = z;
      piece.body.qx = this.transform[3] ?? 0;
      piece.body.qy = this.transform[4] ?? 0;
      piece.body.qz = this.transform[5] ?? 0;
      piece.body.qw = this.transform[6] ?? 1;
      piece.object.quaternion.set(piece.body.qx, piece.body.qy, piece.body.qz, piece.body.qw);

      // A sleeping piece needs nothing under it, so its static bodies are
      // allowed to go away until something wakes it.
      piece.settled = !this.physics.isActive(piece.handle);
      piece.lastSpeed = this.noticeImpact(piece.handle, piece.lastSpeed, x, y, z);
      if (piece.settled) {
        // Only settled pieces are walkable. A tumbling one would mean the
        // player's feet chasing a moving surface the physics system does
        // not know about, which reads as being thrown around.
        this.query.bodies.push(piece.body);
      } else {
        this.markWanted(x, y, z, piece.lengthMeters / 2);
      }
    }

    this.updateThrown(playerX, playerY, playerZ);
    this.syncStaticBodies();
  }

  /** Moves thrown logs, and lands the ones that have stopped as pickups. */
  private updateThrown(playerX: number, playerY: number, playerZ: number): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastThrownUpdate) / 1000);
    this.lastThrownUpdate = now;
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const log = this.thrown[i];
      if (log === undefined) continue;
      if (!this.physics.readTransform(log.handle, this.transform)) continue;
      const x = this.transform[0] ?? 0;
      const y = this.transform[1] ?? 0;
      const z = this.transform[2] ?? 0;
      log.object.position.set(x, y, z);
      log.object.quaternion.set(
        this.transform[3] ?? 0,
        this.transform[4] ?? 0,
        this.transform[5] ?? 0,
        this.transform[6] ?? 1,
      );

      log.lastSpeed = this.noticeImpact(log.handle, log.lastSpeed, x, y, z);
      const age = (now - log.born) / 1000;
      const resting = age > THROWN_LOG_MIN_SECONDS && !this.physics.isActive(log.handle);
      const far = Math.hypot(x - playerX, y - playerY, z - playerZ) > LOG_CULL_METERS;
      if (resting || far || age > THROWN_LOG_MAX_SECONDS) {
        this.removeThrown(log);
        this.thrown.splice(i, 1);
        this.drop(ItemType.Log, x, y, z, 0, 0, 0);
        continue;
      }
      this.markWanted(x, y, z, this.items.logLength / 2);
      this.resistRolling(log, x, y, z, dt);
    }
  }

  /** Reports a sudden loss of speed as an impact; returns the body's speed now. */
  private noticeImpact(handle: BodyHandle, lastSpeed: number, x: number, y: number, z: number): number {
    if (this.onImpact === undefined) return 0;
    if (!this.physics.readVelocity(handle, this.velocity)) return lastSpeed;
    const v = this.velocity;
    const speed = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    if (lastSpeed - speed >= IMPACT_MIN_DROP) this.onImpact(x, y, z, lastSpeed - speed);
    return speed;
  }

  /** Slows a thrown log that is on the ground; see ROLL_RESISTANCE. */
  private resistRolling(log: ThrownLog, x: number, y: number, z: number, dt: number): void {
    const ground = this.world.groundHeight(x, z);
    const radius = this.items.logRadius;
    if (y - ground > radius + ROLL_CONTACT_SLACK) return;
    if (!this.physics.readVelocity(log.handle, this.velocity)) return;
    const v = this.velocity;
    const lose = ROLL_RESISTANCE * dt;
    // Speed and rim speed lose the same amount, so the roll stays a roll.
    const speed = Math.hypot(v[0] ?? 0, v[2] ?? 0);
    const rim = Math.hypot(v[3] ?? 0, v[4] ?? 0, v[5] ?? 0) * radius;
    const keep = speed > lose ? (speed - lose) / speed : 0;
    const keepSpin = rim > lose ? (rim - lose) / rim : 0;
    this.physics.setVelocity(
      log.handle,
      (v[0] ?? 0) * keep,
      v[1] ?? 0,
      (v[2] ?? 0) * keep,
      (v[3] ?? 0) * keepSpin,
      (v[4] ?? 0) * keepSpin,
      (v[5] ?? 0) * keepSpin,
    );
  }

  private removeThrown(log: ThrownLog): void {
    this.physics.removeBody(log.handle);
    this.scene.remove(log.object);
  }

  /** Marks the chunks and trunks around a point as needing a collision body. */
  private markWanted(x: number, _y: number, z: number, reach: number): void {
    const cx = tileOf(x);
    const cz = tileOf(z);
    for (let dz = -TERRAIN_BODY_RADIUS; dz <= TERRAIN_BODY_RADIUS; dz++) {
      for (let dx = -TERRAIN_BODY_RADIUS; dx <= TERRAIN_BODY_RADIUS; dx++) {
        this.wantedChunks.add(chunkKey(cx + dx, 0, cz + dz));
      }
    }
    for (const tree of this.world.treesNear(x, z, TRUNK_BODY_RADIUS + reach, this.nearTrees)) {
      if (tree.trunkTopMeters > 0) this.wantedTrunks.add(tree.id);
    }
  }

  /** Creates bodies for every wanted chunk and trunk, and drops the rest. */
  private syncStaticBodies(): void {
    for (const key of this.wantedChunks) {
      if (this.physics.hasTerrainBody(key)) continue;
      const cx = keyX(key);
      const cz = keyZ(key);
      const triangles = this.world.groundTriangles(cx, cz);
      if (triangles === undefined) continue;
      this.physics.addTerrainBody(
        key,
        cx * TILE_METERS,
        0,
        cz * TILE_METERS,
        triangles,
        triangles.length / 3,
      );
    }
    for (const key of this.physics.terrainBodyKeys()) {
      if (!this.wantedChunks.has(key)) this.physics.removeTerrainBody(key);
    }

    for (const treeId of this.wantedTrunks) {
      const tree = this.world.getTree(treeId);
      if (tree === undefined) continue;
      this.physics.setTrunkBody(tree.id, tree.x, tree.y, tree.z, tree.trunkRadiusMeters, tree.trunkTopMeters);
    }
    for (const treeId of this.physics.trunkBodyIds()) {
      const tree = this.world.getTree(treeId);
      // Also when a cut has shortened it to nothing since.
      if (!this.wantedTrunks.has(treeId) || tree === undefined || tree.trunkTopMeters <= 0) {
        this.physics.removeTrunkBody(treeId);
      }
    }
  }

  private remove(piece: Piece): void {
    this.physics.removeBody(piece.handle);
    this.scene.remove(piece.object);
    piece.shape.trunk?.dispose();
  }

  clear(): void {
    for (const piece of this.pieces) this.remove(piece);
    this.pieces.length = 0;
    for (const log of this.thrown) this.removeThrown(log);
    this.thrown.length = 0;
  }
}
