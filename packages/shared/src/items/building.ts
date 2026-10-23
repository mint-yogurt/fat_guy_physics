import { createMat3, matFromQuat, type Quat } from "../sim/rotation.ts";
import { solidContains, type OrientedSolid } from "../sim/sceneQuery.ts";
import { createRail, railOfPiece, type Rail, type RailSource } from "../sim/climb.ts";
import { ITEM_NAMES, ItemType, itemTypeFromName } from "./inventory.ts";

/**
 * Building: pieces put down in the world and left there, to be stood on,
 * climbed, leaned on and built up into structures. A ladder, a log, a sheet of
 * plywood. This file is the data and the geometry; where one goes is
 * buildPlan.ts, and the rigid bodies and meshes are the client's
 * (physics/buildSystem.ts).
 *
 * The one idea: **nothing is attached at authored points.** A piece is a box
 * or a cylinder with a pose, and anything that touches anything else is joined
 * by that touching, found from the shapes themselves. So a new piece is a row
 * in {@link PIECE_SPECS} and a mesh, and it already stacks on, leans against
 * and hangs off everything else, including pieces that do not exist yet.
 *
 * Two states, which are the whole of "structure" for now:
 *  - `fixed`: gripped to what it was put against (a ladder says so with
 *    `grips`). It stays up for as long as something it touches does, found by
 *    {@link BuildField.looseOnes}: dig the wall out or chop the tree it hangs
 *    on and it comes away.
 *  - loose: a rigid body that rests where physics leaves it. A plank put on
 *    two logs is a plank on two logs, and anything under it going away drops it.
 * `joints` is where a fastener (duct tape, nails) will go: a weld between two
 * pieces that makes a loose one part of a fixed structure. Nothing makes one yet.
 */

/** Which of a piece's own axes: 0 is X, 1 is Y, 2 is Z. */
export type AxisIndex = 0 | 1 | 2;

export interface PieceSpec {
  readonly item: ItemType;
  /** A cylinder along its own Y (radius `size[0] / 2`, length `size[1]`) rather than a box. */
  readonly round: boolean;
  /** Full size along the piece's own X, Y, Z, metres. This is both its collision shape and what is drawn. */
  readonly size: readonly [number, number, number];
  /**
   * The face that goes against what the piece is put on, as a signed axis: a
   * plank's underside is (1, -1). For a cylinder it is the side it lies on.
   */
  readonly contactAxis: AxisIndex;
  readonly contactSign: 1 | -1;
  /** The long way: which of its own axes runs along the surface at no spin (up a wall, ahead on a floor). */
  readonly along: AxisIndex;
  /** Grips whatever it is put against, rather than resting there. */
  readonly grips: boolean;
  /** Solid to a walking player. A ladder is not: you walk into it to take hold. */
  readonly walkable: boolean;
  /** Can be climbed along its `along` axis. */
  readonly climbable: boolean;
  /** kg per cubic metre, for its rigid body. */
  readonly density: number;
}

/** Thinner than a voxel and the player's feet would fall through it (collision samples the voxel grid). */
export const MIN_SOLID_THICKNESS = 0.1;

/**
 * Every building piece, by item. Sizes are the authored models' (items/ladder
 * is 3m long), except that a walkable piece is never thinner than
 * {@link MIN_SOLID_THICKNESS}: a sheet of plywood is a chunky 10cm slab, which
 * is also what suits the game's look.
 */
export const PIECE_SPECS: Partial<Record<ItemType, PieceSpec>> = {
  [ItemType.Ladder]: {
    item: ItemType.Ladder,
    round: false,
    size: [0.08, 0.63, 3],
    contactAxis: 0,
    contactSign: -1,
    along: 2,
    grips: true,
    walkable: false,
    climbable: true,
    density: 250,
  },
  [ItemType.Log]: {
    item: ItemType.Log,
    round: true,
    size: [0.6, 0.76, 0.6],
    contactAxis: 2,
    contactSign: -1,
    along: 1,
    grips: false,
    walkable: true,
    climbable: false,
    density: 600,
  },
  [ItemType.Toobifer]: {
    item: ItemType.Toobifer,
    round: false,
    size: [MIN_SOLID_THICKNESS, MIN_SOLID_THICKNESS, 1],
    contactAxis: 1,
    contactSign: -1,
    along: 2,
    grips: false,
    walkable: true,
    climbable: false,
    density: 600,
  },
  [ItemType.Plywood]: {
    item: ItemType.Plywood,
    round: false,
    size: [1.2, MIN_SOLID_THICKNESS, 2.44],
    contactAxis: 1,
    contactSign: -1,
    along: 2,
    grips: false,
    walkable: true,
    climbable: false,
    density: 550,
  },
  [ItemType.Wheel]: {
    item: ItemType.Wheel,
    round: true,
    size: [0.6, 0.213, 0.6],
    contactAxis: 1,
    contactSign: -1,
    along: 2,
    grips: false,
    walkable: true,
    climbable: false,
    density: 450,
  },
};

