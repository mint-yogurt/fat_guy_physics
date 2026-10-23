import { VOXEL_SIZE } from "../sim/constants.ts";
import { WALK_HEIGHT } from "../sim/player.ts";
import { createMat3, createQuat, quatFromMat, turnMat } from "../sim/rotation.ts";
import { solidContains } from "../sim/sceneQuery.ts";
import { HitKind, type Prop, type SceneHit, type Tree } from "../sim/world.ts";
import type { BuildField, BuildHit, BuildPiece, PieceSpec } from "./building.ts";
import { createPlacementPlan, type PlacementBlock, type PlacementPlan, type PlacementPlayer } from "./placement.ts";
import type { PlacementOrientation } from "./placementControl.ts";

/**
 * Where a building piece goes. The player aims at a surface; the piece is laid
 * against it, turned by the player's spin and tilt, and tested for room. Every
 * piece is planned the same way from its {@link PieceSpec}: nothing here knows
 * what a ladder or a plank is.
 *
 * The rules:
 *  1. The piece's contact face goes against the surface (the plan's normal).
 *  2. Its long way runs along the surface: up a wall, or the way the player
 *     faces on a floor. Spin turns that about the normal; tilt then leans it
 *     out of the surface.
 *  3. It is then slid out along the normal until it just touches the aimed
 *     point, for whatever shape and angle it ended up at, so a leaning ladder
 *     touches the wall with its top edge rather than sinking into it.
 *  4. It is tested for room by points all through its volume: the ground, a
 *     trunk, another piece, or the player in the way make it red.
 */

/** What the crosshair is on: a point on a surface and the way the surface faces. */
export interface SurfaceAim {
  valid: boolean;
  x: number;
  y: number;
  z: number;
  /** Unit normal, out of the surface toward the player. */
  nx: number;
  ny: number;
  nz: number;
}

