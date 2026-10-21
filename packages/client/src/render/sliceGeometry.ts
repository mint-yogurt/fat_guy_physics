import { BufferAttribute, BufferGeometry } from "three/webgpu";

/**
 * Cuts a mesh in two along a horizontal plane.
 *
 * This is the whole of the "procedural destruction" on trees. A chup picks a
 * height, and every triangle of the trunk is kept, dropped, or split in two
 * at that height -- so a trunk can be cut anywhere along its length rather
 * than only at seams an artist placed. The dead tree's branches are part of
 * its trunk mesh and go through the same path without knowing about it.
 *
 * Deliberately not a CSG boolean. The cut face is capped simply: every
 * triangle the plane crosses leaves one segment of the cut outline, the
 * segments are joined into outlines by their shared ends (a branching mesh
 * cut through a branch gives several), and each outline is fanned from its
 * centre. That is exact for a convex cross-section, which a trunk is, and
 * close enough for the odd shape where a branch meets it. Caps are mapped
 * flat, centred on their outline and stretched to fill it, so a stump
 * texture's rings sit in the middle of the cut.
 *
 * Cap triangles are geometry group 1 (material index 1), the original
 * surface group 0, so a mesh draws them with `[bark, stump]` materials. A
 * cap already on the input stays a cap on whichever side it falls.
 *
 * Both halves come back from one pass, because felling needs both: the
 * stump stays standing and the piece above becomes a rigid body.
 */

/** Attributes carried across the cut, in the order they are packed. */
const ATTRIBUTES = [
  { name: "position", size: 3 },
  { name: "normal", size: 3 },
  { name: "uv", size: 2 },
] as const;

const STRIDE = ATTRIBUTES.reduce((total, attribute) => total + attribute.size, 0);
/** Where Y sits inside a packed vertex: position is first. */
const Y_OFFSET = 1;

/** Geometry group / material index of the cut faces. */
export const CAP_GROUP = 1;

export interface SlicedGeometry {
  /** The part below the plane, or undefined if nothing was. */
  below: BufferGeometry | undefined;
  above: BufferGeometry | undefined;
}

/** Packs the attributes this cares about into one interleaved array. */
function pack(geometry: BufferGeometry): Float32Array | undefined {
  const position = geometry.getAttribute("position");
  if (position === undefined) return undefined;
  const count = position.count;
  const packed = new Float32Array(count * STRIDE);

  let offset = 0;
  for (const attribute of ATTRIBUTES) {
    const source = geometry.getAttribute(attribute.name);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < attribute.size; c++) {
        // A missing attribute packs as zeroes rather than failing: a mesh
        // without UVs still slices, it just samples one texel.
        packed[i * STRIDE + offset + c] = source === undefined ? 0 : source.array[i * source.itemSize + c] ?? 0;
      }
    }
    offset += attribute.size;
  }
  return packed;
}

/** Which triangles of `geometry` are caps, from its groups. */
function capTriangles(geometry: BufferGeometry, triangles: number): Uint8Array {
  const caps = new Uint8Array(triangles);
  for (const group of geometry.groups) {
    if (group.materialIndex !== CAP_GROUP) continue;
    const start = Math.floor(group.start / 3);
    const end = Math.min(triangles, Math.floor((group.start + group.count) / 3));
    caps.fill(1, start, end);
  }
  return caps;
}

function unpack(sides: number[], caps: number[]): BufferGeometry | undefined {
  const values = sides.concat(caps);
  if (values.length === 0) return undefined;
  const count = values.length / STRIDE;
  const geometry = new BufferGeometry();
  geometry.addGroup(0, sides.length / STRIDE, 0);
  if (caps.length > 0) geometry.addGroup(sides.length / STRIDE, caps.length / STRIDE, CAP_GROUP);

  let offset = 0;
  for (const attribute of ATTRIBUTES) {
    const data = new Float32Array(count * attribute.size);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < attribute.size; c++) {
        data[i * attribute.size + c] = values[i * STRIDE + offset + c] ?? 0;
      }
    }
    geometry.setAttribute(attribute.name, new BufferAttribute(data, attribute.size));
    offset += attribute.size;
  }
  return geometry;
}

