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
 * Deliberately not a CSG boolean and deliberately not capped: the cut face
 * is left open. Capping means triangulating the cut outline, which for a
 * branching mesh is several disjoint loops and the point at which this stops
 * being eighty lines of code. An open trunk reads fine at the game's
 * fidelity, and the trunk material draws both faces so the far wall shows
 * through the cut rather than leaving a hole.
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

function unpack(values: number[]): BufferGeometry | undefined {
  if (values.length === 0) return undefined;
  const count = values.length / STRIDE;
  const geometry = new BufferGeometry();

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
  const triangles = Math.floor(packed.length / STRIDE / 3);
  const corners: [number, number, number] = [0, 0, 0];

  for (let t = 0; t < triangles; t++) {
    corners[0] = t * 3;
    corners[1] = t * 3 + 1;
    corners[2] = t * 3 + 2;
    clipTriangle(below, packed, corners, planeY, 1);
    clipTriangle(above, packed, corners, planeY, -1);
  }

  return { below: unpack(below), above: unpack(above) };
}