/** The building rules of an item, or undefined if it is not a piece. */
export function pieceSpecOf(type: ItemType | undefined): PieceSpec | undefined {
  return type === undefined ? undefined : PIECE_SPECS[type];
}

/** Kilograms: the volume of its shape times its density. */
export function pieceMass(spec: PieceSpec): number {
  const [sx, sy, sz] = spec.size;
  const volume = spec.round ? Math.PI * (sx / 2) * (sz / 2) * sy : sx * sy * sz;
  return volume * spec.density;
}

/** A weld to another piece (or to the world, as -1). Reserved for fasteners; nothing creates one yet. */
export interface PieceJoint {
  readonly other: number;
  /** Newtons it holds before it lets go. */
  readonly strength: number;
}

export interface BuildPiece {
  readonly id: number;
  readonly spec: PieceSpec;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Gripped where it is (see the top of the file); a loose piece is a rigid body. */
  fixed: boolean;
  /** At rest. Only a settled walkable piece is solid to the player, as with felled logs. */
  settled: boolean;
  readonly joints: PieceJoint[];
  /** Its shape in the world, kept in step with the pose by {@link BuildField.setPose}. */
  readonly solid: OrientedSolid;
}

/** What a ray found. */
export interface BuildHit {
  piece: BuildPiece | undefined;
  distance: number;
  /** The surface it hit and the way that surface faces. */
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export function createBuildHit(): BuildHit {
  return { piece: undefined, distance: Infinity, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

/** One piece as it is saved. */
export interface PieceSave {
  readonly item: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  readonly fixed: boolean;
}

/** The slice of the world that decides whether something fixed is still held up. */
export interface SupportWorld {
  /** Solid terrain at a voxel. */
  isSolid(vx: number, vy: number, vz: number): boolean;
  /** Trunks and props: whether the point is inside one. */
  isInsideTreeOrProp(x: number, y: number, z: number): boolean;
}

/** How far past a face a support is looked for, metres. */
const SUPPORT_REACH = 0.06;
/** Spacing of the points looked at over each face, metres. */
const SUPPORT_SPACING = 0.25;
const VOXEL = 0.1;

const rayNormal = { x: 0, y: 1, z: 0 };

export class BuildField implements RailSource {
  readonly pieces: BuildPiece[] = [];
  /** Pieces taken out since the build system last looked, so it can let go of their bodies and meshes. */
  readonly removed: BuildPiece[] = [];
  /** Bumped when the set of pieces, or where one rests, changes: what a save compares. */
  version = 0;
  private nextId = 1;
  private readonly scratch = createMat3();
  /** The rail being weighed in `findRail`, which a walking player asks for every step: kept, not made each time. */
  private readonly candidate = createRail();

  place(item: ItemType, x: number, y: number, z: number, q: Quat, fixed: boolean): BuildPiece | undefined {
    const spec = pieceSpecOf(item);
    if (spec === undefined) return undefined;
    const [sx, sy, sz] = spec.size;
    const piece: BuildPiece = {
      id: this.nextId++,
      spec,
      x,
      y,
      z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      fixed,
      settled: false,
      joints: [],
      solid: {
        round: spec.round,
        x,
        y,
        z,
        halfX: sx / 2,
        halfY: sy / 2,
        halfZ: sz / 2,
        reach: spec.round ? Math.hypot(sx / 2, sy / 2) : Math.hypot(sx / 2, sy / 2, sz / 2),
        axes: createMat3(),
      },
    };
    this.setPose(piece, x, y, z, q.x, q.y, q.z, q.w);
    this.pieces.push(piece);
    this.version++;
    return piece;
  }

  remove(piece: BuildPiece): void {
    const at = this.pieces.indexOf(piece);
    if (at < 0) return;
    this.pieces.splice(at, 1);
    this.removed.push(piece);
    this.version++;
  }

  get(id: number): BuildPiece | undefined {
    return this.pieces.find((piece) => piece.id === id);
  }

  /** Moves a piece (a body settling, a save loading). */
  setPose(piece: BuildPiece, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    piece.x = x;
    piece.y = y;
    piece.z = z;
    piece.qx = qx;
    piece.qy = qy;
    piece.qz = qz;
    piece.qw = qw;
    piece.solid.x = x;
    piece.solid.y = y;
    piece.solid.z = z;
    matFromQuat(qx, qy, qz, qw, piece.solid.axes);
  }

  /** Pieces whose centre is within `radius` of a point, into `out`. */
  near(x: number, y: number, z: number, radius: number, out: BuildPiece[]): BuildPiece[] {
    out.length = 0;
    for (const piece of this.pieces) {
      const reach = radius + piece.solid.reach;
      const dx = piece.x - x;
      const dy = piece.y - y;
      const dz = piece.z - z;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) out.push(piece);
    }
    return out;
  }

  /** The first piece that has the point inside it (grown by `margin`), other than `except`. */
  containing(x: number, y: number, z: number, margin = 0, except?: BuildPiece): BuildPiece | undefined {
    for (const piece of this.pieces) {
      if (piece !== except && solidContains(piece.solid, x, y, z, margin)) return piece;
    }
    return undefined;
  }

  /** The nearest piece along a ray, within `maxDistance`, into `out`. */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: BuildHit,
  ): BuildHit {
    out.piece = undefined;
    out.distance = Infinity;
    let best = maxDistance;
    for (const piece of this.pieces) {
      const t = raySolid(piece.solid, ox, oy, oz, dx, dy, dz, best);
      if (t < 0 || t >= best) continue;
      best = t;
      out.piece = piece;
      out.distance = t;
      out.nx = rayNormal.x;
      out.ny = rayNormal.y;
      out.nz = rayNormal.z;
    }
    if (out.piece !== undefined) {
      out.x = ox + dx * best;
      out.y = oy + dy * best;
      out.z = oz + dz * best;
    }
    return out;
  }

  /**
   * Fixed pieces that nothing holds up any more. A fixed piece is held up if
   * the ground, a tree or a prop touches it, or a fixed piece that is itself
   * held up does; so a ladder on a ladder on a cliff stays, and both come away
   * together if the cliff does. Cheap enough to ask every second or after any
   * edit nearby. Returns the loose ones in `out`.
   */
  looseOnes(world: SupportWorld, out: BuildPiece[]): BuildPiece[] {
    out.length = 0;
    const fixed = this.pieces.filter((piece) => piece.fixed);
    if (fixed.length === 0) return out;
    const held = new Set<BuildPiece>();
    const touching = new Map<BuildPiece, BuildPiece[]>();
    for (const piece of fixed) {
      let grounded = false;
      const neighbours: BuildPiece[] = [];
      // Only pieces near enough to touch are worth asking about.
      const close = this.pieces.filter((other) => {
        if (other === piece) return false;
        const reach = piece.solid.reach + other.solid.reach + SUPPORT_REACH * 2;
        return Math.hypot(other.x - piece.x, other.y - piece.y, other.z - piece.z) <= reach;
      });
      forEachSupportPoint(piece, this.scratch, (x, y, z) => {
        if (
          world.isSolid(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL)) ||
          world.isInsideTreeOrProp(x, y, z)
        ) {
          grounded = true;
        }
        for (const other of close) {
          if (!solidContains(other.solid, x, y, z)) continue;
          // A loose piece at rest is as good as the ground to lean on: physics is holding it. A fixed one is held only if it is.
          if (!other.fixed) {
            if (other.settled) grounded = true;
          } else if (!neighbours.includes(other)) {
            neighbours.push(other);
          }
        }
      });
      if (grounded) held.add(piece);
      touching.set(piece, neighbours);
    }
    // Whatever touches something held up is held up too.
    const frontier = [...held];
    while (frontier.length > 0) {
      const piece = frontier.pop();
      if (piece === undefined) break;
      for (const other of touching.get(piece) ?? []) {
        if (held.has(other)) continue;
        held.add(other);
        frontier.push(other);
      }
      // Touching is mutual, but the probe points only look outward from one side.
      for (const [other, list] of touching) {
        if (!held.has(other) && list.includes(piece)) {
          held.add(other);
          frontier.push(other);
        }
      }
    }
    for (const piece of fixed) if (!held.has(piece)) out.push(piece);
    return out;
  }

