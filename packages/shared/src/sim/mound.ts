/**
 * The snowbank, as something to stand on.
 *
 * The drift mesh is a low, irregular heap: a ring of base points on the ground
 * and a few higher ones inside. Its collision is that same mesh read as a
 * height field: a point is inside when it is under the surface of the triangle
 * above it. So it is walked up and over exactly as it is drawn, with no
 * second, rougher shape to get stuck on, and it costs a bounding-circle test
 * until the player is actually on it.
 *
 * `SHAPE_*` is snowbank.glb as the client plants it (stood on its feet, centred
 * on its bounding box, at scale 1): x, z and height in metres of the unscaled
 * mesh. Regenerate it if the mesh is re-authored.
 */

const SHAPE_VERTICES: readonly number[] = [
  -3.398, -0.296, 0, -0.947, 0.675, 0.932, -2.032, 1.381, 0, -2.087, -1.898, 0, 2.705, 2.452, 0, 1.217, 1.419, 1.559,
  1.343, 3.436, 0, 0.574, -2.452, 0, 0.511, -0.006, 1.414, 1.217, -1.381, 0, -1.192, -3.436, 0, -0.649, -1.028, 1.339,
  -0.838, 3.121, 0, 1.847, 0.724, 1.633, 3.398, -1.053, 0,
];

const SHAPE_TRIANGLES: readonly number[] = [
  0, 1, 2, 3, 1, 0, 4, 5, 6, 7, 8, 9, 10, 11, 7, 3, 11, 10, 12, 2, 1, 9, 13, 14, 14, 13, 4, 5, 4, 13, 8, 13, 9, 8, 7,
  11, 1, 3, 11, 11, 1, 8, 13, 8, 5, 6, 5, 12, 1, 5, 12, 8, 1, 5,
];

/** Farthest any point of the unscaled drift is from its centre. */
const SHAPE_REACH = 3.5;
/** How far below its base a mound is solid: a heap on a slope is not hollow underneath. */
const SKIRT = 2;

/** A placed mound, with its turn worked out once. */
export interface Mound {
  x: number;
  /** Ground level at its centre: where the mesh's base sits. */
  y: number;
  z: number;
  scale: number;
  cos: number;
  sin: number;
}

/** How far from its centre a mound of this scale can be solid. */
export function moundReach(scale: number): number {
  return SHAPE_REACH * scale;
}

/**
 * Height of the mound's surface above `mound.y` at (x, z), in metres; -1 where
 * there is none.
 */
export function moundHeight(mound: Mound, x: number, z: number): number {
  const dx = x - mound.x;
  const dz = z - mound.z;
  const reach = SHAPE_REACH * mound.scale;
  if (dx * dx + dz * dz > reach * reach) return -1;
  // World offset back into the mesh's own frame: undo the yaw, then the scale.
  const lx = (dx * mound.cos - dz * mound.sin) / mound.scale;
  const lz = (dx * mound.sin + dz * mound.cos) / mound.scale;
  let best = -1;
  for (let t = 0; t < SHAPE_TRIANGLES.length; t += 3) {
    const a = (SHAPE_TRIANGLES[t] ?? 0) * 3;
    const b = (SHAPE_TRIANGLES[t + 1] ?? 0) * 3;
    const c = (SHAPE_TRIANGLES[t + 2] ?? 0) * 3;
    const ax = SHAPE_VERTICES[a] ?? 0;
    const az = SHAPE_VERTICES[a + 1] ?? 0;
    const bx = SHAPE_VERTICES[b] ?? 0;
    const bz = SHAPE_VERTICES[b + 1] ?? 0;
    const cx = SHAPE_VERTICES[c] ?? 0;
    const cz = SHAPE_VERTICES[c + 1] ?? 0;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const u = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / det;
    const v = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / det;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    const h = u * (SHAPE_VERTICES[a + 2] ?? 0) + v * (SHAPE_VERTICES[b + 2] ?? 0) + w * (SHAPE_VERTICES[c + 2] ?? 0);
    if (h > best) best = h;
  }
  return best < 0 ? -1 : best * mound.scale;
}

/** The mounds near whoever is asking: pooled, rebuilt by the owner a frame at a time. */
export class MoundList {
  readonly items: Mound[] = [];
  private used = 0;

  clear(): void {
    this.used = 0;
  }

  get count(): number {
    return this.used;
  }

  /** Adds one, unless one is already there. */
  add(x: number, y: number, z: number, scale: number, yaw: number): void {
    for (let i = 0; i < this.used; i++) {
      const have = this.items[i];
      if (have !== undefined && have.x === x && have.z === z) return;
    }
    let mound = this.items[this.used];
    if (mound === undefined) {
      mound = { x, y, z, scale, cos: 1, sin: 0 };
      this.items.push(mound);
    }
    mound.x = x;
    mound.y = y;
    mound.z = z;
    mound.scale = scale;
    mound.cos = Math.cos(yaw);
    mound.sin = Math.sin(yaw);
    this.used++;
  }

  /** Is the point (a voxel's centre) inside any of them. */
  contains(px: number, py: number, pz: number): boolean {
    for (let i = 0; i < this.used; i++) {
      const mound = this.items[i];
      if (mound === undefined) continue;
      const rise = py - mound.y;
      if (rise < -SKIRT) continue;
      const height = moundHeight(mound, px, pz);
      if (height >= 0 && rise < height) return true;
    }
    return false;
  }
}