function emit(out: number[], packed: Float32Array, index: number): void {
  for (let c = 0; c < STRIDE; c++) out.push(packed[index * STRIDE + c] ?? 0);
}

/** Pushes the point `t` of the way from vertex `a` to vertex `b`. */
function emitLerp(out: number[], packed: Float32Array, a: number, b: number, t: number): void {
  for (let c = 0; c < STRIDE; c++) {
    const va = packed[a * STRIDE + c] ?? 0;
    const vb = packed[b * STRIDE + c] ?? 0;
    out.push(va + (vb - va) * t);
  }
}

/**
 * Clips one triangle to the half-space on one side of the plane and fans
 * whatever is left into triangles.
 *
 * `sign` is +1 to keep what is below the plane and -1 to keep what is
 * above, so one function serves both halves. A clipped triangle leaves a
 * quad, which is the only reason the fan loop exists.
 */
function clipTriangle(
  out: number[],
  packed: Float32Array,
  corners: readonly [number, number, number],
  planeY: number,
  sign: number,
): void {
  const kept: { index: number; other: number; t: number }[] = [];

  for (let edge = 0; edge < 3; edge++) {
    const a = corners[edge] ?? 0;
    const b = corners[(edge + 1) % 3] ?? 0;
    const da = sign * (planeY - (packed[a * STRIDE + Y_OFFSET] ?? 0));
    const db = sign * (planeY - (packed[b * STRIDE + Y_OFFSET] ?? 0));

    if (da >= 0) kept.push({ index: a, other: a, t: 0 });
    // Strictly opposite signs: an edge that only touches the plane has
    // already contributed its endpoint and must not add a duplicate.
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      kept.push({ index: a, other: b, t: da / (da - db) });
    }
  }

  if (kept.length < 3) return;
  const first = kept[0];
  if (first === undefined) return;

  for (let i = 1; i + 1 < kept.length; i++) {
    for (const vertex of [first, kept[i], kept[i + 1]]) {
      if (vertex === undefined) continue;
      if (vertex.t === 0) emit(out, packed, vertex.index);
      else emitLerp(out, packed, vertex.index, vertex.other, vertex.t);
    }
  }
}

/**
 * Splits `geometry` at `planeY`, in the geometry's own coordinates.
 *
 * The geometry must be non-indexed; {@link BufferGeometry.toNonIndexed} is
 * applied once at asset load, not here, because a tree is sliced far more
 * often than it is loaded.
 */
export function sliceAtY(geometry: BufferGeometry, planeY: number): SlicedGeometry {
  const packed = pack(geometry);
  if (packed === undefined) return { below: undefined, above: undefined };

  const below: number[] = [];
  const above: number[] = [];
  const belowCaps: number[] = [];
  const aboveCaps: number[] = [];
  const triangles = Math.floor(packed.length / STRIDE / 3);
  const isCap = capTriangles(geometry, triangles);
  const corners: [number, number, number] = [0, 0, 0];
  const segments: number[] = [];

  for (let t = 0; t < triangles; t++) {
    corners[0] = t * 3;
    corners[1] = t * 3 + 1;
    corners[2] = t * 3 + 2;
    const cap = isCap[t] === 1;
    clipTriangle(cap ? belowCaps : below, packed, corners, planeY, 1);
    clipTriangle(cap ? aboveCaps : above, packed, corners, planeY, -1);
    if (!cap) crossing(segments, packed, corners, planeY);
  }

  if (below.length > 0 && above.length > 0) capCut(segments, planeY, belowCaps, aboveCaps);
  return { below: unpack(below, belowCaps), above: unpack(above, aboveCaps) };
}

/**
 * Where the plane crosses a triangle, as one segment (x0, z0, x1, z1), if it
 * does. On-plane vertices count as above, so a triangle touching the plane
 * at a corner crosses it at no edges or two, never one.
 */