  /** Every piece as it is saved (items by name, as everywhere in the save). */
  exportAll(): PieceSave[] {
    return this.pieces.map((piece) => ({
      item: ITEM_NAMES[piece.spec.item] ?? "",
      x: piece.x,
      y: piece.y,
      z: piece.z,
      qx: piece.qx,
      qy: piece.qy,
      qz: piece.qz,
      qw: piece.qw,
      fixed: piece.fixed,
    }));
  }

  /** Puts saved pieces back (they come back at rest, to be woken if something disturbs them). */
  restore(saved: readonly PieceSave[]): void {
    for (const entry of saved) {
      const item = itemTypeFromName(entry.item);
      if (item === undefined) continue;
      const piece = this.place(item, entry.x, entry.y, entry.z, { x: entry.qx, y: entry.qy, z: entry.qz, w: entry.qw }, entry.fixed);
      if (piece !== undefined) piece.settled = true;
    }
  }

  // --- RailSource: the climbable pieces are the rails ---

  findRail(x: number, y: number, z: number, frontX: number, frontZ: number, out: Rail): boolean {
    let best = Infinity;
    const candidate = this.candidate;
    for (const piece of this.pieces) {
      if (!piece.spec.climbable) continue;
      const dx = piece.x - x;
      const dz = piece.z - z;
      const reach = piece.solid.reach + 1.5;
      if (dx * dx + dz * dz > reach * reach || Math.abs(piece.y - y) > reach) continue;
      if (!railOfPiece(piece, candidate)) continue;
      const score = candidate.grabScore(x, y, z, frontX, frontZ);
      if (score < 0 || score >= best) continue;
      best = score;
      copyRail(candidate, out);
    }
    return best < Infinity;
  }

