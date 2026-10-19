/**
 * Packs a chunk coordinate into a single number so the loaded/desired sets
 * can be keyed without allocating.
 *
 * The C++ keys its chunk table on `glm::ivec3` with a custom hash
 * (ChunkCoordHash in Chunk.hpp). The direct JS equivalent would be a string
 * key like `${x},${y},${z}`, which allocates a string per lookup -- and
 * streaming does one lookup per desired chunk per boundary crossing, roughly
 * 450 of them at radius 6, in the same frame that is already paying for
 * generation and meshing. A packed number key is free by comparison and
 * `Map<number, T>` lookups hit the engine's fast path.
 *
 * JS integers are exact below 2^53, so the three fields are budgeted to fit
 * in 48 bits with room to spare:
 *
 *   x: 20 bits signed, biased  -> +-524,288 chunks (+-1.6 million metres)
 *   z: 20 bits signed, biased  -> same
 *   y:  8 bits signed, biased  -> -128..127 chunks (-409..409 metres)
 *
 * Y gets the small field deliberately: the generator's vertical range is a
 * fixed band (see VERTICAL_CHUNK_MIN/MAX in world.ts) and will stay bounded
 * even once caves exist, whereas X/Z are genuinely unbounded.
 */

const XZ_BITS = 20;
const XZ_RANGE = 1 << XZ_BITS;
const XZ_BIAS = XZ_RANGE >> 1;

const Y_BITS = 8;
const Y_RANGE = 1 << Y_BITS;
const Y_BIAS = Y_RANGE >> 1;

/** A chunk coordinate packed by {@link chunkKey}. */
export type ChunkKey = number;

export function chunkKey(cx: number, cy: number, cz: number): ChunkKey {
  // Multiplication rather than `<<`: bitwise operators in JS truncate to 32
  // bits, which would silently fold x and z on top of each other.
  return ((cx + XZ_BIAS) * XZ_RANGE + (cz + XZ_BIAS)) * Y_RANGE + (cy + Y_BIAS);
}

export function keyX(key: ChunkKey): number {
  return Math.floor(key / (XZ_RANGE * Y_RANGE)) - XZ_BIAS;
}

export function keyY(key: ChunkKey): number {
  return (key % Y_RANGE) - Y_BIAS;
}

export function keyZ(key: ChunkKey): number {
  return (Math.floor(key / Y_RANGE) % XZ_RANGE) - XZ_BIAS;
}