function crossing(
  out: number[],
  packed: Float32Array,
  corners: readonly [number, number, number],
  planeY: number,
): void {
  let found = 0;
  let x0 = 0;
  let z0 = 0;
  for (let edge = 0; edge < 3; edge++) {
    const a = (corners[edge] ?? 0) * STRIDE;
    const b = (corners[(edge + 1) % 3] ?? 0) * STRIDE;
    const ya = packed[a + Y_OFFSET] ?? 0;
    const yb = packed[b + Y_OFFSET] ?? 0;
    if (ya >= planeY === yb >= planeY) continue;
    const t = (planeY - ya) / (yb - ya);
    const x = (packed[a] ?? 0) + ((packed[b] ?? 0) - (packed[a] ?? 0)) * t;
    const z = (packed[a + 2] ?? 0) + ((packed[b + 2] ?? 0) - (packed[a + 2] ?? 0)) * t;
    if (found === 0) {
      x0 = x;
      z0 = z;
    } else {
      out.push(x0, z0, x, z);
    }
    found++;
  }
}

/** Weld tolerance for joining segment ends, in geometry units. */
const WELD = 1e-4;

interface Outline {
  x: number;
  z: number;
  n: number;
  /** Furthest point of the outline from its centre. */
  r: number;
}

/**
 * Fans each outline of the cut from its centre: facing up on the part below
 * the plane, down on the part above.
 */
function capCut(segments: number[], planeY: number, belowOut: number[], aboveOut: number[]): void {
  const count = segments.length / 4;
  if (count === 0) return;
  const seg = (i: number): number => segments[i] ?? 0;

  // Union-find over welded segment ends: each set is one outline.
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const id = (x: number, z: number): number => {
    const key = `${Math.round(x / WELD)},${Math.round(z / WELD)}`;
    let value = ids.get(key);
    if (value === undefined) {
      value = parent.length;
      parent.push(value);
      ids.set(key, value);
    }
    return value;
  };
  const owner = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const a = find(id(seg(i * 4), seg(i * 4 + 1)));
    const b = find(id(seg(i * 4 + 2), seg(i * 4 + 3)));
    if (a !== b) parent[a] = b;
    owner[i] = b;
  }

  // Centre and reach of each outline.
  const outlines = new Map<number, Outline>();
  const outlineOf = (i: number): Outline => {
    const root = find(owner[i] ?? 0);
    let outline = outlines.get(root);
    if (outline === undefined) {
      outline = { x: 0, z: 0, n: 0, r: 0 };
      outlines.set(root, outline);
    }
    return outline;
  };
  for (let i = 0; i < count; i++) {
    const c = outlineOf(i);
    c.x += seg(i * 4) + seg(i * 4 + 2);
    c.z += seg(i * 4 + 1) + seg(i * 4 + 3);
    c.n += 2;
  }
  for (const c of outlines.values()) {
    c.x /= c.n;
    c.z /= c.n;
  }
  for (let i = 0; i < count; i++) {
    const c = outlineOf(i);
    c.r = Math.max(
      c.r,
      Math.hypot(seg(i * 4) - c.x, seg(i * 4 + 1) - c.z),
      Math.hypot(seg(i * 4 + 2) - c.x, seg(i * 4 + 3) - c.z),
    );
  }

  const vertex = (out: number[], c: Outline, x: number, z: number, ny: number): void => {
    const span = Math.max(1e-6, c.r * 2);
    out.push(x, planeY, z, 0, ny, 0, 0.5 + (x - c.x) / span, 0.5 + (z - c.z) / span);
  };

  for (let i = 0; i < count; i++) {
    const c = outlineOf(i);
    let ax = seg(i * 4);
    let az = seg(i * 4 + 1);
    let bx = seg(i * 4 + 2);
    let bz = seg(i * 4 + 3);
    // Wound so (centre, a, b) faces +Y: the cross product's y is
    // (az - cz)(bx - cx) - (ax - cx)(bz - cz).
    if ((az - c.z) * (bx - c.x) - (ax - c.x) * (bz - c.z) < 0) {
      [ax, az, bx, bz] = [bx, bz, ax, az];
    }
    vertex(belowOut, c, c.x, c.z, 1);
    vertex(belowOut, c, ax, az, 1);
    vertex(belowOut, c, bx, bz, 1);
    vertex(aboveOut, c, c.x, c.z, -1);
    vertex(aboveOut, c, bx, bz, -1);
    vertex(aboveOut, c, ax, az, -1);
  }
}