  railOf(pieceId: number, out: Rail): boolean {
    const piece = this.get(pieceId);
    return piece !== undefined && railOfPiece(piece, out);
  }
}

function copyRail(from: Rail, to: Rail): void {
  to.pieceId = from.pieceId;
  to.px = from.px;
  to.py = from.py;
  to.pz = from.pz;
  to.dx = from.dx;
  to.dy = from.dy;
  to.dz = from.dz;
  to.length = from.length;
  to.nx = from.nx;
  to.ny = from.ny;
  to.nz = from.nz;
  to.standoff = from.standoff;
}

/**
 * Calls `visit` with points just outside every face of a piece: a grid
 * `SUPPORT_SPACING` apart, pushed `SUPPORT_REACH` out. What is there is what
 * the piece is resting or hanging on.
 */
function forEachSupportPoint(
  piece: BuildPiece,
  axes: Float64Array,
  visit: (x: number, y: number, z: number) => void,
): void {
  matFromQuat(piece.qx, piece.qy, piece.qz, piece.qw, axes);
  const half = [piece.solid.halfX, piece.solid.halfY, piece.solid.halfZ];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const a = (axis + 1) % 3;
      const b = (axis + 2) % 3;
      // A cylinder's flat faces are discs, and its side is a ring: the grid over
      // the bounding box is close enough for finding a floor or a wall under it.
      const countA = Math.max(1, Math.round(((half[a] ?? 0) * 2) / SUPPORT_SPACING));
      const countB = Math.max(1, Math.round(((half[b] ?? 0) * 2) / SUPPORT_SPACING));
      for (let i = 0; i < countA; i++) {
        for (let j = 0; j < countB; j++) {
          const local = [0, 0, 0];
          local[axis] = sign * ((half[axis] ?? 0) + SUPPORT_REACH);
          local[a] = (((i + 0.5) / countA) * 2 - 1) * (half[a] ?? 0) * 0.9;
          local[b] = (((j + 0.5) / countB) * 2 - 1) * (half[b] ?? 0) * 0.9;
          if (piece.spec.round) {
            // Keep the points on the cylinder's side or caps: a cap's grid
            // stays inside the disc, a side's off-centre points are the ones
            // along the length.
            const across = axis === 1 ? Math.hypot(local[0] ?? 0, local[2] ?? 0) : Math.abs(local[axis === 0 ? 2 : 0] ?? 0);
            if (across > piece.solid.halfX) continue;
          }
          const lx = local[0] ?? 0;
          const ly = local[1] ?? 0;
          const lz = local[2] ?? 0;
          visit(
            piece.x + (axes[0] ?? 0) * lx + (axes[3] ?? 0) * ly + (axes[6] ?? 0) * lz,
            piece.y + (axes[1] ?? 0) * lx + (axes[4] ?? 0) * ly + (axes[7] ?? 0) * lz,
            piece.z + (axes[2] ?? 0) * lx + (axes[5] ?? 0) * ly + (axes[8] ?? 0) * lz,
          );
        }
      }
    }
  }
}