export function createSurfaceAim(): SurfaceAim {
  return { valid: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

/** The slice of the world the aim reads. */
export interface AimWorld {
  getTree(treeId: number): Tree | undefined;
  getProp(propId: number): Prop | undefined;
}

/**
 * Works out the surface under the crosshair from the scene ray (terrain, trees,
 * props) and the ray against placed pieces, whichever is nearer. A trunk or a
 * prop is a round thing made of voxels to the ray, so its normal is worked out
 * from its centre instead of from a voxel face.
 */
export function aimAtSurface(
  world: AimWorld,
  scene: SceneHit,
  build: BuildHit,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  out: SurfaceAim,
): SurfaceAim {
  const sceneDistance = scene.kind === HitKind.None ? Infinity : scene.distance;
  const buildDistance = build.piece === undefined ? Infinity : build.distance;
  out.valid = false;
  if (buildDistance <= sceneDistance && buildDistance < Infinity) {
    out.valid = true;
    out.x = build.x;
    out.y = build.y;
    out.z = build.z;
    out.nx = build.nx;
    out.ny = build.ny;
    out.nz = build.nz;
    return out;
  }
  // Starting inside something is not an aim at its surface.
  if (sceneDistance === Infinity || sceneDistance <= 0) return out;
  out.valid = true;
  out.x = ox + dx * sceneDistance;
  out.y = oy + dy * sceneDistance;
  out.z = oz + dz * sceneDistance;
  out.nx = scene.normalX;
  out.ny = scene.normalY;
  out.nz = scene.normalZ;
  const round =
    scene.kind === HitKind.Tree
      ? world.getTree(scene.treeId)
      : scene.kind === HitKind.Prop
        ? world.getProp(scene.propId)
        : undefined;
  if (round !== undefined) {
    // A voxel's top face is a top; a side is the trunk's own.
    const rx = out.x - round.x;
    const rz = out.z - round.z;
    const length = Math.hypot(rx, rz);
    if (length > 1e-4 && Math.abs(scene.normalY) < 0.5) {
      out.nx = rx / length;
      out.ny = 0;
      out.nz = rz / length;
    }
  }
  return out;
}

/** The slice of the world a piece's room is tested against. */
export interface PieceWorld {
  isSolid(vx: number, vy: number, vz: number): boolean;
  treesNear(x: number, z: number, radius: number, out: Tree[]): Tree[];
  propsNear(x: number, z: number, radius: number, out: Prop[]): Prop[];
}

/** Spacing of the points tested through a piece's volume, metres. */
const SAMPLE_SPACING = 0.1;
/** The gap left between a piece and the surface it is laid on, metres. */
const CONTACT_GAP = 0.005;
/** A wall is anything this far from flat: past it the long way runs up. */
const WALL_NORMAL_Y = 0.7;
/** Trees and props this far beyond the piece are tested against it. */
const SEARCH_MARGIN = 3;
/** A trunk is tested a little fat, so a piece laid right against it is not "in" it. */
const TRUNK_SLACK = 0.02;

export class PiecePlanner {
  private readonly result = createPlacementPlan();
  private readonly axes = createMat3();
  private readonly turn = createMat3();
  private readonly quat = createQuat();
  private readonly samples = new Map<PieceSpec, Float64Array>();
  private readonly trees: Tree[] = [];
  private readonly props: Prop[] = [];
  private readonly nearby: BuildPiece[] = [];

  constructor(
    private readonly world: PieceWorld,
    private readonly field: BuildField,
  ) {}

  /**
   * Plans `spec` laid on the aimed surface, turned by `orient`. The plan is
   * reused, so read it before asking again. `faceX/Z` is the way the player
   * is looking, flattened: what "ahead" means on a floor.
   */
  plan(
    spec: PieceSpec,
    aim: SurfaceAim,
    player: PlacementPlayer,
    faceX: number,
    faceZ: number,
    orient: PlacementOrientation,
  ): PlacementPlan {
    const plan = this.result;
    const nLength = Math.hypot(aim.nx, aim.ny, aim.nz) || 1;
    const nx = aim.nx / nLength;
    const ny = aim.ny / nLength;
    const nz = aim.nz / nLength;

    // The long way along the surface: up a wall, ahead on a floor.
    let rx: number;
    let ry: number;
    let rz: number;
    if (Math.abs(ny) < WALL_NORMAL_Y) {
      rx = -ny * nx;
      ry = 1 - ny * ny;
      rz = -ny * nz;
    } else {
      const along = faceX * nx + 0 * ny + faceZ * nz;
      rx = faceX - nx * along;
      ry = -ny * along;
      rz = faceZ - nz * along;
    }
    let rLength = Math.hypot(rx, ry, rz);
    if (rLength < 1e-4) {
      // Looking straight down a floor, or a normal along the facing: any way along the surface will do.
      rx = ny;
      ry = -nx;
      rz = 0;
      rLength = Math.hypot(rx, ry, rz) || 1;
    }
    rx /= rLength;
    ry /= rLength;
    rz /= rLength;

    // Spin it about the normal.
    const turn = this.turn;
    turn.fill(0);
    turn[0] = rx;
    turn[1] = ry;
    turn[2] = rz;
    turnMat(turn, nx, ny, nz, orient.spin);
    const sx = turn[0] ?? 0;
    const sy = turn[1] ?? 0;
    const sz = turn[2] ?? 0;

    // Its own axes in the world: contact face into the surface, long axis along it.
    const m = this.axes;
    const contact = spec.contactAxis;
    const long = spec.along;
    const third = 3 - contact - long;
    const intoX = -spec.contactSign * nx;
    const intoY = -spec.contactSign * ny;
    const intoZ = -spec.contactSign * nz;
    m[contact * 3] = intoX;
    m[contact * 3 + 1] = intoY;
    m[contact * 3 + 2] = intoZ;
    m[long * 3] = sx;
    m[long * 3 + 1] = sy;
    m[long * 3 + 2] = sz;
    // The last axis completes a right-handed set: a cross product, in the order the axes cycle.
    const cyclic = (long - contact + 3) % 3 === 1;
    const ax = cyclic ? intoX : sx;
    const ay = cyclic ? intoY : sy;
    const az = cyclic ? intoZ : sz;
    const bx = cyclic ? sx : intoX;
    const by = cyclic ? sy : intoY;
    const bz = cyclic ? sz : intoZ;
    m[third * 3] = ay * bz - az * by;
    m[third * 3 + 1] = az * bx - ax * bz;
    m[third * 3 + 2] = ax * by - ay * bx;

    // Lean it: about the axis along the surface and across the long way, raising the far end off the surface.
    turnMat(m, sy * nz - sz * ny, sz * nx - sx * nz, sx * ny - sy * nx, orient.tilt);

    // Slide out along the normal until the shape just touches the aimed point.
    const [sizeX, sizeY, sizeZ] = spec.size;
    const halfX = sizeX / 2;
    const halfY = sizeY / 2;
    const halfZ = sizeZ / 2;
    const dotX = nx * (m[0] ?? 0) + ny * (m[1] ?? 0) + nz * (m[2] ?? 0);
    const dotY = nx * (m[3] ?? 0) + ny * (m[4] ?? 0) + nz * (m[5] ?? 0);
    const dotZ = nx * (m[6] ?? 0) + ny * (m[7] ?? 0) + nz * (m[8] ?? 0);
    const out = spec.round
      ? halfY * Math.abs(dotY) + halfX * Math.sqrt(Math.max(0, 1 - dotY * dotY))
      : halfX * Math.abs(dotX) + halfY * Math.abs(dotY) + halfZ * Math.abs(dotZ);
    const lift = out + CONTACT_GAP;
    plan.x = aim.x + nx * lift;
    plan.y = aim.y + ny * lift;
    plan.z = aim.z + nz * lift;

    quatFromMat(m, this.quat);
    plan.qx = this.quat.x;
    plan.qy = this.quat.y;
    plan.qz = this.quat.z;
    plan.qw = this.quat.w;
    plan.yaw = 0;

    plan.block = this.roomFor(spec, plan, player);
    plan.valid = plan.block === "none";
    return plan;
  }

  /** Whether the shape at `plan` is clear of everything, and what is in the way if not. */
  private roomFor(spec: PieceSpec, plan: PlacementPlan, player: PlacementPlayer): PlacementBlock {
    const points = this.pointsOf(spec);
    const m = this.axes;
    const reach = Math.hypot(spec.size[0], spec.size[1], spec.size[2]) / 2;
    this.world.treesNear(plan.x, plan.z, reach + SEARCH_MARGIN, this.trees);
    this.world.propsNear(plan.x, plan.z, reach + SEARCH_MARGIN, this.props);
    this.field.near(plan.x, plan.y, plan.z, reach, this.nearby);

    let block: PlacementBlock = "none";
    for (let i = 0; i < points.length; i += 3) {
      const lx = points[i] ?? 0;
      const ly = points[i + 1] ?? 0;
      const lz = points[i + 2] ?? 0;
      const x = plan.x + (m[0] ?? 0) * lx + (m[3] ?? 0) * ly + (m[6] ?? 0) * lz;
      const y = plan.y + (m[1] ?? 0) * lx + (m[4] ?? 0) * ly + (m[7] ?? 0) * lz;
      const z = plan.z + (m[2] ?? 0) * lx + (m[5] ?? 0) * ly + (m[8] ?? 0) * lz;

      if (this.world.isSolid(Math.floor(x / VOXEL_SIZE), Math.floor(y / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE))) {
        return "buried";
      }
      if (block === "none" && this.occupied(x, y, z)) block = "occupied";
      if (
        block === "none" &&
        Math.abs(x - player.x) < player.halfWidth &&
        Math.abs(z - player.z) < player.halfWidth &&
        y > player.y &&
        y < player.y + WALK_HEIGHT
      ) {
        block = "player";
      }
    }
    return block;
  }

  /** Whether a trunk, a prop or another piece is at the point. */
  private occupied(x: number, y: number, z: number): boolean {
    for (const tree of this.trees) {
      if (tree.trunkTopMeters <= 0 || y < tree.y || y > tree.y + tree.trunkTopMeters) continue;
      const radius = tree.trunkRadiusMeters + TRUNK_SLACK;
      if ((tree.x - x) ** 2 + (tree.z - z) ** 2 < radius * radius) return true;
    }
    for (const prop of this.props) {
      // Zero height is a prop you can walk through (graves).
      if (prop.height <= 0 || y < prop.y || y > prop.y + prop.height) continue;
      if ((prop.x - x) ** 2 + (prop.z - z) ** 2 < prop.radius * prop.radius) return true;
    }
    for (const piece of this.nearby) {
      if (solidContains(piece.solid, x, y, z)) return true;
    }
    return false;
  }

  /** Points through the volume of the shape in its own frame, x y z each, a cell apart and a half cell in from every face. */
  private pointsOf(spec: PieceSpec): Float64Array {
    const known = this.samples.get(spec);
    if (known !== undefined) return known;
    const [sizeX, sizeY, sizeZ] = spec.size;
    const countX = Math.max(1, Math.floor(sizeX / SAMPLE_SPACING));
    const countY = Math.max(1, Math.floor(sizeY / SAMPLE_SPACING));
    const countZ = Math.max(1, Math.floor(sizeZ / SAMPLE_SPACING));
    const list: number[] = [];
    for (let i = 0; i < countX; i++) {
      for (let j = 0; j < countY; j++) {
        for (let k = 0; k < countZ; k++) {
          const x = ((i + 0.5) / countX - 0.5) * sizeX;
          const y = ((j + 0.5) / countY - 0.5) * sizeY;
          const z = ((k + 0.5) / countZ - 0.5) * sizeZ;
          // Keep a cylinder's points inside a slightly smaller circle, so its curved side is not "in" what it touches.
          if (spec.round && Math.hypot(x, z) > sizeX / 2 - 0.04) continue;
          list.push(x, y, z);
        }
      }
    }
    // Never empty: a piece smaller than a cell is still its middle.
    if (list.length === 0) list.push(0, 0, 0);
    const points = Float64Array.from(list);
    this.samples.set(spec, points);
    return points;
  }
}