/**
 * Where a ray first meets a solid, or -1. Fills the module's `rayNormal` with
 * the way the surface it met faces. The ray is taken into the solid's own
 * frame, where a box is a slab test and a cylinder is a circle and two caps.
 */
export function raySolid(
  solid: OrientedSolid,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): number {
  const a = solid.axes;
  const px = ox - solid.x;
  const py = oy - solid.y;
  const pz = oz - solid.z;
  const lox = px * (a[0] ?? 0) + py * (a[1] ?? 0) + pz * (a[2] ?? 0);
  const loy = px * (a[3] ?? 0) + py * (a[4] ?? 0) + pz * (a[5] ?? 0);
  const loz = px * (a[6] ?? 0) + py * (a[7] ?? 0) + pz * (a[8] ?? 0);
  const ldx = dx * (a[0] ?? 0) + dy * (a[1] ?? 0) + dz * (a[2] ?? 0);
  const ldy = dx * (a[3] ?? 0) + dy * (a[4] ?? 0) + dz * (a[5] ?? 0);
  const ldz = dx * (a[6] ?? 0) + dy * (a[7] ?? 0) + dz * (a[8] ?? 0);

  let bestT = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;

  if (solid.round) {
    const radius = solid.halfX;
    const qa = ldx * ldx + ldz * ldz;
    if (qa > 1e-12) {
      const qb = lox * ldx + loz * ldz;
      const qc = lox * lox + loz * loz - radius * radius;
      const disc = qb * qb - qa * qc;
      if (disc >= 0) {
        const t = (-qb - Math.sqrt(disc)) / qa;
        if (t >= 0 && Math.abs(loy + t * ldy) <= solid.halfY) {
          bestT = t;
          nx = lox + t * ldx;
          ny = 0;
          nz = loz + t * ldz;
        }
      }
    }
    if (Math.abs(ldy) > 1e-12) {
      for (const cap of [solid.halfY, -solid.halfY]) {
        const t = (cap - loy) / ldy;
        if (t < 0 || t >= bestT) continue;
        const hx = lox + t * ldx;
        const hz = loz + t * ldz;
        if (hx * hx + hz * hz > radius * radius) continue;
        bestT = t;
        nx = 0;
        ny = Math.sign(cap);
        nz = 0;
      }
    }
  } else {
    let near = -Infinity;
    let far = Infinity;
    let nearAxis = -1;
    let nearSign = 0;
    const origin = [lox, loy, loz];
    const direction = [ldx, ldy, ldz];
    const half = [solid.halfX, solid.halfY, solid.halfZ];
    for (let axis = 0; axis < 3; axis++) {
      const o = origin[axis] ?? 0;
      const d = direction[axis] ?? 0;
      const h = half[axis] ?? 0;
      if (Math.abs(d) < 1e-12) {
        if (Math.abs(o) > h) return -1;
        continue;
      }
      let t1 = (-h - o) / d;
      let t2 = (h - o) / d;
      let sign = -1;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
        sign = 1;
      }
      if (t1 > near) {
        near = t1;
        nearAxis = axis;
        nearSign = sign;
      }
      if (t2 < far) far = t2;
      if (near > far) return -1;
    }
    if (far < 0 || nearAxis < 0 || near < 0) return -1;
    bestT = near;
    nx = nearAxis === 0 ? nearSign : 0;
    ny = nearAxis === 1 ? nearSign : 0;
    nz = nearAxis === 2 ? nearSign : 0;
  }

  if (bestT > maxDistance || bestT === Infinity) return -1;
  // Local normal -> world.
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  rayNormal.x = (a[0] ?? 0) * nx + (a[3] ?? 0) * ny + (a[6] ?? 0) * nz;
  rayNormal.y = (a[1] ?? 0) * nx + (a[4] ?? 0) * ny + (a[7] ?? 0) * nz;
  rayNormal.z = (a[2] ?? 0) * nx + (a[5] ?? 0) * ny + (a[8] ?? 0) * nz;
  return bestT;
}
